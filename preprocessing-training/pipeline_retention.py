"""Retention for the detail collection — runs BEFORE ingest inserts."""

from __future__ import annotations

import calendar
import os
import time
from datetime import datetime, timezone

from pymongo import MongoClient

MONGO_URI = os.environ.get("MONGODB_URI", os.environ.get("MONGO_URI", "mongodb://localhost:27017"))
DB_NAME = os.environ.get("DB_NAME", "civic_lens")
COLLECTION = os.environ.get("REQUESTS_COLLECTION", os.environ.get("COLLECTION", "requests_clean"))

DEFAULT_RETENTION_MONTHS = int(os.environ.get("RETENTION_MONTHS", "6"))
DEFAULT_MAX_DOCS = int(os.environ.get("RETENTION_MAX_DOCS", "320000"))
TARGET_YEAR = int(os.environ.get("TARGET_YEAR", "2026"))
WORKLOAD_HISTORY_ROLE = "workload_history"
SAMPLE_COLLECTION = "requests_sample"


def _subtract_months(dt: datetime, months: int) -> datetime:
    year, month = dt.year, dt.month - months
    while month <= 0:
        month += 12
        year -= 1
    last_day = calendar.monthrange(year, month)[1]
    return dt.replace(year=year, month=month, day=min(dt.day, last_day))


def _detail_filter(extra: dict | None = None) -> dict:
    """Detail records subject to retention — excludes workload history slice."""
    filt = {"sample_role": {"$ne": WORKLOAD_HISTORY_ROLE}}
    if extra:
        filt = {**filt, **extra}
    return filt


def _effective_cutoff(retention_months: int, collection_name: str) -> datetime:
    """Month-based cutoff; for requests_sample never delete showcase-year detail."""
    month_cutoff = _subtract_months(datetime.now(timezone.utc).replace(tzinfo=None), retention_months)
    if collection_name == SAMPLE_COLLECTION:
        showcase_floor = datetime(TARGET_YEAR, 1, 1)
        # Earlier cutoff deletes less (keeps more recent history including all of TARGET_YEAR).
        return min(month_cutoff, showcase_floor)
    return month_cutoff


FULL_CORPUS_COLLECTION = "requests_clean"
LARGE_DELETE_FRACTION = 0.10


class RetentionSafetyError(RuntimeError):
    """Retention blocked by safety guard."""


def _running_in_ci() -> bool:
    return os.environ.get("GITHUB_ACTIONS", "").lower() == "true"


def _enforce_retention_safety(
    *,
    db_name: str,
    coll_name: str,
    count_before: int,
    deleted_by_date: int,
    deleted_by_cap: int,
    allow_full_corpus: bool,
) -> None:
    total_delete = deleted_by_date + deleted_by_cap
    fraction = total_delete / count_before if count_before else 0.0

    print("\n*** RETENTION DELETE PLAN ***")
    print(f"  Target collection: {db_name}.{coll_name}")
    print(f"  Delete by date rule: {deleted_by_date:,}")
    print(f"  Delete by hard cap:  {deleted_by_cap:,}")
    print(f"  Total deletions:     {total_delete:,} / {count_before:,} ({fraction:.1%})")

    if coll_name == FULL_CORPUS_COLLECTION and _running_in_ci():
        raise RetentionSafetyError(
            f"Retention against {FULL_CORPUS_COLLECTION} is permanently blocked in CI "
            "(GITHUB_ACTIONS=true), regardless of --allow-full-corpus. "
            "Set REQUESTS_COLLECTION=requests_sample in the workflow env."
        )

    if coll_name == FULL_CORPUS_COLLECTION and not allow_full_corpus:
        raise RetentionSafetyError(
            f"Retention against {FULL_CORPUS_COLLECTION} is blocked. "
            "That collection is the full local corpus used for rollups, samples, "
            "and workload history. Set REQUESTS_COLLECTION=requests_sample for "
            "incremental runs, or pass --allow-full-corpus to override."
        )

    if total_delete > 0 and fraction > LARGE_DELETE_FRACTION and not allow_full_corpus:
        raise RetentionSafetyError(
            f"Retention would delete {fraction:.1%} of {coll_name} "
            f"({total_delete:,} of {count_before:,} records). "
            "Pass --allow-full-corpus to confirm this is intentional."
        )


