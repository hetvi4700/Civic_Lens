import os
import time
import joblib
import numpy as np
import pandas as pd
from catboost import CatBoostRegressor
from sklearn.metrics import (
    mean_absolute_error,
    root_mean_squared_error,
    r2_score,
    accuracy_score,
    classification_report,
)

# ═══════════════════════════════════════════════════════════════════════════════
# TRAINING SCRIPT — p95 winsorization path (NOT the deployed model)
# ═══════════════════════════════════════════════════════════════════════════════
#
# This script trains on data/features_2024_2025_p95.parquet, where response_hours
# was winsorized at the train-split p95 (~591 h) by data_claude.py.
#
# It saves backend/models/catboost_model_2024_2025_p95.pkl.
#
# The DEPLOYED / DASHBOARD model is different:
#   - Parquet: features_2024_2025.parquet (p90 winsorization, ~231 h cap)
#   - Model:   backend/models/catboost_model_2024_2025.pkl
#   - Stats:   backend/models/feature_stats_full.pkl
#
# Reported bucket-accuracy metrics in project docs (especially 7+ Days recall)
# came from the p90 deployed model, not from this p95 training run.
# Do not assume training.py reproduces production inference artifacts.
# ═══════════════════════════════════════════════════════════════════════════════

os.makedirs("models", exist_ok=True)

FEATURES_FILE = "data/features_2024_2025_p95.parquet"

# ── Feature definitions ───────────────────────────────────────────────────────

