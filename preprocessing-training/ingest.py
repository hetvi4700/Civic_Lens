#!/usr/bin/env python3
"""Download NYC 311 data and upsert cleaned records into MongoDB."""

from __future__ import annotations

import argparse
import math
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import holidays
import pandas as pd
import requests
from pymongo import MongoClient, UpdateOne

MONGO_URI = os.environ.get("MONGODB_URI", os.environ.get("MONGO_URI", "mongodb://localhost:27017"))
DB_NAME = os.environ.get("DB_NAME", "civic_lens")
COLLECTION = os.environ.get("REQUESTS_COLLECTION", os.environ.get("COLLECTION", "requests_clean"))
APP_TOKEN = os.environ.get("APP_TOKEN")

CHUNK_SIZE = 50000
TIMEOUT = 180
RETRY_WAIT = 20

FIELDS = ",".join([
    "unique_key", "created_date", "closed_date", "resolution_action_updated_date",
    "agency", "agency_name", "complaint_type", "descriptor", "status",
    "resolution_description", "borough", "incident_zip", "incident_address",
    "latitude", "longitude", "community_board", "open_data_channel_type",
])

URL = "https://data.cityofnewyork.us/resource/erm2-nwe9.json"

TOP_30_TYPES = [
    "Illegal Parking",
    "Noise - Residential",
    "HEAT/HOT WATER",
    "Blocked Driveway",
    "Noise - Street/Sidewalk",
    "UNSANITARY CONDITION",
    "Water System",
    "Abandoned Vehicle",
    "PLUMBING",
    "Noise - Commercial",
    "PAINT/PLASTER",
    "Dirty Condition",
    "Noise",
    "Street Condition",
    "Noise - Vehicle",
    "DOOR/WINDOW",
    "Traffic Signal Condition",
    "Derelict Vehicles",
    "Missed Collection",
    "WATER LEAK",
    "Encampment",
    "Illegal Dumping",
    "General Construction/Plumbing",
    "Rodent",
    "GENERAL",
    "Homeless Person Assistance",
    "Street Light Condition",
    "ELECTRIC",
    "Damaged Tree",
    "Noise - Helicopter",
]


def _holiday_years(start: datetime, end: datetime) -> list[int]:
    return list(range(start.year, end.year + 1))


def _format_soda_ts(dt: datetime) -> str:
    """Socrata $where expects ISO-like timestamps without timezone suffix."""
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def clean_record(record: dict) -> dict:
    clean = {}
    for key, value in record.items():
        if value is pd.NaT:
            clean[key] = None
        elif isinstance(value, pd.Timestamp):
            clean[key] = value.to_pydatetime()
        elif isinstance(value, float) and math.isnan(value):
            clean[key] = None
        elif hasattr(value, "item"):
            clean[key] = value.item()
        else:
            clean[key] = value
    return clean


def _auth_headers(token: str | None) -> dict[str, str]:
    """Socrata app token via header avoids $$app_token query-string encoding quirks."""
    return {"X-App-Token": token} if token else {}


def _resolve_auth_token(token: str | None) -> str | None:
    """Return token if accepted by NYC Open Data; otherwise None (unauthenticated)."""
    if not token:
        return None
    try:
        resp = requests.get(
            URL,
            params={"$limit": 1},
            headers=_auth_headers(token),
            timeout=30,
        )
    except requests.RequestException as exc:
        print(f"WARNING: APP_TOKEN probe failed ({exc}); continuing without authentication")
        return None
    if resp.status_code == 403 and "Invalid app_token" in resp.text:
        masked = f"{token[:4]}...{token[-4:]}" if len(token) >= 8 else "(short)"
        prepared = requests.Request(
            "GET", URL, params={"$limit": 1, "$$app_token": token}
        ).prepare()
        debug_url = prepared.url.replace(token, masked)
        print(
            "WARNING: APP_TOKEN rejected by NYC Open Data (Invalid app_token); "
            "continuing without authentication (lower rate limits)"
        )
        print(f"  Debug URL ($$app_token param): {debug_url}")
        return None
    if not resp.ok:
        print(f"WARNING: APP_TOKEN probe returned HTTP {resp.status_code}; continuing without authentication")
        return None
    print("APP_TOKEN accepted (X-App-Token header)")
    return token


