"""Remove stale prediction fields from records that have closed."""

from __future__ import annotations

import os
import time

from pymongo import MongoClient

MONGO_URI = os.environ.get("MONGODB_URI", os.environ.get("MONGO_URI", "mongodb://localhost:27017"))
DB_NAME = os.environ.get("DB_NAME", "civic_lens")
COLLECTION = os.environ.get("REQUESTS_COLLECTION", os.environ.get("COLLECTION", "requests_clean"))

PREDICTION_FIELDS = [
    "predicted_response_hours",
    "predicted_response_hours_raw",
    "predicted_bucket",
    "predicted_delay_bucket",
    "delay_risk_score",
    "shap_explanation",
    "prediction_model",
    "prediction_generated_at",
    "prediction_scope",
]

CLOSED_QUERY = {
    "is_unresolved": 0,
    "predicted_response_hours": {"$exists": True},
}


def count_stale_closed_predictions(
    mongo_uri: str | None = None,
    db_name: str | None = None,
    collection_name: str | None = None,
) -> int:
    client = MongoClient(mongo_uri or MONGO_URI)
    collection = client[db_name or DB_NAME][collection_name or COLLECTION]
    return collection.count_documents(CLOSED_QUERY)


def run_closed_cleanup(
    *,
    dry_run: bool = False,
    mongo_uri: str | None = None,
    db_name: str | None = None,
    collection_name: str | None = None,
) -> dict:
    """Unset prediction fields on closed records that still carry open-case predictions."""
    uri = mongo_uri or MONGO_URI
    db = db_name or DB_NAME
    coll_name = collection_name or COLLECTION

    client = MongoClient(uri)
    collection = client[db][coll_name]

    start = time.time()
    affected = collection.count_documents(CLOSED_QUERY)
    print(f"Closed-record cleanup: {affected:,} records with stale predictions")

    modified = 0
    if affected and not dry_run:
        unset_doc = {field: "" for field in PREDICTION_FIELDS}
        result = collection.update_many(CLOSED_QUERY, {"$unset": unset_doc})
        modified = result.modified_count
        print(f"  Cleared predictions on {modified:,} records")
    elif dry_run:
        print(f"  DRY RUN — would unset {len(PREDICTION_FIELDS)} fields on {affected:,} records")

    elapsed_s = time.time() - start
    stats = {
        "affected": affected,
        "modified": modified if not dry_run else 0,
        "would_modify": affected if dry_run else modified,
        "elapsed_s": round(elapsed_s, 2),
        "dry_run": dry_run,
    }
    print(f"Closed cleanup complete: {stats}")
    return stats
