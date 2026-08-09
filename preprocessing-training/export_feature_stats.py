#!/usr/bin/env python3
"""Export enriched feature_stats with train-split lookup maps for inference."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import joblib
import pandas as pd

TRAIN_END = pd.Timestamp("2025-10-01")

# Numeric model features (matches training.py / store-prediction-mongodb.py)
NUM_MEDIAN_COLS = [
    "day_of_week",
    "month",
    "hour",
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

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = REPO_ROOT / "backend" / "models" / "feature_stats_full.pkl"
DEFAULT_BASE_STATS = REPO_ROOT / "backend" / "models" / "feature_stats_full.pkl"


def _key(*parts) -> str:
    return "|".join(str(p) for p in parts)


def load_train_split(parquet_path: Path) -> pd.DataFrame:
    df = pd.read_parquet(parquet_path)
    df["created_date"] = pd.to_datetime(df["created_date"])
    train_df = df[df["created_date"] < TRAIN_END].copy()
    print(
        f"Loaded {len(df):,} parquet rows; "
        f"train split (created_date < {TRAIN_END.date()}): {len(train_df):,}"
    )
    return train_df


def build_num_medians(train_df: pd.DataFrame) -> dict[str, float]:
    """Global numeric fallbacks — train-split medians (features_save_model_train logic)."""
    medians = {}
    for col in NUM_MEDIAN_COLS:
        if col not in train_df.columns:
            raise SystemExit(f"Missing numeric column in train split: {col}")
        medians[col] = float(train_df[col].median())
    return medians


def build_lookup_maps(train_df: pd.DataFrame) -> dict:
    """All seven keyed lookup maps from train split only (data_claude.py logic)."""
    train_df = train_df.copy()
    train_df["incident_zip"] = train_df["incident_zip"].astype(str)

    complaint_median_map = (
        train_df.groupby("complaint_type")["response_hours"]
        .median()
        .astype(float)
        .to_dict()
    )

    agency_complaint_median_map = {
        _key(agency, complaint_type): float(median)
        for (agency, complaint_type), median in train_df.groupby(
            ["agency", "complaint_type"]
        )["response_hours"].median().items()
    }

    agency_stats_map = {
        agency: {
            "agency_median_hours": float(row["agency_median_hours"]),
            "agency_volume": float(row["agency_volume"]),
            "agency_unresolved": float(row["agency_unresolved"]),
        }
        for agency, row in train_df.groupby("agency").agg(
            agency_median_hours=("response_hours", "median"),
            agency_volume=("unique_key", "count"),
            agency_unresolved=("is_unresolved", "mean"),
        ).iterrows()
    }

    agency_zip_median_map = {
        _key(agency, zip_code): float(median)
        for (agency, zip_code), median in train_df.groupby(["agency", "incident_zip"])[
            "response_hours"
        ].median().items()
    }

    agency_dow_median_map = {
        _key(agency, dow): float(median)
        for (agency, dow), median in train_df.groupby(["agency", "day_of_week"])[
            "response_hours"
        ].median().items()
    }

    borough_complaint_median_map = {
        _key(borough, complaint_type): float(median)
        for (borough, complaint_type), median in train_df.groupby(["borough", "complaint_type"])[
            "response_hours"
        ].median().items()
    }

    agency_complaint_volume_map = {
        _key(agency, complaint_type): int(volume)
        for (agency, complaint_type), volume in train_df.groupby(
            ["agency", "complaint_type"]
        ).size().items()
    }

    return {
        "complaint_median_map": complaint_median_map,
        "agency_complaint_median_map": agency_complaint_median_map,
        "agency_stats_map": agency_stats_map,
        "agency_zip_median_map": agency_zip_median_map,
        "agency_dow_median_map": agency_dow_median_map,
        "borough_complaint_median_map": borough_complaint_median_map,
        "agency_complaint_volume_map": agency_complaint_volume_map,
    }


def build_full_stats(base_stats: dict, train_df: pd.DataFrame) -> dict:
    """Merge rebuilt maps/medians with calibration preserved from base."""
    if "calibration" not in base_stats:
        raise SystemExit("Base stats missing calibration — cannot export.")

    num_medians = build_num_medians(train_df)
    lookup_maps = build_lookup_maps(train_df)

    return {
        "num_medians": num_medians,
        **lookup_maps,
        "created_at": base_stats.get("created_at"),
        # Scalar fallbacks mirror num_medians for schema compatibility
        "agency_median_hours": num_medians["agency_median_hours"],
        "complaint_median_hours": num_medians["complaint_median_hours"],
        "agency_complaint_median": num_medians["agency_complaint_median"],
        "agency_zip_median": num_medians["agency_zip_median"],
        "agency_dow_median": num_medians["agency_dow_median"],
        "borough_complaint_median": num_medians["borough_complaint_median"],
        "agency_volume": num_medians["agency_volume"],
        "agency_complaint_volume": num_medians["agency_complaint_volume"],
        "agency_unresolved": num_medians["agency_unresolved"],
        "calibration": base_stats["calibration"],
    }


def describe_stats(stats: dict) -> None:
    print("\n=== feature_stats_full.pkl summary ===")
    for key, value in stats.items():
        if isinstance(value, dict):
            print(f"\n{key}: dict, len={len(value)}")
            for idx, (sample_key, sample_val) in enumerate(value.items()):
                if idx >= 3:
                    print(f"  ... ({len(value) - 3} more entries)")
                    break
                print(f"  [{sample_key!r}]: {sample_val!r}")
        else:
            print(f"\n{key}: {type(value).__name__} = {value!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--parquet",
        type=Path,
        required=True,
        help="Path to features_2024_2025.parquet (p90 train features)",
    )
    parser.add_argument(
        "--base-stats",
        type=Path,
        default=DEFAULT_BASE_STATS,
        help="Existing stats file containing calibration (default: feature_stats_full.pkl)",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    if not args.parquet.exists():
        print(f"Parquet not found: {args.parquet}", file=sys.stderr)
        return 1
    if not args.base_stats.exists():
        print(
            f"Base stats not found: {args.base_stats}\n"
            "Provide --base-stats with a file containing a 'calibration' key.",
            file=sys.stderr,
        )
        return 1

    print(f"TRAIN_END = {TRAIN_END}")
    print(f"Parquet   = {args.parquet}")
    print(f"Base stats= {args.base_stats} (calibration only)")
    print(f"Output    = {args.output}")

    base_stats = joblib.load(args.base_stats)
    train_df = load_train_split(args.parquet)
    full_stats = build_full_stats(base_stats, train_df)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(full_stats, args.output)

    size_bytes = os.path.getsize(args.output)
    print(f"\nWrote {args.output} ({size_bytes:,} bytes)")
    describe_stats(full_stats)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