feature_cols = [
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

cat_cols = [
    "complaint_type",
    "agency",
    "borough",
    "incident_zip",
    "open_data_channel_type",
    "dow_complaint",
    "season",
]

target_col = "response_hours"
BUCKET_ORDER = ["Same Day", "1-3 Days", "3-7 Days", "7+ Days"]


def bucket(x):
    if x <= 24:  return "Same Day"
    if x <= 72:  return "1-3 Days"
    if x <= 168: return "3-7 Days"
    return "7+ Days"


# ── Load ──────────────────────────────────────────────────────────────────────

print("=" * 55)
print("  CIVIC LENS — CatBoost Training (2024+2025 p95)")
print("=" * 55)

print("\nLoading parquet...")
t = time.time()

df = pd.read_parquet(FEATURES_FILE)

if "dow_complaint" not in df.columns:
    print("⚠️  dow_complaint not found — computing now...")
    df["dow_complaint"] = df["day_of_week"].astype(str) + "_" + df["complaint_type"]

feature_cols = [c for c in feature_cols if c in df.columns]
missing = [c for c in cat_cols if c not in df.columns]
if missing:
    print(f"⚠️  Missing cat cols (will skip): {missing}")
cat_cols = [c for c in cat_cols if c in df.columns]

print(f"✅ Loaded in {time.time()-t:.1f}s")
print(f"   Total rows  : {len(df):,}")
print(f"   Features    : {len(feature_cols)}")
print(f"   Cat features: {len(cat_cols)}")

# ── Split ─────────────────────────────────────────────────────────────────────

train_df = df[df["split"] == "train"].reset_index(drop=True)
val_df   = df[df["split"] == "val"].reset_index(drop=True)
test_df  = df[df["split"] == "test"].reset_index(drop=True)

del df

print("\n===== SPLIT SIZES =====")
print(f"Train : {len(train_df):>9,} | {train_df['created_date'].min().date()} → {train_df['created_date'].max().date()}")
print(f"Val   : {len(val_df):>9,} | {val_df['created_date'].min().date()} → {val_df['created_date'].max().date()}")
print(f"Test  : {len(test_df):>9,} | {test_df['created_date'].min().date()} → {test_df['created_date'].max().date()}")

print("\n===== YEAR BREAKDOWN IN TRAIN =====")
print(train_df["year"].value_counts().sort_index().to_string())

print("\n===== TARGET DISTRIBUTION =====")
for name, d in [("Train", train_df), ("Val", val_df), ("Test", test_df)]:
    print(
        f"{name:<6} | "
        f"mean={d[target_col].mean():.2f} | "
        f"median={d[target_col].median():.2f} | "
        f"p90={d[target_col].quantile(0.90):.2f} | "
        f"max={d[target_col].max():.2f}"
    )

print("\n===== BUCKET DISTRIBUTION =====")
for name, d in [("Train", train_df), ("Val", val_df), ("Test", test_df)]:
    total = len(d)
    buckets = d[target_col].apply(bucket).value_counts()
    parts = " | ".join(
        f"{b}: {buckets.get(b,0)/total*100:.1f}%"
        for b in BUCKET_ORDER
    )
    print(f"  {name:<6} → {parts}")

# ── Prepare X / y ─────────────────────────────────────────────────────────────

X_train = train_df[feature_cols].copy()
X_val   = val_df[feature_cols].copy()
X_test  = test_df[feature_cols].copy()

y_train = train_df[target_col].copy()
y_val   = val_df[target_col].copy()
y_test  = test_df[target_col].copy()

del train_df, val_df, test_df

for col in cat_cols:
    X_train[col] = X_train[col].astype(str).fillna("Unknown")
    X_val[col]   = X_val[col].astype(str).fillna("Unknown")
    X_test[col]  = X_test[col].astype(str).fillna("Unknown")

num_cols = [c for c in feature_cols if c not in cat_cols]
for col in num_cols:
    med = X_train[col].median()
    X_train[col] = X_train[col].fillna(med)
    X_val[col]   = X_val[col].fillna(med)
    X_test[col]  = X_test[col].fillna(med)

# ── Baseline ──────────────────────────────────────────────────────────────────

baseline_pred      = np.full(len(y_test), y_train.mean())
baseline_rmse      = root_mean_squared_error(y_test, baseline_pred)
baseline_mae       = mean_absolute_error(y_test, baseline_pred)
baseline_actual    = y_test.apply(bucket)
baseline_predicted = pd.Series(baseline_pred).apply(bucket)
baseline_acc       = accuracy_score(baseline_actual, baseline_predicted)

print(f"\n===== BASELINE (mean predictor) =====")
print(f"MAE            : {baseline_mae:.3f} hrs")
print(f"RMSE           : {baseline_rmse:.3f} hrs")
print(f"Bucket Accuracy: {baseline_acc:.3f}")

# ── Sample weights ────────────────────────────────────────────────────────────

sample_weights = np.ones(len(y_train))
sample_weights[(y_train > 24)  & (y_train <= 72)]  = 1.5
sample_weights[(y_train > 72)  & (y_train <= 168)] = 2.5
sample_weights[y_train > 168]                       = 3.5

print("\n===== SAMPLE WEIGHT DISTRIBUTION =====")
for label, mask in [
    ("Same Day  (≤24h)",    y_train <= 24),
    ("1-3 Days  (24-72h)",  (y_train > 24)  & (y_train <= 72)),
    ("3-7 Days  (72-168h)", (y_train > 72)  & (y_train <= 168)),
    ("7+ Days   (>168h)",   y_train > 168),
]:
    n = mask.sum()
    w = sample_weights[mask][0]
    pct = n / len(y_train) * 100
    print(f"  {label:<22} | n={n:>9,} ({pct:4.1f}%) | weight={w:.1f}")

# ── Cat feature indices ───────────────────────────────────────────────────────

cat_feature_indices = [
    X_train.columns.get_loc(col)
    for col in cat_cols
]

# ── Train ─────────────────────────────────────────────────────────────────────

print("\n" + "=" * 55)
print("  Training CatBoost (2024+2025 p95)...")
print("=" * 55)

model = CatBoostRegressor(
    iterations=2000,
    depth=6,
    learning_rate=0.03,
    loss_function="RMSE",
    eval_metric="RMSE",
    random_seed=42,
    early_stopping_rounds=50,
    verbose=100,
    allow_writing_files=False,
)

t = time.time()
model.fit(
    X_train,
    np.log1p(y_train),
    eval_set=(X_val, np.log1p(y_val)),
    cat_features=cat_feature_indices,
    sample_weight=sample_weights,
    use_best_model=True,
)
train_time = time.time() - t
print(f"\n✅ Training done in {train_time/60:.1f} min")
print(f"   Best iteration: {model.get_best_iteration()}")

# ── Predict ───────────────────────────────────────────────────────────────────

pred_log     = model.predict(X_test)
pred         = np.maximum(np.expm1(pred_log), 0)

val_pred_log = model.predict(X_val)
val_pred     = np.maximum(np.expm1(val_pred_log), 0)

# ── Regression metrics ────────────────────────────────────────────────────────

mae  = mean_absolute_error(y_test, pred)
rmse = root_mean_squared_error(y_test, pred)
r2   = r2_score(y_test, pred)

val_mae  = mean_absolute_error(y_val, val_pred)
val_rmse = root_mean_squared_error(y_val, val_pred)
val_r2   = r2_score(y_val, val_pred)

print("\n===== REGRESSION METRICS =====")
print(f"{'Metric':<8} {'Val':>10} {'Test':>10} {'Baseline':>10}")
print("-" * 42)
print(f"{'MAE':<8} {val_mae:>10.3f} {mae:>10.3f} {baseline_mae:>10.3f}  hrs")
print(f"{'RMSE':<8} {val_rmse:>10.3f} {rmse:>10.3f} {baseline_rmse:>10.3f}  hrs")
print(f"{'R²':<8} {val_r2:>10.3f} {r2:>10.3f} {'—':>10}")

# ── Bucket metrics ────────────────────────────────────────────────────────────

actual        = y_test.apply(bucket)
predicted     = pd.Series(pred).apply(bucket)
val_actual    = y_val.apply(bucket)
val_predicted = pd.Series(val_pred).apply(bucket)

test_acc = accuracy_score(actual, predicted)
val_acc  = accuracy_score(val_actual, val_predicted)

print(f"\n===== BUCKET ACCURACY =====")
print(f"Val  : {val_acc:.3f}")
print(f"Test : {test_acc:.3f}")

print("\n===== PER-BUCKET BREAKDOWN (TEST) =====")
print(f"{'Bucket':<12} | {'Actual':>8} | {'Predicted':>10} | {'Recall':>7} | {'Notes'}")
print("-" * 62)
for b in BUCKET_ORDER:
    a_count = (actual == b).sum()
    p_count = (predicted == b).sum()
    correct = ((actual == b) & (predicted == b)).sum()
    recall  = correct / a_count if a_count > 0 else 0
    note    = "⚠️  low" if recall < 0.5 else ("✅ good" if recall >= 0.75 else "")
    print(f"{b:<12} | {a_count:>8,} | {p_count:>10,} | {recall:>6.1%} | {note}")

print("\n===== CLASSIFICATION REPORT (TEST) =====")
print(classification_report(actual, predicted, labels=BUCKET_ORDER, digits=3))

print("\n===== CLASSIFICATION REPORT (VAL) =====")
print(classification_report(val_actual, val_predicted, labels=BUCKET_ORDER, digits=3))

# ── Comparison against previous runs ─────────────────────────────────────────
print("\n===== MODEL COMPARISON =====")
print(f"{'Model':<30} {'Val Acc':>8} {'Test Acc':>9} {'Test MAE':>10}")
print("-" * 62)
print(f"  {'2025 only p90 (original)':<28} {'???':>8} {'???':>9} {'???':>10}")
print(f"  {'2024+2025 p90':<28} {'0.701':>8} {'0.749':>9} {'20.867':>10}")
print(f"  {'2024+2025 p95 (current)':<28} {val_acc:>8.3f} {test_acc:>9.3f} {mae:>10.3f}")

# ── Feature importance ────────────────────────────────────────────────────────

importance = pd.DataFrame({
    "feature":    feature_cols,
    "importance": model.get_feature_importance(),
}).sort_values("importance", ascending=False).reset_index(drop=True)

print("\n===== TOP 20 FEATURES =====")
print(importance.head(20).to_string(index=False))

# ── Save ──────────────────────────────────────────────────────────────────────

importance.to_csv("backend/models/catboost_feature_importance_2024_2025_p95.csv", index=False)
joblib.dump(model, "backend/models/catboost_model_2024_2025_p95.pkl")

print("\n" + "=" * 55)
print("  ✅ Saved")
print("=" * 55)
print("  models/catboost_model_2024_2025_p95.pkl")
print("  models/catboost_feature_importance_2024_2025_p95.csv")
print()
print(f"  Features used       : {len(feature_cols)}")
print(f"  Best iteration      : {model.get_best_iteration()}")
print(f"  Test bucket accuracy: {test_acc:.3f}")
print(f"  Test R²             : {r2:.3f}")
print(f"  Test MAE            : {mae:.3f} hrs")
print("=" * 55)