def run_retention(
    *,
    retention_months: int = DEFAULT_RETENTION_MONTHS,
    max_docs: int = DEFAULT_MAX_DOCS,
    dry_run: bool = False,
    allow_full_corpus: bool = False,
    mongo_uri: str | None = None,
    db_name: str | None = None,
    collection_name: str | None = None,
) -> dict:
    """Delete old detail records, then enforce hard doc cap (workload slice exempt)."""
    uri = mongo_uri or MONGO_URI
    db = db_name or DB_NAME
    if not collection_name:
        raise RetentionSafetyError(
            "collection_name is required for retention (set REQUESTS_COLLECTION)."
        )
    coll_name = collection_name

    client = MongoClient(uri)
    collection = client[db][coll_name]

    start = time.time()
    count_before = collection.count_documents({})
    detail_before = collection.count_documents(_detail_filter())
    workload_count = collection.count_documents({"sample_role": WORKLOAD_HISTORY_ROLE})

    cutoff = _effective_cutoff(retention_months, coll_name)
    date_filter = _detail_filter({"created_date": {"$lt": cutoff}})
    deleted_by_date = collection.count_documents(date_filter)

    print(
        f"Retention: keep last {retention_months} month(s) of detail created_date "
        f"(effective cutoff {cutoff.isoformat()})"
    )
    if coll_name == SAMPLE_COLLECTION:
        print(
            f"  Sample mode: showcase year {TARGET_YEAR}+ preserved; "
            f"{workload_count:,} workload_history records exempt"
        )
    print(f"  Collection {db}.{coll_name}: {count_before:,} docs ({detail_before:,} detail) before retention")

    deleted_by_date_planned = deleted_by_date
    print(f"  Would delete / deleted by date: {deleted_by_date_planned:,}")

    detail_after_date = detail_before - deleted_by_date_planned
    deleted_by_cap = 0

    if detail_after_date > max_docs:
        excess = detail_after_date - max_docs
        deleted_by_cap = excess
        print(
            f"  Hard cap {max_docs:,} detail docs exceeded by {excess:,} "
            f"— deleting oldest detail by created_date"
        )
    print(f"  Would delete / deleted by cap: {deleted_by_cap:,}")

    _enforce_retention_safety(
        db_name=db,
        coll_name=coll_name,
        count_before=count_before,
        deleted_by_date=deleted_by_date_planned,
        deleted_by_cap=deleted_by_cap,
        allow_full_corpus=allow_full_corpus,
    )

    deleted_by_date = deleted_by_date_planned
    if deleted_by_date and not dry_run:
        result = collection.delete_many(date_filter)
        deleted_by_date = result.deleted_count

    if deleted_by_cap and not dry_run:
        oldest = list(
            collection.find(_detail_filter(), {"_id": 1})
            .sort("created_date", 1)
            .limit(deleted_by_cap)
        )
        ids = [doc["_id"] for doc in oldest]
        if ids:
            result = collection.delete_many({"_id": {"$in": ids}})
            deleted_by_cap = result.deleted_count

    count_after = (
        collection.count_documents({})
        if not dry_run
        else count_before - deleted_by_date - deleted_by_cap
    )
    detail_after = (
        collection.count_documents(_detail_filter())
        if not dry_run
        else detail_after_date - deleted_by_cap
    )

    elapsed_s = time.time() - start
    stats = {
        "count_before": count_before,
        "detail_before": detail_before,
        "workload_history_count": workload_count,
        "deleted_by_date": deleted_by_date,
        "deleted_by_cap": deleted_by_cap,
        "count_after": count_after,
        "detail_after": detail_after,
        "retention_months": retention_months,
        "max_docs": max_docs,
        "cutoff": cutoff.isoformat(),
        "elapsed_s": round(elapsed_s, 2),
        "dry_run": dry_run,
    }
    print(f"Retention complete: {stats}")
    return stats
