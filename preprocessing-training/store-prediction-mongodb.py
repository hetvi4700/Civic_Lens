import os
import joblib
import numpy as np
import pandas as pd
import shap
from pathlib import Path
from pymongo import MongoClient, UpdateOne
from datetime import datetime, timezone

from calibration import apply_calibration, bucket

# =========================
# CONFIG
# =========================

REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = REPO_ROOT / "backend/models/catboost_model_2024_2025.pkl"
FEATURE_STATS_PATH = REPO_ROOT / "backend/models/feature_stats_full.pkl"
PREDICTION_MODEL = "catboost_2024_2025"

MONGO_URI = os.environ.get("MONGODB_URI", os.environ.get("MONGO_URI", "mongodb://localhost:27017"))
DB_NAME = os.environ.get("DB_NAME", "civic_lens")
COLLECTION = "requests_clean"

TARGET_YEAR = int(os.environ.get("TARGET_YEAR", "2026"))
REPREDICT = os.environ.get("REPREDICT", "true").lower() in ("1", "true", "yes")
PREDICT_LIMIT = int(os.environ["PREDICT_LIMIT"]) if os.environ.get("PREDICT_LIMIT") else None
DRY_RUN = os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes")
TOP_SHAP_FEATURES = 8
BULK_BATCH_SIZE = 1000

CAT_COLS = [
    "complaint_type",
    "agency",
    "borough",
    "incident_zip",
    "open_data_channel_type",
    "dow_complaint",
    "season",
]

ENRICHED_FEATURE_COLS = [
    "dow_complaint",
    "agency_workload_24h",
    "agency_workload_7d",
    "agency_median_hours",
    "agency_volume",
    "agency_complaint_median",
    "complaint_median_hours",
    "agency_zip_median",
    "agency_dow_median",
    "borough_complaint_median",
    "agency_complaint_volume",
    "agency_unresolved",
]

LOOKUP_MAP_KEYS = [
    "complaint_median_map",
    "agency_complaint_median_map",
    "agency_stats_map",
    "agency_zip_median_map",
    "agency_dow_median_map",
    "borough_complaint_median_map",
    "agency_complaint_volume_map",
]

# =========================
# LOOKUP MAPS
# =========================


def _key(*parts):
    return "|".join(str(p) for p in parts)


def load_lookup_maps(feature_stats):
    """Load all seven keyed lookup maps from feature_stats_full.pkl."""
    missing = [key for key in LOOKUP_MAP_KEYS if key not in feature_stats]
    if missing:
        raise KeyError(f"feature_stats missing lookup maps: {missing}")
    return {key: feature_stats[key] for key in LOOKUP_MAP_KEYS}


def compute_workload(collection, docs_df):
    """Rolling 24h / 7d agency workload from pre-target-year MongoDB history + batch rows.

    Matches the former parquet path: history is all records with created_date <
    TARGET_YEAR-01-01; target-year counts come only from the current prediction
    batch. Process the full unresolved batch for correct intra-year workload.
    """
    print("Computing agency workload features from MongoDB...")
    target = docs_df[["created_date", "agency", "unique_key", "_row_id"]].copy()
    target["created_date"] = pd.to_datetime(target["created_date"])

    agencies = target["agency"].dropna().astype(str).unique().tolist()
    if not agencies:
        return pd.DataFrame(
            {"agency_workload_24h": [], "agency_workload_7d": []},
            index=docs_df["_row_id"],
        )

    target_year_start = datetime(TARGET_YEAR, 1, 1)
    hist_rows = list(
        collection.find(
            {
                "agency": {"$in": agencies},
                "created_date": {"$lt": target_year_start},
            },
            {"_id": 0, "created_date": 1, "agency": 1, "unique_key": 1},
        )
    )
    hist = pd.DataFrame(hist_rows)
    if hist.empty:
        hist = pd.DataFrame(columns=["created_date", "agency", "unique_key"])
    hist["created_date"] = pd.to_datetime(hist["created_date"])

    combined = pd.concat(
        [
            hist.assign(_row_id=np.nan, _is_target=0),
            target.assign(_is_target=1),
        ],
        ignore_index=True,
    ).sort_values("created_date")

    indexed = combined.set_index("created_date")

    for window, col in [("24h", "agency_workload_24h"), ("7D", "agency_workload_7d")]:
        workload = (
            indexed.groupby("agency")["unique_key"]
            .rolling(window, closed="left")
            .count()
            .reset_index()
            .rename(columns={"unique_key": col})
            .drop_duplicates(subset=["created_date", "agency"], keep="last")
        )
        combined = combined.merge(workload, on=["created_date", "agency"], how="left")

    combined["agency_workload_24h"] = combined["agency_workload_24h"].fillna(0)
    combined["agency_workload_7d"] = combined["agency_workload_7d"].fillna(0)

    out = (
        combined[combined["_is_target"] == 1]
        .set_index("_row_id")[["agency_workload_24h", "agency_workload_7d"]]
        .sort_index()
    )
    return out