def safe_get(url: str, params: dict, headers: dict | None = None, retries: int = 5):
    req_headers = headers or {}
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, params=params, headers=req_headers, timeout=TIMEOUT)
            resp.raise_for_status()
            return resp
        except requests.exceptions.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else "?"
            body = (exc.response.text[:300] if exc.response is not None else str(exc))
            print(f"Attempt {attempt}/{retries} failed -> HTTP {status}: {body}")
            if attempt < retries:
                print(f"Retrying in {RETRY_WAIT}s...")
                time.sleep(RETRY_WAIT)
            else:
                print("All retries exhausted.")
                return None
        except (
            requests.exceptions.Timeout,
            requests.exceptions.ConnectionError,
            requests.exceptions.ChunkedEncodingError,
            requests.exceptions.ReadTimeout,
        ) as exc:
            print(f"Attempt {attempt}/{retries} failed -> {type(exc).__name__}")
            if attempt < retries:
                print(f"Retrying in {RETRY_WAIT}s...")
                time.sleep(RETRY_WAIT)
            else:
                print("All retries exhausted.")
                return None
    return None


INGEST_DATE_STREAMS = (
    ("created_date", "created_date"),
    ("closed_date", "closed_date"),
    ("resolution_action_updated_date", "resolution_action_updated_date"),
)
MAX_CONSECUTIVE_FAILURES = 3


def _fetch_date_stream(
    token: str | None,
    soda_field: str,
    window_start: datetime,
    seen_keys: set[str],
) -> tuple[list[dict], int, int]:
    """Paginate one date-field stream; dedupe by unique_key within the run."""
    ts = _format_soda_ts(window_start)
    where_clause = f"{soda_field} >= '{ts}'"
    offset = 0
    consecutive_failures = 0
    fetched = 0
    dropped_dupes = 0
    records: list[dict] = []

    while True:
        params = {
            "$where": where_clause,
            "$select": FIELDS,
            "$order": f"{soda_field} ASC",
            "$limit": CHUNK_SIZE,
            "$offset": offset,
        }
        if token:
            resp = safe_get(URL, params, headers=_auth_headers(token))
        else:
            resp = safe_get(URL, params)
        if resp is None:
            consecutive_failures += 1
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                raise RuntimeError(
                    f"Ingest failed on {soda_field} stream at offset {offset:,} "
                    f"after {MAX_CONSECUTIVE_FAILURES} consecutive API failures"
                )
            offset += CHUNK_SIZE
            continue

        consecutive_failures = 0
        batch = resp.json()
        if not batch:
            break

        for record in batch:
            key = record.get("unique_key")
            if not key or key in seen_keys:
                if key:
                    dropped_dupes += 1
                continue
            seen_keys.add(key)
            records.append(record)
            fetched += 1

        offset += CHUNK_SIZE
        if len(batch) < CHUNK_SIZE:
            break

    return records, fetched, dropped_dupes


def clean_chunk(batch: list, top_30: list[str], ny_holidays) -> pd.DataFrame:
    df = pd.DataFrame(batch)

    df["created_date"] = pd.to_datetime(df.get("created_date"), errors="coerce")
    df["closed_date"] = pd.to_datetime(df.get("closed_date"), errors="coerce")
    if "resolution_action_updated_date" in df.columns:
        df["resolution_action_updated_date"] = pd.to_datetime(
            df["resolution_action_updated_date"], errors="coerce"
        )

    df = df.dropna(subset=["created_date", "latitude", "longitude", "incident_zip"])

    df["latitude"] = pd.to_numeric(df["latitude"], errors="coerce")
    df["longitude"] = pd.to_numeric(df["longitude"], errors="coerce")
    df = df[
        df["latitude"].between(40.4, 40.95)
        & df["longitude"].between(-74.3, -73.6)
    ]

    df["incident_zip"] = df["incident_zip"].astype(str).str[:5]
    df["borough"] = df["borough"].fillna("").astype(str).str.title()
    df["complaint_type"] = df["complaint_type"].fillna("").astype(str).str.strip()
    df = df[df["complaint_type"].isin(top_30)]

    if df.empty:
        return df

    df["response_hours"] = (df["closed_date"] - df["created_date"]).dt.total_seconds() / 3600
    df = df[~((df["response_hours"] < 0) | (df["response_hours"] > 8760))]

    df["is_unresolved"] = df["status"].isin(["Open", "Pending"]).astype(int)
    df["year"] = df["created_date"].dt.year
    df["month"] = df["created_date"].dt.month
    df["day_of_week"] = df["created_date"].dt.dayofweek
    df["hour"] = df["created_date"].dt.hour
    df["is_weekend"] = (df["day_of_week"] >= 5).astype(int)
    df["is_holiday"] = df["created_date"].dt.date.apply(lambda x: 1 if x in ny_holidays else 0)
    df["season"] = df["month"].map({
        12: "Winter", 1: "Winter", 2: "Winter",
        3: "Spring", 4: "Spring", 5: "Spring",
        6: "Summer", 7: "Summer", 8: "Summer",
        9: "Fall", 10: "Fall", 11: "Fall",
    })

    urgent_keywords = [
        "emergency", "dangerous", "hazard", "flooding",
        "collapsed", "broken", "exposed wire", "fire",
        "sewage", "gas leak",
    ]
    df["descriptor_clean"] = df["descriptor"].fillna("").astype(str).str.lower()
    df["urgency_score"] = df["descriptor_clean"].apply(
        lambda text: sum(1 for word in urgent_keywords if word in text)
    )

    vague_keywords = [
        "unable to investigate", "no access", "undeliverable", "no response",
    ]
    df["resolution_clean"] = df["resolution_description"].fillna("").astype(str).str.lower()
    df["is_vague_resolution"] = df["resolution_clean"].apply(
        lambda text: 1 if any(word in text for word in vague_keywords) else 0
    )

    return df.drop(columns=["descriptor_clean", "resolution_clean"], errors="ignore")


