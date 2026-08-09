#!/usr/bin/env python3
"""Batch CatBoost inference for CivicLens API enrichment."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from catboost import Pool

ML_DIR = Path(__file__).resolve().parent

FEATURE_COLS = [
    "complaint_type",
    "agency",
    "borough",
    "incident_zip",
    "open_data_channel_type",
    "dow_complaint",
    "day_of_week",
    "month",
    "hour",
    "season",
    "is_holiday",
    "is_weekend",
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
    "urgency_score",
]

CAT_COLS = [
    "complaint_type",
    "agency",
    "borough",
    "incident_zip",
    "open_data_channel_type",
    "dow_complaint",
    "season",
]

FEATURE_LABELS = {
    "complaint_type": "Complaint type",
    "agency": "Agency",
    "borough": "Borough",
    "incident_zip": "Incident ZIP",
    "open_data_channel_type": "Submission channel",
    "dow_complaint": "Day-of-week × complaint",
    "day_of_week": "Day of week",
    "month": "Month / seasonality",
    "hour": "Hour of day",
    "season": "Season",
    "is_holiday": "Holiday",
    "is_weekend": "Weekend",
    "agency_workload_24h": "Recent agency workload",
    "agency_workload_7d": "Agency workload (7d)",
    "agency_median_hours": "Agency median hours",
    "agency_volume": "Agency volume",
    "agency_complaint_median": "Agency + complaint historical delay",
    "complaint_median_hours": "Complaint median hours",
    "agency_zip_median": "Agency + ZIP historical delay",
    "agency_dow_median": "Agency day-of-week median",
    "borough_complaint_median": "Borough + complaint median",
    "agency_complaint_volume": "Agency complaint volume",
    "agency_unresolved": "Agency unresolved rate",
    "urgency_score": "Urgency score",
}

MODEL_VERSION = "catboost-v1"


def default_model_path() -> Path:
    env = os.environ.get("CATBOOST_MODEL_PATH")
    if env:
        return Path(env).expanduser().resolve()
    deployed = ML_DIR.parent / "models" / "catboost_model_2024_2025.pkl"
    if deployed.exists():
        return deployed.resolve()
    local = ML_DIR / "catboost_model.pkl"
    if local.exists():
        return local.resolve()
    raise FileNotFoundError(
        "CatBoost model not found. Expected backend/models/catboost_model_2024_2025.pkl"
    )


def load_medians() -> dict:
    path = ML_DIR / "feature_medians.json"
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def delay_bucket(hours: float) -> str:
    h = max(0.0, float(hours))
    if h <= 24:
        return "Same Day"
    if h <= 72:
        return "1–3 Days"
    if h <= 168:
        return "3–7 Days"
    return "More than 1 Week"


def risk_level(hours: float) -> str:
    h = max(0.0, float(hours))
    if h < 24:
        return "Low"
    if h < 72:
        return "Medium"
    if h < 168:
        return "High"
    return "Critical"


def delay_tier(hours: float) -> str:
    h = max(0.0, float(hours))
    if h < 24:
        return "low"
    if h < 72:
        return "medium"
    return "high"


def delay_risk_score(hours: float, urgency: float) -> float:
    h = max(0.0, float(hours))
    u = max(0.0, min(1.0, float(urgency)))
    return round(min(0.99, max(0.05, (h / 168.0) * 0.45 + u * 0.35)), 4)


def pick(record: dict, *keys, default=None):
    mf = record.get("model_features") or {}
    for key in keys:
        if record.get(key) is not None:
            return record[key]
        if mf.get(key) is not None:
            return mf[key]
    return default


def build_row(record: dict, medians: dict) -> dict:
    complaint_type = str(pick(record, "complaint_type", default="Unknown") or "Unknown")
    day_of_week = int(pick(record, "day_of_week", default=medians.get("day_of_week", 0)) or 0)

    row = {
        "complaint_type": complaint_type,
        "agency": str(pick(record, "agency", default="Unknown") or "Unknown"),
        "borough": str(pick(record, "borough", default="Unknown") or "Unknown"),
        "incident_zip": str(pick(record, "incident_zip", default="Unknown") or "Unknown"),
        "open_data_channel_type": str(
            pick(record, "open_data_channel_type", default="Unknown") or "Unknown"
        ),
        "dow_complaint": f"{day_of_week}_{complaint_type}",
        "day_of_week": day_of_week,
        "month": int(pick(record, "month", default=medians.get("month", 6)) or 6),
        "hour": int(pick(record, "hour", default=medians.get("hour", 12)) or 12),
        "season": str(pick(record, "season", default="Unknown") or "Unknown"),
        "is_holiday": int(pick(record, "is_holiday", default=medians.get("is_holiday", 0)) or 0),
        "is_weekend": int(pick(record, "is_weekend", default=medians.get("is_weekend", 0)) or 0),
        "urgency_score": float(pick(record, "urgency_score", default=medians.get("urgency_score", 0)) or 0),
    }

    for col in FEATURE_COLS:
        if col in row:
            continue
        val = pick(record, col, default=medians.get(col, 0))
        row[col] = float(val) if val is not None else float(medians.get(col, 0))

    return row


def build_shap_explanation(factors: list[dict], baseline: float, prediction: float) -> dict:
    return {
        "baseline_value": round(float(baseline), 2),
        "prediction_value": round(float(prediction), 2),
        "factors": factors,
    }


def enrich_records(records: list[dict], model_path: Path | None = None) -> list[dict]:
    if not records:
        return []

    model_path = model_path or default_model_path()
    if not model_path.exists():
        raise FileNotFoundError(f"CatBoost model not found at {model_path}")

    medians = load_medians()
    model = joblib.load(model_path)

    rows = [build_row(r, medians) for r in records]
    frame = pd.DataFrame(rows)[FEATURE_COLS]

    for col in CAT_COLS:
        frame[col] = frame[col].astype(str).fillna("Unknown")

    for col in FEATURE_COLS:
        if col not in CAT_COLS:
            frame[col] = pd.to_numeric(frame[col], errors="coerce").fillna(medians.get(col, 0))

    cat_indices = [FEATURE_COLS.index(col) for col in CAT_COLS]
    pool = Pool(frame, cat_features=cat_indices)

    pred_log = model.predict(pool)
    pred_hours = np.maximum(np.expm1(pred_log), 0.0)

    shap_matrix = model.get_feature_importance(pool, type="ShapValues")
    if len(shap_matrix.shape) == 1:
        shap_matrix = shap_matrix.reshape(1, -1)

    enriched = []
    for idx, record in enumerate(records):
        hours = round(float(pred_hours[idx]), 2)
        shap_row = shap_matrix[idx]
        baseline = float(shap_row[-1])
        prediction = float(baseline + shap_row[:-1].sum())

        factors = []
        for f_idx, feature in enumerate(FEATURE_COLS):
            shap_val = round(float(shap_row[f_idx]), 2)
            if abs(shap_val) < 0.01:
                continue
            factors.append(
                {
                    "feature": feature,
                    "label": FEATURE_LABELS.get(feature, feature.replace("_", " ")),
                    "shap_value": shap_val,
                    "direction": "increases" if shap_val >= 0 else "decreases",
                }
            )
        factors.sort(key=lambda x: abs(x["shap_value"]), reverse=True)

        model_features = rows[idx]
        urgency = float(model_features.get("urgency_score", 0))
        actual = float(record.get("response_hours") or 0)
        confidence = round(
            min(0.97, max(0.62, 0.88 - abs(hours - actual) / 220)),
            2,
        ) if actual > 0 else 0.82

        merged = {
            **record,
            "predicted_response_hours": hours,
            "predicted_delay_bucket": delay_bucket(hours),
            "prediction_risk_level": risk_level(hours),
            "delay_risk_score": delay_risk_score(hours, urgency),
            "delay_tier": delay_tier(hours),
            "prediction_confidence": confidence,
            "model_version": MODEL_VERSION,
            "model_features": model_features,
            "shap_explanation": build_shap_explanation(factors[:12], baseline, prediction),
            "agency_workload_24h": model_features.get("agency_workload_24h"),
        }
        enriched.append(merged)

    return enriched


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        records = payload.get("records") or []
        model_path = payload.get("modelPath")
        path = Path(model_path).expanduser().resolve() if model_path else None
        result = enrich_records(records, path)
        json.dump({"ok": True, "records": result}, sys.stdout)
        return 0
    except Exception as exc:  # noqa: BLE001
        json.dump({"ok": False, "error": str(exc)}, sys.stdout)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