def enrich_document(doc, lookups, num_medians, workload):
    """Fill all model historical / workload features for one complaint."""
    agency = str(doc.get("agency", "Unknown"))
    borough = str(doc.get("borough", "Unknown"))
    complaint_type = str(doc.get("complaint_type", "Unknown"))
    incident_zip = str(doc.get("incident_zip", "Unknown"))
    day_of_week = doc.get("day_of_week")

    agency_stats = lookups["agency_stats_map"].get(agency, {})

    enriched = {
        "dow_complaint": (
            f"{day_of_week}_{complaint_type}"
            if day_of_week is not None
            else doc.get("dow_complaint")
        ),
        "complaint_median_hours": lookups["complaint_median_map"].get(
            complaint_type, num_medians.get("complaint_median_hours", 0)
        ),
        "agency_complaint_median": lookups["agency_complaint_median_map"].get(
            _key(agency, complaint_type), num_medians.get("agency_complaint_median", 0)
        ),
        "agency_median_hours": agency_stats.get(
            "agency_median_hours", num_medians.get("agency_median_hours", 0)
        ),
        "agency_volume": agency_stats.get(
            "agency_volume", num_medians.get("agency_volume", 0)
        ),
        "agency_unresolved": agency_stats.get(
            "agency_unresolved", num_medians.get("agency_unresolved", 0)
        ),
        "agency_zip_median": lookups["agency_zip_median_map"].get(
            _key(agency, incident_zip), num_medians.get("agency_zip_median", 0)
        ),
        "agency_dow_median": (
            lookups["agency_dow_median_map"].get(
                _key(agency, day_of_week), num_medians.get("agency_dow_median", 0)
            )
            if day_of_week is not None
            else num_medians.get("agency_dow_median", 0)
        ),
        "borough_complaint_median": lookups["borough_complaint_median_map"].get(
            _key(borough, complaint_type), num_medians.get("borough_complaint_median", 0)
        ),
        "agency_complaint_volume": lookups["agency_complaint_volume_map"].get(
            _key(agency, complaint_type), num_medians.get("agency_complaint_volume", 0)
        ),
        "agency_workload_24h": float(workload["agency_workload_24h"]),
        "agency_workload_7d": float(workload["agency_workload_7d"]),
    }
    return enriched


# =========================
# LOAD MODEL + STATS
# =========================

print(f"Loading model: {MODEL_PATH}")
model = joblib.load(MODEL_PATH)
feature_stats = joblib.load(FEATURE_STATS_PATH)

num_medians = feature_stats["num_medians"]
lookups = load_lookup_maps(feature_stats)
calibration = feature_stats.get("calibration", {})
feature_cols = model.feature_names_

print(f"Model features : {len(feature_cols)}")
print(f"Calibration    : {calibration}")
print(f"Lookup maps    : agency={len(lookups['agency_stats_map'])}  zip={len(lookups['agency_zip_median_map'])}")

# =========================
# MONGO CONNECTION
# =========================

client = MongoClient(MONGO_URI)
collection = client[DB_NAME][COLLECTION]

query = {
    "created_date": {
        "$gte": datetime(TARGET_YEAR, 1, 1),
        "$lt": datetime(TARGET_YEAR + 1, 1, 1),
    },
    "is_unresolved": 1,
}

if not REPREDICT:
    query["predicted_response_hours"] = {"$exists": False}

cursor = collection.find(query)
if PREDICT_LIMIT:
    cursor = cursor.limit(PREDICT_LIMIT)
docs = list(cursor)
print(f"Fetched {len(docs)} unresolved {TARGET_YEAR} complaints")

if len(docs) == 0:
    print("Nothing to process")
    raise SystemExit(0)

# =========================
# ENRICH FEATURES
# =========================

docs_df = pd.DataFrame(docs)
docs_df["_row_id"] = np.arange(len(docs_df))
workload_df = compute_workload(collection, docs_df)

enriched_rows = []
for i, doc in enumerate(docs):
    wl = workload_df.loc[i]
    enriched = enrich_document(doc, lookups, num_medians, wl)
    merged_doc = {**doc, **enriched}
    enriched_rows.append(merged_doc)

X = pd.DataFrame(enriched_rows)[feature_cols]

for col in CAT_COLS:
    if col in X.columns:
        X[col] = X[col].astype(str).fillna("Unknown")

num_cols = [c for c in feature_cols if c not in CAT_COLS]
for col in num_cols:
    X[col] = pd.to_numeric(X[col], errors="coerce").fillna(num_medians.get(col, 0))

