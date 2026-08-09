# Civic Lens

## Description

Civic Lens is a visual analytics system for NYC 311 service requests. It helps users understand not only how many complaints are submitted, but also how long requests take to resolve, which neighborhoods experience delays, which complaint types repeat, and what factors drive predicted service delay.

The system combines end-to-end data processing, machine learning, and interactive visualization. Raw NYC 311 records are cleaned and stored in **MongoDB**. A **CatBoost** regression model predicts response time for open requests, and **SHAP** values provide request-level explanations of those predictions. The **React** frontend presents three linked views—**Dashboard**, **Map**, and **Model Explanation**—built with **D3.js**, **Recharts**, and **Leaflet**, backed by a **Node.js/Express** API with server-side filtering and indexed MongoDB queries.

Civic Lens is designed for **residents**, **city agencies**, **urban planners**, and **community groups** who want to explore service burden, compare boroughs and complaint types, inspect spatial patterns, and understand why certain open requests are predicted to take longer than others.

---

## Repository Structure

```
CivicLens/
├── civic-lens-frontend/     # React + Vite UI (Dashboard, Map, Model views)
│   └── src/
│       ├── api/             # API fetch helpers
│       ├── components/      # D3, Recharts, and Leaflet visualizations
│       ├── context/         # Shared filter state
│       ├── hooks/           # Data-fetching hooks
│       └── pages/           # Home, Dashboard, Map, Model
├── backend/                 # Node.js + Express API
│   ├── controllers/         # Route handlers
│   ├── ML/                  # CatBoost Python inference (predict_batch.py)
│   ├── models/              # Mongoose schemas
│   ├── routes/              # REST API routes
│   ├── services/            # Aggregations, facets, predictions
│   └── utils/               # Query filters, delay buckets, normalization
├── preprocessing-training/  # Download, cleaning, features, training, MongoDB prediction/SHAP storage
├── data/                    # Local folder for intermediate/processed files (not committed)
├── package.json             # Root scripts to run frontend + backend together
└── README.md
```

| Folder | Purpose |
|--------|---------|
| `civic-lens-frontend/` | Interactive UI, filters, charts, and map |
| `backend/` | REST API, MongoDB access, optional live ML inference |
| `backend/ML/` | CatBoost batch prediction script used by the API |
| `preprocessing-training/` | Data download, preprocessing, feature engineering, model training, prediction + SHAP storage in MongoDB |
| `data/` | Placeholder for large local parquet/JSON outputs (not in GitHub) |

The processed dataset is **too large for GitHub** and is shared as a compressed ZIP through **Box**.

---

## Installation

### Prerequisites

- **Node.js** 18+
- **MongoDB** (local instance)
- **Python 3.10+** (only for full reproduction from NYC Open Data or live ML inference)

### Common Setup

1. **Clone the repository.**

   ```bash
   git clone <PASTE_GITHUB_REPO_URL_HERE>
   cd CivicLens
   ```

2. **Install backend dependencies.**

   ```bash
   cd backend
   npm install
   cd ..
   ```

   Or from the project root:

   ```bash
   npm run install:all
   ```

3. **Install frontend dependencies.**

   ```bash
   cd civic-lens-frontend
   npm install
   cd ..
   ```

   *(Skipped if you already ran `npm run install:all` from the root.)*