def run_ingest(
    *,
    days: int = 3,
    dry_run: bool = False,
    mongo_uri: str | None = None,
    db_name: str | None = None,
    collection_name: str | None = None,
    app_token: str | None = None,
) -> dict:
    """Fetch incremental window from NYC Open Data and upsert into MongoDB."""
    raw_token = app_token if app_token is not None else APP_TOKEN
    token = _resolve_auth_token(raw_token)

    uri = mongo_uri or MONGO_URI
    db = db_name or DB_NAME
    coll_name = collection_name or COLLECTION

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    window_start = now - timedelta(days=days)
    ny_holidays = holidays.US(state="NY", years=_holiday_years(window_start, now))

    print(f"Incremental ingest window: last {days} day(s) from {_format_soda_ts(window_start)}")
    print(
        "Query streams: created_date, closed_date, resolution_action_updated_date "
        "(deduped by unique_key)"
    )
    print(f"MongoDB target: {db}.{coll_name}" + (" (DRY RUN — no writes)" if dry_run else ""))

    client = MongoClient(uri)
    collection = client[db][coll_name]

    seen_keys: set[str] = set()
    total_upserted = 0
    total_inserted = 0
    total_updated = 0
    total_dropped = 0
    total_raw = 0
    stream_counts: dict[str, int] = {}
    start_time = time.time()

    for label, soda_field in INGEST_DATE_STREAMS:
        print(f"\nFetching stream: {label} >= {_format_soda_ts(window_start)}")
        stream_records, stream_fetched, stream_dupes = _fetch_date_stream(
            token, soda_field, window_start, seen_keys
        )
        stream_counts[label] = stream_fetched
        print(
            f"  {label}: {stream_fetched:,} unique records "
            f"({stream_dupes:,} cross-stream dupes skipped)"
        )

        if not stream_records:
            continue

        cleaned = clean_chunk(stream_records, TOP_30_TYPES, ny_holidays)
        total_raw += len(stream_records)
        if not cleaned.empty and not dry_run:
            records = [clean_record(row) for row in cleaned.to_dict(orient="records")]
            ops = [
                UpdateOne(
                    {"unique_key": record["unique_key"]},
                    {"$set": record},
                    upsert=True,
                )
                for record in records
                if record.get("unique_key")
            ]
            if ops:
                result = collection.bulk_write(ops, ordered=False)
                total_inserted += result.upserted_count
                total_updated += result.modified_count
                total_upserted += result.upserted_count + result.modified_count
        elif not cleaned.empty and dry_run:
            total_upserted += len(cleaned)

        total_dropped += len(stream_records) - len(cleaned)
        elapsed = (time.time() - start_time) / 60
        print(
            f"  Running totals | Upserted: {total_upserted:>8,} | "
            f"Dropped: {total_dropped:>8,} | Time: {elapsed:.1f} min"
        )

    if not dry_run:
        print("\nEnsuring indexes...")
        collection.create_index("unique_key")
        collection.create_index("incident_zip")
        collection.create_index("created_date")
        collection.create_index("complaint_type")
        collection.create_index("borough")
        collection.create_index("agency")
        collection.create_index("is_unresolved")
        collection.create_index([("latitude", 1), ("longitude", 1)])
        collection.create_index([("agency", 1), ("created_date", 1)])

    elapsed_s = time.time() - start_time
    stats = {
        "days": days,
        "window_start": _format_soda_ts(window_start),
        "stream_counts": stream_counts,
        "unique_keys_seen": len(seen_keys),
        "records_upserted": total_upserted,
        "records_inserted": total_inserted,
        "records_updated": total_updated,
        "records_dropped": total_dropped,
        "records_raw": total_raw,
        "elapsed_s": round(elapsed_s, 2),
        "dry_run": dry_run,
    }
    print(f"Ingest complete: {stats}")
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Incremental NYC 311 ingest into MongoDB")
    parser.add_argument(
        "--days",
        type=int,
        default=int(os.environ.get("INGEST_DAYS", "3")),
        help="Lookback window in days (default: 3)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes"),
        help="Fetch and clean without writing to MongoDB",
    )
    args = parser.parse_args()

    try:
        run_ingest(days=args.days, dry_run=args.dry_run)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
