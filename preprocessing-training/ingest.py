#!/usr/bin/env python3
"""Download NYC 311 data and upsert cleaned records into MongoDB."""

from __future__ import annotations

import math
import os
import sys
import time
from datetime import datetime

import holidays
import pandas as pd
import requests
from pymongo import MongoClient, ReplaceOne

MONGO_URI = os.environ.get("MONGODB_URI", os.environ.get("MONGO_URI", "mongodb://localhost:27017"))
DB_NAME = os.environ.get("DB_NAME", "civic_lens")
COLLECTION = "requests_clean"
APP_TOKEN = os.environ.get("APP_TOKEN")

START_DATE = os.environ.get("INGEST_START_DATE", "2026-01-01T00:00:00")
END_DATE = os.environ.get("INGEST_END_DATE", "2027-01-01T00:00:00")

CHUNK_SIZE = 50000
TIMEOUT = 180
RETRY_WAIT = 20

FIELDS = ",".join([
    "unique_key", "created_date", "closed_date", "agency", "agency_name",
    "complaint_type", "descriptor", "status", "resolution_description",
    "borough", "incident_zip", "incident_address",
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


def _holiday_years() -> list[int]:
    start_year = datetime.fromisoformat(START_DATE[:10]).year
    end_year = datetime.fromisoformat(END_DATE[:10]).year
    return list(range(start_year, end_year + 1))


NY_HOLIDAYS = holidays.US(state="NY", years=_holiday_years())


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


def safe_get(url: str, params: dict, retries: int = 5):
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, params=params, timeout=TIMEOUT)
            resp.raise_for_status()
            return resp
        except (
            requests.exceptions.Timeout,
            requests.exceptions.ConnectionError,
            requests.exceptions.ChunkedEncodingError,
            requests.exceptions.ReadTimeout,
            requests.exceptions.HTTPError,
        ) as exc:
            print(f"Attempt {attempt}/{retries} failed -> {type(exc).__name__}")
            if attempt < retries:
                print(f"Retrying in {RETRY_WAIT}s...")
                time.sleep(RETRY_WAIT)
            else:
                print("All retries exhausted.")
                return None
    return None


def clean_chunk(batch: list, top_30: list[str]) -> pd.DataFrame:
    df = pd.DataFrame(batch)

    df["created_date"] = pd.to_datetime(df.get("created_date"), errors="coerce")
    df["closed_date"] = pd.to_datetime(df.get("closed_date"), errors="coerce")

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
    df["is_holiday"] = df["created_date"].dt.date.apply(lambda x: 1 if x in NY_HOLIDAYS else 0)
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


def main() -> int:
    if not APP_TOKEN:
        print("APP_TOKEN is required (set in environment or backend/.env).", file=sys.stderr)
        return 1

    client = MongoClient(MONGO_URI)
    collection = client[DB_NAME][COLLECTION]

    print(f"Ingesting {START_DATE} -> {END_DATE}")
    print(f"MongoDB: {DB_NAME}.{COLLECTION}")

    offset = 0
    total_upserted = 0
    total_dropped = 0
    start_time = time.time()

    while True:
        params = {
            "$$app_token": APP_TOKEN,
            "$where": f"created_date >= '{START_DATE}' AND created_date < '{END_DATE}'",
            "$select": FIELDS,
            "$order": "created_date ASC",
            "$limit": CHUNK_SIZE,
            "$offset": offset,
        }
        resp = safe_get(URL, params)
        if resp is None:
            print(f"Skipping chunk at offset {offset:,}")
            offset += CHUNK_SIZE
            continue

        batch = resp.json()
        if not batch:
            break

        raw_count = len(batch)
        cleaned = clean_chunk(batch, TOP_30_TYPES)
        if not cleaned.empty:
            records = [clean_record(row) for row in cleaned.to_dict(orient="records")]
            ops = [
                ReplaceOne({"unique_key": record["unique_key"]}, record, upsert=True)
                for record in records
                if record.get("unique_key")
            ]
            if ops:
                result = collection.bulk_write(ops, ordered=False)
                total_upserted += result.upserted_count + result.modified_count

        total_dropped += raw_count - len(cleaned)
        offset += CHUNK_SIZE
        elapsed = (time.time() - start_time) / 60
        print(
            f"Offset: {offset:>9,} | Upserted: {total_upserted:>8,} | "
            f"Dropped: {total_dropped:>8,} | Time: {elapsed:.1f} min"
        )

    print("\nCreating indexes...")
    collection.create_index("unique_key")
    collection.create_index("incident_zip")
    collection.create_index("created_date")
    collection.create_index("complaint_type")
    collection.create_index("borough")
    collection.create_index("agency")
    collection.create_index("is_unresolved")
    collection.create_index([("latitude", 1), ("longitude", 1)])
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