print("\nEnriched feature medians (sample):")
for col in ENRICHED_FEATURE_COLS:
    if col in X.columns:
        if col in CAT_COLS:
            print(f"  {col:<28}: (categorical)")
        else:
            print(f"  {col:<28}: {pd.to_numeric(X[col], errors='coerce').median():.2f}")

# =========================
# PREDICTION
# =========================

pred_raw = np.maximum(np.expm1(model.predict(X)), 0)
pred_hours = apply_calibration(pred_raw, calibration)
pred_buckets = pd.Series(pred_hours).apply(bucket).tolist()

print(f"\nPredicted hours — median: {np.median(pred_hours):.1f}  p90: {np.percentile(pred_hours, 90):.1f}  max: {pred_hours.max():.1f}")
print("Bucket distribution:")
for b in ["Same Day", "1-3 Days", "3-7 Days", "7+ Days"]:
    n = pred_buckets.count(b)
    print(f"  {b:<12}: {n:>6,} ({n / len(pred_buckets) * 100:.1f}%)")

# =========================
# SHAP EXPLANATION
# =========================

if not DRY_RUN:
    print("\nComputing SHAP values...")
    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X)

    base_value = explainer.expected_value
    if isinstance(base_value, np.ndarray):
        base_value = float(base_value[0])
    else:
        base_value = float(base_value)
else:
    shap_values = None
    base_value = 0.0
    print("\nDRY_RUN=1 — skipping SHAP computation")


def _serialize_feature_value(val):
    if isinstance(val, (np.floating, float)):
        return float(val)
    if isinstance(val, (np.integer, int)):
        return int(val)
    return str(val)


def build_shap_payload(row_idx, shap_row):
    top_idx = np.argsort(np.abs(shap_row))[::-1][:TOP_SHAP_FEATURES]
    top_features = []

    for j in top_idx:
        shap_val = float(shap_row[j])
        feat_name = feature_cols[j]
        feat_val = _serialize_feature_value(X.iloc[row_idx, j])
        impact = "increases" if shap_val > 0 else "decreases"
        top_features.append({
            "feature": feat_name,
            "feature_value": feat_val,
            "shap_value": shap_val,
            "impact": impact,
        })

    summary_parts = [
        f"{item['feature']} ({item['feature_value']}) {item['impact']} delay"
        for item in top_features[:3]
    ]

    return {
        "base_value": base_value,
        "shap_space": "log1p_hours",
        "top_features": top_features,
        "summary": "; ".join(summary_parts),
    }


# =========================
# BUILD MONGO UPDATE OPS
# =========================

if DRY_RUN:
    print("\nDRY_RUN=1 — skipping MongoDB writes")
    compare_limit = int(os.environ.get("COMPARE_LIMIT", "200"))
    mismatches = 0
    compared = 0
    for i, doc in enumerate(docs):
        stored = doc.get("predicted_response_hours")
        if stored is None:
            continue
        if compared >= compare_limit:
            break
        compared += 1
        pct_diff = abs(float(pred_hours[i]) - float(stored)) / max(float(stored), 1e-9)
        if pct_diff > 0.01:
            mismatches += 1
            if mismatches <= 5:
                print(
                    f"  mismatch unique_key={doc.get('unique_key')} "
                    f"stored={stored:.4f} new={pred_hours[i]:.4f} diff={pct_diff*100:.2f}%"
                )
    print(f"Prediction mismatches >1%: {mismatches}/{compared} (batch size {len(docs)})")
    raise SystemExit(0)

now = datetime.now(timezone.utc)
ops = []
matched = 0
modified = 0

for i, doc in enumerate(enriched_rows):
    shap_payload = build_shap_payload(i, shap_values[i])
    enriched_fields = {col: _serialize_feature_value(X.iloc[i][col]) for col in ENRICHED_FEATURE_COLS if col in X.columns}

    ops.append(
        UpdateOne(
            {"_id": doc["_id"]},
            {
                "$set": {
                    **enriched_fields,
                    "predicted_response_hours": float(pred_hours[i]),
                    "predicted_response_hours_raw": float(pred_raw[i]),
                    "predicted_bucket": pred_buckets[i],
                    "shap_explanation": shap_payload,
                    "prediction_model": PREDICTION_MODEL,
                    "prediction_generated_at": now,
                    "prediction_scope": f"{TARGET_YEAR}_unresolved",
                }
            },
        )
    )

    if len(ops) >= BULK_BATCH_SIZE:
        result = collection.bulk_write(ops)
        matched += result.matched_count
        modified += result.modified_count
        ops = []
        print(f"  Written {modified:,} / {len(docs):,}...")

if ops:
    result = collection.bulk_write(ops)
    matched += result.matched_count
    modified += result.modified_count

print("\nDONE")
print(f"Matched : {matched}")
print(f"Modified: {modified}")
print(f"Model   : {PREDICTION_MODEL}")