4. **Download the processed data from Box and import it into local MongoDB** — see [Data Setup: Processed 2026 Data From Box](#data-setup-processed-2026-data-from-box).

5. **Create or update `backend/.env` for local MongoDB.**

   ```bash
   cp backend/.env.example backend/.env
   ```

   ```env
   MONGODB_URI=mongodb://127.0.0.1:27017
   DB_NAME=civic_lens
   PORT=5001
   APP_TOKEN=<YOUR_NYC_OPEN_DATA_APP_TOKEN>
   ```

   `APP_TOKEN` is only needed if you plan to run data download or preprocessing scripts. It is **not required** to run the dashboard with the Box data.

6. **Start the backend and frontend.**

   From the project root:

   ```bash
   npm install          # root dev tools (concurrently), if not done yet
   npm run dev
   ```

   Or separately:

   ```bash
   cd backend
   npm run dev
   ```

   ```bash
   cd civic-lens-frontend
   npm run dev
   ```

   Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api/*` to the backend during development.

   Verify the API:

   ```bash
   curl http://localhost:5001/api/health
   ```

### Environment variables

| Variable | Description |
|----------|-------------|
| `MONGODB_URI` | Local MongoDB connection string (default: `mongodb://127.0.0.1:27017`) |
| `DB_NAME` | Database name (default: `civic_lens`) |
| `PORT` | API port (default: `5001`) |
| `APP_TOKEN` | NYC Open Data app token — required only for full reproduction scripts |

---

## Data Setup: Processed 2026 Data From Box

This is the **recommended demo path** for running Civic Lens.

The processed 2026 NYC 311 dataset used for the demo is shared through **UC Davis Box** because it is too large to include directly in GitHub. The dataset contains about **1.5 million records**.

Download the preprocessed data ZIP here:

https://ucdavis.box.com/s/grxfjjo1uoc7y8w5htuwuzj4oh89utle

**Steps:**

1. **Download the ZIP** from the Box link above.
2. **Extract the ZIP.**
3. **Start local MongoDB and import the data.**

   You can use either **MongoDB Compass** or the command line.

   **Option A: MongoDB Compass**

   1. Open MongoDB Compass.
   2. Connect using:

      ```text
      mongodb://127.0.0.1:27017
      ```

   3. Click **Create Database**.
   4. Use:

      ```text
      Database Name: civic_lens
      Collection Name: requests_clean
      ```

   5. Open the `requests_clean` collection.
   6. Click **Add Data → Import JSON or CSV file**.
   7. Select the extracted file:

      ```text
      nyc_311_2026.json
      ```

   8. Choose **JSON** and start the import.

   **Option B: Command line**

   Make sure MongoDB is running locally, then run:

   ```bash
   mongoimport --db civic_lens --collection requests_clean --file nyc_311_2026.json
   ```

   > This JSON file is expected to be newline-delimited JSON from `mongoexport`, so `--jsonArray` is not needed. If the file is inside an extracted folder, run the command from that folder or provide the full file path.

4. **Create `backend/.env`:**

   ```env
   MONGODB_URI=mongodb://127.0.0.1:27017
   DB_NAME=civic_lens
   PORT=5001
   APP_TOKEN=<YOUR_NYC_OPEN_DATA_APP_TOKEN>
   ```

   `APP_TOKEN` is optional for running the dashboard with the Box data, but required if you want to rerun the NYC Open Data download/preprocessing scripts.

5. **Start the backend and frontend:**

   From the project root:

   ```bash
   npm run dev
   ```

   Or separately:

   ```bash
   cd backend
   npm run dev
   ```

   ```bash
   cd civic-lens-frontend
   npm run dev
   ```

6. **Open** [http://localhost:5173](http://localhost:5173) and explore the **Dashboard**, **Map**, and **Model Explanation** views.

---

## Full Reproduction From Original NYC Open Data

This section is **optional**. Use it only if you want to download the original NYC 311 data yourself and repeat preprocessing, feature engineering, model training, prediction generation, and SHAP explanation generation.

Original data source: [NYC Open Data 311 Service Requests](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9).

Scripts live in `preprocessing-training/`:

| Script | Purpose |
|--------|---------|
| `ingest.py` | Download, clean, and upsert NYC 311 records into MongoDB |
| `export_feature_stats.py` | One-time export of lookup maps + medians into `feature_stats_full.pkl` |
| `training.py` | CatBoost training on p95 winsorized parquet (research path — see below) |
| `store-prediction-mongodb.py` | Run inference on open requests, compute SHAP values, and write predictions + explanations into `requests_clean` |

**Python dependencies** (from repo root):

```bash
pip install -r backend/ML/requirements.txt
```

**Steps:**

1. Get an NYC Open Data app token.
2. Add it to `backend/.env` as `APP_TOKEN` (and `MONGODB_URI` / `DB_NAME` if not using defaults).
3. Start local MongoDB using MongoDB Compass or your system's MongoDB service.
4. Run `python preprocessing-training/ingest.py` to download and upsert NYC 311 records.
5. Run `python preprocessing-training/store-prediction-mongodb.py` to generate predictions and SHAP explanations and store them in MongoDB (`requests_clean`).
6. Verify enriched records in MongoDB.
7. Start the backend and frontend (`npm run dev` from the project root).

> Model artifacts ship in `backend/models/` (`catboost_model_2024_2025.pkl` + `feature_stats_full.pkl`). No external parquet or VA/Project paths are required for inference.

### Deployed model vs. training.py (p90 vs. p95)

| Artifact | Winsorization | Used for |
|----------|---------------|----------|
| `backend/models/catboost_model_2024_2025.pkl` | **p90** (~231 h train cap) | **Production inference** (`store-prediction-mongodb.py`) and dashboard |
| `backend/models/feature_stats_full.pkl` | Lookup maps from p90 train split | Inference fallbacks + calibration bands |
| `training.py` output (`catboost_model_2024_2025_p95.pkl`) | **p95** (~591 h train cap) | Research / retraining only — **not deployed** |

Reported bucket-accuracy metrics (especially **7+ Days** recall) in project documentation came from the **p90 deployed model**. Running `training.py` does not reproduce those artifacts or metrics.

> This path may take significant time and disk space because the NYC 311 dataset is large. For a faster review, use the [Box data setup](#data-setup-processed-2026-data-from-box).

---

## Functionality

Civic Lens supports:

- **City-level service burden overview** — KPIs, borough burden choropleth, complaint driver rankings
- **Borough / complaint / agency / status / delay-bucket filtering** — cascading filters with server-side MongoDB queries
- **Interactive map** — NYC request markers colored by delay bucket or complaint type; click open requests to jump to model explanation
- **Delay bucket visualization** — Same Day, 1–3 Days, 3–7 Days, More than 1 Week (predicted buckets for open requests, actual buckets for closed)
- **Request-level prediction** — CatBoost predicted response hours for open/unresolved requests
- **SHAP-based model explanation** — Waterfall chart of features that increase or decrease predicted delay
- **Linked views** — Dashboard filters seed the map on first load; map maintains its own filter state after user interaction
- **Responsive querying** — MongoDB indexing, aggregation caching, and debounced API filtering (~300ms)

**D3.js** is used for the major custom visualizations (borough choropleth, complaint ranking bars, SHAP waterfall). **Recharts** powers the delay timeline; **Leaflet** powers the map.

---

## Model and Data Notes

- **Target:** CatBoost predicts `log(1 + response_hours)` and converts back to hours for display.
- **Features:** Agency, ZIP, borough, complaint type, channel, time (month, hour, day of week, season), holiday/weekend flags, urgency score, agency workload, and historical median delay features.
- **Precomputed predictions:** Predictions and SHAP values are stored in MongoDB so the frontend stays fast at scale.
- **Open vs. closed:** Open requests (`is_unresolved = 1`) show predicted delay buckets and ML explanations. Closed requests use **actual** delay buckets from `response_hours`.
- **Showcase year:** The API filters to **2026** records by default (`SHOWCASE_YEAR` env var).

---

## Division of Labor

Work was divided **equally** between both team members:

- **Prasannadatta Kawadkar**
- **Hetvi Sanjaybhai Bhadani**

Both contributed to data preprocessing, backend/API development, model integration, frontend dashboard and visualization design, map and model explanation views, testing, documentation, and final demo preparation.



---

## Submission Note

This GitHub repository contains **source code**, **preprocessing/model scripts**, and **setup instructions**. Large processed data files are shared through **Box** instead of being committed to GitHub, following the course submission guidelines.

---

## Course

Built for **ECS 273** at UC Davis.
