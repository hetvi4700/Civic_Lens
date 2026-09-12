#!/usr/bin/env python3
"""Daily incremental pipeline: retention → ingest → cleanup → predict → rollups."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

from pymongo import MongoClient

from ingest import run_ingest
from pipeline_cleanup import run_closed_cleanup
from pipeline_retention import RetentionSafetyError, run_retention

REPO_ROOT = Path(__file__).resolve().parent.parent
PREPROCESSING_DIR = Path(__file__).resolve().parent

MONGO_URI = os.environ.get("MONGODB_URI", os.environ.get("MONGO_URI", "mongodb://localhost:27017"))
DB_NAME = os.environ.get("DB_NAME", "civic_lens")
PIPELINE_STATUS_COLLECTION = "pipeline_status"
FULL_CORPUS_COLLECTION = "requests_clean"

DEFAULT_INGEST_DAYS = int(os.environ.get("INGEST_DAYS", "3"))
DEFAULT_RETENTION_MONTHS = int(os.environ.get("RETENTION_MONTHS", "6"))
DEFAULT_RETENTION_MAX_DOCS = int(os.environ.get("RETENTION_MAX_DOCS", "180000"))
DEFAULT_ROLLUP_MONTHS = int(os.environ.get("ROLLUP_MONTHS", "6"))
TARGET_YEAR = os.environ.get("TARGET_YEAR", "2026")


def _require_requests_collection() -> str:
    """REQUESTS_COLLECTION must be set explicitly — no default."""
    collection = os.environ.get("REQUESTS_COLLECTION") or os.environ.get("COLLECTION")
    if not collection or not str(collection).strip():
        print(
            "ERROR: REQUESTS_COLLECTION is required and must be set explicitly.\n"
            "  The pipeline will not default to requests_clean (full local corpus).\n"
            "  Example:\n"
            "    REQUESTS_COLLECTION=requests_sample python3 daily_pipeline.py --dry-run\n"
            "  For GitHub Actions, set REQUESTS_COLLECTION in the workflow env block.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    return str(collection).strip()


def _reject_ci_full_corpus(collection: str) -> None:
    """Fail fast if CI targets the full local corpus collection."""
    if _running_in_ci() and collection == FULL_CORPUS_COLLECTION:
        print(
            "ERROR: REQUESTS_COLLECTION=requests_clean is not permitted in GitHub Actions.\n"
            "  CI runs are unattended; retention against the full corpus is permanently blocked.\n"
            "  Set REQUESTS_COLLECTION=requests_sample in .github/workflows/daily-pipeline.yml.",
            file=sys.stderr,
        )
        raise SystemExit(1)


def _running_in_ci() -> bool:
    return os.environ.get("GITHUB_ACTIONS", "").lower() == "true"


def _trailing_months(count: int) -> list[str]:
    now = datetime.now(timezone.utc)
    months = []
    year, month = now.year, now.month
    for _ in range(count):
        months.append(f"{year:04d}-{month:02d}")
        month -= 1
        if month == 0:
            month = 12
            year -= 1
    return months


def _write_pipeline_status(client: MongoClient, payload: dict) -> None:
    coll = client[DB_NAME][PIPELINE_STATUS_COLLECTION]
    coll.replace_one({"_id": "latest"}, payload, upsert=True)


def _run_predict_step(dry_run: bool, collection: str) -> dict:
    """Run store-prediction-mongodb.py as a subprocess."""
    env = os.environ.copy()
    env["REQUESTS_COLLECTION"] = collection
    env["REPREDICT"] = "false"
    if dry_run:
        env["DRY_RUN"] = "1"
    else:
        env.pop("DRY_RUN", None)

    script = PREPROCESSING_DIR / "store-prediction-mongodb.py"
    start = time.time()
    print("\n=== STEP 4: Predict on new/unpredicted open records ===")
    proc = subprocess.run(
        [sys.executable, str(script)],
        cwd=str(PREPROCESSING_DIR),
        env=env,
        capture_output=True,
        text=True,
    )
    elapsed_s = time.time() - start
    print(proc.stdout)
    if proc.stderr:
        print(proc.stderr, file=sys.stderr)

    if proc.returncode != 0:
        raise RuntimeError(f"Prediction step failed (exit {proc.returncode})")

    stats = {"elapsed_s": round(elapsed_s, 2), "dry_run": dry_run}
    for line in proc.stdout.splitlines():
        if line.startswith("Fetched "):
            stats["records_fetched"] = line
        if line.startswith("Modified:"):
            stats["records_modified"] = line.split(":", 1)[1].strip()
        if "Prediction mismatches >1%:" in line:
            stats["comparison"] = line.strip()
    return stats


def _run_rollups_step(dry_run: bool, rollup_months: int) -> dict:
    """Rebuild monthly rollups for trailing months via build-rollups.js."""
    months = _trailing_months(rollup_months)
    script = REPO_ROOT / "backend" / "scripts" / "build-rollups.js"
    start = time.time()
    print(f"\n=== STEP 5: Rebuild rollups for trailing {rollup_months} month(s) ===")
    print(f"  Months: {', '.join(months)}")

    if dry_run:
        stats = {"months": months, "elapsed_s": 0, "dry_run": True, "skipped": True}
        print(f"  DRY RUN — would rebuild {len(months)} month(s)")
        return stats

    env = os.environ.copy()
    rebuilt = []
    for month in months:
        proc = subprocess.run(
            ["node", str(script), "--month", month],
            cwd=str(REPO_ROOT / "backend"),
            env=env,
            capture_output=True,
            text=True,
        )
        print(proc.stdout)
        if proc.stderr:
            print(proc.stderr, file=sys.stderr)
        if proc.returncode != 0:
            raise RuntimeError(f"Rollup rebuild failed for {month} (exit {proc.returncode})")
        rebuilt.append(month)

    elapsed_s = time.time() - start
    stats = {"months": rebuilt, "elapsed_s": round(elapsed_s, 2), "dry_run": False}
    print(f"Rollups complete: {stats}")
    return stats


def run_pipeline(
    *,
    collection: str,
    dry_run: bool = False,
    skip_ingest: bool = False,
    allow_full_corpus: bool = False,
    ingest_days: int = DEFAULT_INGEST_DAYS,
    retention_months: int = DEFAULT_RETENTION_MONTHS,
    retention_max_docs: int = DEFAULT_RETENTION_MAX_DOCS,
    rollup_months: int = DEFAULT_ROLLUP_MONTHS,
) -> dict:
    pipeline_start = time.time()
    started_at = datetime.now(timezone.utc)
    client = MongoClient(MONGO_URI)

    status_doc = {
        "_id": "latest",
        "started_at": started_at,
        "completed_at": None,
        "success": False,
        "dry_run": dry_run,
        "collection": collection,
        "db_name": DB_NAME,
        "steps": {},
        "error": None,
        "total_elapsed_s": None,
    }

    try:
        print("=" * 60)
        print(f"Civic Lens daily pipeline — {'DRY RUN' if dry_run else 'LIVE RUN'}")
        print(f"  MongoDB: {DB_NAME}.{collection}")
        if collection == FULL_CORPUS_COLLECTION and allow_full_corpus:
            print("  WARNING: --allow-full-corpus set; operating on full corpus collection")
        print("=" * 60)

        print("\n=== STEP 1: Retention (delete-before-insert) ===")
        retention_stats = run_retention(
            retention_months=retention_months,
            max_docs=retention_max_docs,
            dry_run=dry_run,
            allow_full_corpus=allow_full_corpus,
            collection_name=collection,
        )
        status_doc["steps"]["retention"] = retention_stats

        print("\n=== STEP 2: Incremental ingest ===")
        if skip_ingest:
            ingest_stats = {"skipped": True, "reason": "skip_ingest flag set"}
            print("  Skipped (--skip-ingest)")
        else:
            ingest_stats = run_ingest(
                days=ingest_days,
                dry_run=dry_run,
                collection_name=collection,
            )
        status_doc["steps"]["ingest"] = ingest_stats

        print("\n=== STEP 3: Closed-record cleanup ===")
        cleanup_stats = run_closed_cleanup(
            dry_run=dry_run,
            collection_name=collection,
        )
        status_doc["steps"]["closed_cleanup"] = cleanup_stats

        predict_stats = _run_predict_step(dry_run, collection)
        status_doc["steps"]["predict"] = predict_stats

        rollup_stats = _run_rollups_step(dry_run, rollup_months)
        status_doc["steps"]["rollups"] = rollup_stats

        status_doc["success"] = True
        status_doc["completed_at"] = datetime.now(timezone.utc)
        status_doc["total_elapsed_s"] = round(time.time() - pipeline_start, 2)

        if not dry_run:
            _write_pipeline_status(client, status_doc)

        print("\n" + "=" * 60)
        print(f"Pipeline finished successfully in {status_doc['total_elapsed_s']}s")
        print("=" * 60)
        return status_doc

    except RetentionSafetyError:
        raise
    except Exception as exc:
        status_doc["success"] = False
        status_doc["error"] = str(exc)
        status_doc["completed_at"] = datetime.now(timezone.utc)
        status_doc["total_elapsed_s"] = round(time.time() - pipeline_start, 2)
        status_doc["traceback"] = traceback.format_exc()

        if not dry_run:
            _write_pipeline_status(client, status_doc)

        print(f"\nPIPELINE FAILED: {exc}", file=sys.stderr)
        print(status_doc["traceback"], file=sys.stderr)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Civic Lens daily incremental pipeline")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes"),
        help="Log actions without writing to MongoDB or rebuilding rollups",
    )
    parser.add_argument("--days", type=int, default=DEFAULT_INGEST_DAYS, help="Ingest lookback days")
    parser.add_argument(
        "--retention-months",
        type=int,
        default=DEFAULT_RETENTION_MONTHS,
        help="Keep detail records with created_date within this many months",
    )
    parser.add_argument(
        "--retention-max-docs",
        type=int,
        default=DEFAULT_RETENTION_MAX_DOCS,
        help="Hard cap on detail collection document count",
    )
    parser.add_argument(
        "--rollup-months",
        type=int,
        default=DEFAULT_ROLLUP_MONTHS,
        help="Trailing months to rebuild in monthly_rollups",
    )
    parser.add_argument(
        "--skip-ingest",
        action="store_true",
        help="Skip NYC Open Data fetch (local testing when APP_TOKEN unavailable)",
    )
    parser.add_argument(
        "--allow-full-corpus",
        action="store_true",
        help=(
            "Allow retention against requests_clean or deletions exceeding 10%% "
            "of the target collection"
        ),
    )
    args = parser.parse_args()

    collection = _require_requests_collection()
    _reject_ci_full_corpus(collection)
    # Ensure subprocesses and imported modules see the validated collection.
    os.environ["REQUESTS_COLLECTION"] = collection

    try:
        run_pipeline(
            collection=collection,
            dry_run=args.dry_run,
            skip_ingest=args.skip_ingest,
            allow_full_corpus=args.allow_full_corpus,
            ingest_days=args.days,
            retention_months=args.retention_months,
            retention_max_docs=args.retention_max_docs,
            rollup_months=args.rollup_months,
        )
    except RetentionSafetyError as exc:
        print(f"\nRETENTION BLOCKED: {exc}", file=sys.stderr)
        return 1
    except SystemExit:
        raise
    except Exception:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
