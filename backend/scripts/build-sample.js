#!/usr/bin/env node
/**
 * Build a stratified Atlas-sized sample in requests_sample from requests_clean.
 *
 * IMPORTANT — field trimming on closed/plain records strips `hour`, `community_board`,
 * and all ML fields. Those records cannot be re-featurized on Atlas without recomputing
 * derived fields from created_date (and re-running the feature pipeline).
 *
 * The sample is 2026-only for map/case-list detail. A separate late-Dec resolved
 * workload_history slice (~5k) supports early-January lookbacks for batch prediction.
 *
 * monthly_rollups is NOT rebuilt here — keep rollups from the full 9.2M corpus so the
 * dashboard reports real NYC totals while map/case-list use this sample.
 *
 * Usage:
 *   node scripts/build-sample.js
 *   node scripts/build-sample.js --shap-count 20000 --plain-count 275000
 *   node scripts/build-sample.js --export   # also run mongodump
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { DELAY_BUCKET_ORDER, DELAY_BUCKET_RANGES } from '../utils/delayBuckets.js';
import { getShowcaseYear } from '../utils/normalizeRequest.js';
import { ensureRequestIndexes } from '../services/ensureIndexes.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONGO = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'civic_lens';
const SOURCE = 'requests_clean';
const TARGET = 'requests_sample';

const DEFAULT_SHAP_COUNT = 20000;
const DEFAULT_PLAIN_COUNT = 275000;
const DEFAULT_WORKLOAD_HISTORY_COUNT = 5000;
const HEAT_CAP_FRACTION = 0.25;
const BATCH = 500;

const BOROUGHS = ['Bronx', 'Brooklyn', 'Manhattan', 'Queens', 'Staten Island', 'Unspecified'];
const AGENCIES = ['DEP', 'DHS', 'DOB', 'DOHMH', 'DOT', 'DPR', 'DSNY', 'EDC', 'HPD', 'NYC311-PRD', 'NYPD'];
const STATUSES = ['Closed', 'Open', 'In Progress', 'Assigned', 'Pending', 'Started', 'Unspecified'];
const MONTHS = [1, 2, 3, 4, 5];

/** Closed-record borough shares (2026 source). */
const PLAIN_BOROUGH_SHARE = {
  Brooklyn: 0.3194,
  Queens: 0.2418,
  Bronx: 0.2153,
  Manhattan: 0.1880,
  'Staten Island': 0.0354,
  Unspecified: 0.00005,
};

/** Month shares within showcase year (Jan–May 2026 in source). */
const MONTH_SHARE = {
  1: 0.2239,
  2: 0.2165,
  3: 0.2415,
  4: 0.1852,
  5: 0.1328,
};

/** ML+SHAP borough shares (2026 source). */
const SHAP_BOROUGH_SHARE = {
  Bronx: 0.3649,
  Brooklyn: 0.2650,
  Manhattan: 0.2017,
  Queens: 0.1530,
  'Staten Island': 0.0151,
  Unspecified: 0.0001,
};

/** Predicted delay bucket shares (ML pool, 2026). */
const SHAP_BUCKET_SHARE = {
  'Same Day': 0.0297,
  '1–3 Days': 0.3174,
  '3–7 Days': 0.1433,
  'More than 1 Week': 0.5096,
};

const PLAIN_STRIP_FIELDS = [
  'shap_explanation',
  'model_features',
  'predicted_response_hours',
  'predicted_delay_bucket',
  'predicted_bucket',
  'prediction_risk_level',
  'delay_risk_score',
  'delay_tier',
  'prediction_confidence',
  'prediction_model',
  'prediction_scope',
  'prediction_generated_at',
  'model_version',
  'community_board',
  'hour',
  'predicted_response_hours_raw',
];

const SHAP_STRIP_FIELDS = [
  'community_board',
  'hour',
  'predicted_response_hours_raw',
  'prediction_scope',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const readNum = (flag, fallback) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return Number(eq.split('=')[1]);
    const idx = args.indexOf(flag);
    if (idx >= 0 && args[idx + 1]) return Number(args[idx + 1]);
    return fallback;
  };
  return {
    shapCount: readNum('--shap-count', DEFAULT_SHAP_COUNT),
    plainCount: readNum('--plain-count', DEFAULT_PLAIN_COUNT),
    workloadHistoryCount: readNum('--workload-history-count', DEFAULT_WORKLOAD_HISTORY_COUNT),
    exportDump: args.includes('--export'),
  };
}

function showcaseFilter(year) {
  return {
    created_date: {
      $gte: new Date(Date.UTC(year, 0, 1)),
      $lt: new Date(Date.UTC(year + 1, 0, 1)),
    },
  };
}

function shapPoolMatch(base) {
  return {
    ...base,
    $or: [{ is_unresolved: 1 }, { status: 'Open' }],
    predicted_response_hours: { $gt: 0 },
    shap_explanation: { $exists: true, $ne: null },
    'shap_explanation.top_features.0': { $exists: true },
  };
}

function plainPoolMatch(base) {
  return {
    ...base,
    $nor: [{ shap_explanation: { $exists: true, $ne: null } }],
  };
}

function trimDocument(doc, tier) {
  const out = { ...doc };
  delete out._id;
  if (tier === 'workload') {
    PLAIN_STRIP_FIELDS.forEach((key) => delete out[key]);
    out.sample_role = 'workload_history';
    return out;
  }
  const strip = tier === 'shap' ? SHAP_STRIP_FIELDS : PLAIN_STRIP_FIELDS;
  strip.forEach((key) => delete out[key]);
  return out;
}

function allocateProportional(total, shares) {
  const keys = Object.keys(shares);
  const raw = keys.map((key) => ({
    key,
    exact: total * shares[key],
    count: Math.floor(total * shares[key]),
  }));
  let assigned = raw.reduce((sum, row) => sum + row.count, 0);
  const byRemainder = [...raw].sort((a, b) => (b.exact - b.count) - (a.exact - a.count));
  for (const row of byRemainder) {
    if (assigned >= total) break;
    row.count += 1;
    assigned += 1;
  }
  return Object.fromEntries(raw.map((row) => [row.key, row.count]));
}

function buildPlainStrata(plainBudget) {
  const boroughTotals = allocateProportional(plainBudget, PLAIN_BOROUGH_SHARE);
  const strata = [];
  for (const borough of BOROUGHS) {
    const boroughTotal = boroughTotals[borough] ?? 0;
    const monthCounts = allocateProportional(boroughTotal, MONTH_SHARE);
    for (const month of MONTHS) {
      const count = monthCounts[month] ?? 0;
      if (count > 0) {
        strata.push({ borough, month, count });
      }
    }
  }
  return strata;
}

function buildShapStrata(shapBudget) {
  const boroughTotals = allocateProportional(shapBudget, SHAP_BOROUGH_SHARE);
  const strata = [];
  for (const borough of BOROUGHS) {
    const boroughTotal = boroughTotals[borough] ?? 0;
    const bucketCounts = allocateProportional(boroughTotal, SHAP_BUCKET_SHARE);
    for (const bucket of DELAY_BUCKET_ORDER) {
      const count = bucketCounts[bucket] ?? 0;
      if (count > 0) {
        strata.push({ borough, bucket, count });
      }
    }
  }
  return strata;
}

async function sampleStratum(collection, match, size, excludeKeys) {
  if (size <= 0) return [];
  const pipeline = [
    {
      $match: {
        ...match,
        ...(excludeKeys.size ? { unique_key: { $nin: [...excludeKeys] } } : {}),
      },
    },
    { $sample: { size } },
  ];
  return collection.aggregate(pipeline).toArray();
}

async function existingPairs(collection, baseMatch, fields) {
  const [a, b] = fields;
  const rows = await collection.aggregate([
    { $match: baseMatch },
    { $group: { _id: { a: `$${a}`, b: `$${b}` } } },
  ]).toArray();
  return rows
    .map((row) => ({ [a]: row._id.a, [b]: row._id.b }))
    .filter((row) => row[a] && row[b]);
}

async function collectSeeds(source, base, shapMatch, plainMatch) {
  const selected = new Map();
  const exclude = () => new Set(selected.keys());

  async function tryAdd(match, poolMatch, tier) {
    const doc = await source.findOne({
      ...poolMatch,
      ...match,
      unique_key: { $nin: [...exclude()] },
    });
    if (!doc) return false;
    selected.set(doc.unique_key, { doc, tier });
    return true;
  }

  const complaints = await source.distinct('complaint_type', base);
  const plainBase = plainPoolMatch(base);

  console.log('Phase 0: facet guarantee seeds...');

  for (const borough of BOROUGHS) await tryAdd({ borough }, plainBase, 'plain');
  for (const agency of AGENCIES) await tryAdd({ agency }, plainBase, 'plain');
  for (const complaint_type of complaints) await tryAdd({ complaint_type }, plainBase, 'plain');

  for (const status of STATUSES) {
    if (status === 'Open') {
      await tryAdd({ status: 'Open' }, shapMatch, 'shap');
    } else if (status === 'Closed') {
      await tryAdd({ is_unresolved: 0 }, plainBase, 'plain');
    } else {
      await tryAdd({ status }, plainBase, 'plain');
    }
  }

  const baPairs = await existingPairs(source, plainBase, ['borough', 'agency']);
  for (const pair of baPairs) {
    await tryAdd(pair, plainBase, 'plain');
  }

  const bcPairs = await existingPairs(source, plainBase, ['borough', 'complaint_type']);
  for (const pair of bcPairs) {
    await tryAdd(pair, plainBase, 'plain');
  }

  const acPairs = await existingPairs(source, plainBase, ['agency', 'complaint_type']);
  for (const pair of acPairs) {
    await tryAdd(pair, plainBase, 'plain');
  }

  for (const bucket of DELAY_BUCKET_ORDER) {
    await tryAdd(
      { predicted_response_hours: DELAY_BUCKET_RANGES[bucket] },
      shapMatch,
      'shap',
    );
  }

  const shapSeeds = [...selected.values()].filter((row) => row.tier === 'shap');
  const plainSeeds = [...selected.values()].filter((row) => row.tier === 'plain');
  console.log(`  seeds: ${selected.size} unique (${shapSeeds.length} shap, ${plainSeeds.length} plain)`);
  return { selected, shapSeeds, plainSeeds };
}

async function fillShapTier(source, shapMatch, shapBudget, seedKeys) {
  const excludeKeys = new Set(seedKeys);
  const strata = buildShapStrata(Math.max(0, shapBudget));
  const docs = [];
  console.log(`Phase 1: SHAP tier — ${shapBudget} target across ${strata.length} strata...`);

  for (const stratum of strata) {
    const match = {
      ...shapMatch,
      borough: stratum.borough,
      predicted_response_hours: DELAY_BUCKET_RANGES[stratum.bucket],
    };
    const batch = await sampleStratum(source, match, stratum.count, excludeKeys);
    for (const doc of batch) {
      if (!excludeKeys.has(doc.unique_key)) {
        excludeKeys.add(doc.unique_key);
        docs.push(doc);
      }
    }
    if (docs.length && docs.length % 2000 === 0) {
      console.log(`  shap sampled ${docs.length.toLocaleString()}...`);
    }
  }
  return docs;
}

async function fillPlainTier(source, plainMatch, plainBudget, seedKeys) {
  const excludeKeys = new Set(seedKeys);
  const strata = buildPlainStrata(Math.max(0, plainBudget));
  const docs = [];
  console.log(`Phase 2: plain tier — ${plainBudget} target across ${strata.length} strata...`);

  for (const stratum of strata) {
    const match = {
      ...plainMatch,
      borough: stratum.borough,
      month: stratum.month,
    };
    const batch = await sampleStratum(source, match, stratum.count, excludeKeys);
    for (const doc of batch) {
      if (!excludeKeys.has(doc.unique_key)) {
        excludeKeys.add(doc.unique_key);
        docs.push(doc);
      }
    }
    if (docs.length && docs.length % 10000 === 0) {
      console.log(`  plain sampled ${docs.length.toLocaleString()}...`);
    }
  }
  return docs;
}

function enforceHeatCap(shapDocs, cap) {
  const heat = shapDocs.filter((d) => d.complaint_type === 'HEAT/HOT WATER');
  if (heat.length <= cap) return shapDocs;
  const dropKeys = new Set();
  const shuffled = [...heat].sort(() => Math.random() - 0.5);
  for (const doc of shuffled.slice(cap)) {
    dropKeys.add(doc.unique_key);
  }
  const kept = shapDocs.filter((d) => !dropKeys.has(d.unique_key));
  console.log(`  HEAT/HOT WATER cap: ${heat.length} → ${cap} (dropped ${dropKeys.size})`);
  return kept;
}

async function topUp(source, poolMatch, docs, targetCount, excludeExtra = []) {
  const keys = new Set([...docs.map((d) => d.unique_key), ...excludeExtra]);
  const deficit = targetCount - docs.length;
  if (deficit <= 0) return docs;
  console.log(`  topping up ${deficit.toLocaleString()} records...`);
  const extra = await sampleStratum(source, poolMatch, deficit, keys);
  const merged = [...docs];
  for (const doc of extra) {
    if (!keys.has(doc.unique_key)) {
      keys.add(doc.unique_key);
      merged.push(doc);
    }
  }
  return merged;
}

function workloadHistoryMatch(year) {
  // Late December (year-1) — reachable by 7-day lookbacks from early January in showcase year.
  return {
    created_date: {
      $gte: new Date(Date.UTC(year - 1, 11, 15)),
      $lt: new Date(Date.UTC(year, 0, 1)),
    },
    is_unresolved: 0,
  };
}

async function fillWorkloadHistory(source, year, budget, excludeKeys) {
  if (budget <= 0) return [];
  const match = workloadHistoryMatch(year);
  const perAgency = Math.max(1, Math.floor(budget / AGENCIES.length));
  const docs = [];
  const exclude = new Set(excludeKeys);
  console.log(`Phase 3: workload history — ${budget.toLocaleString()} late-Dec ${year - 1} resolved (stratified by agency)...`);

  for (const agency of AGENCIES) {
    const batch = await sampleStratum(
      source,
      { ...match, agency },
      perAgency,
      exclude,
    );
    for (const doc of batch) {
      if (!exclude.has(doc.unique_key)) {
        exclude.add(doc.unique_key);
        docs.push(doc);
      }
    }
  }

  return topUp(source, match, docs, budget, [...exclude]);
}

async function writeBatches(collection, docs, tier) {
  let written = 0;
  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH).map((doc) => trimDocument(doc, tier));
    if (batch.length) {
      await collection.insertMany(batch, { ordered: false });
      written += batch.length;
    }
  }
  return written;
}

function runMongodump(dbName, collection, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const uri = MONGO;
  const cmd = `mongodump --uri="${uri}" --db=${dbName} --collection=${collection} --out="${outDir}"`;
  console.log(`\nRunning mongodump → ${outDir}`);
  execSync(cmd, { stdio: 'inherit' });
}

async function main() {
  const started = Date.now();
  const { shapCount, plainCount, workloadHistoryCount, exportDump } = parseArgs();
  const year = getShowcaseYear();
  const base = showcaseFilter(year);
  const shapMatch = shapPoolMatch(base);
  const plainMatch = plainPoolMatch(base);

  console.log(`Building ${TARGET} from ${SOURCE} (showcase year ${year})`);
  console.log(`Targets: ${shapCount.toLocaleString()} SHAP + ${plainCount.toLocaleString()} plain + ${workloadHistoryCount.toLocaleString()} workload history`);

  await mongoose.connect(MONGO, { dbName: DB_NAME, autoIndex: false });
  const db = mongoose.connection.db;
  const source = db.collection(SOURCE);
  const target = db.collection(TARGET);

  console.log('\nClearing existing sample (idempotent rebuild)...');
  await target.drop().catch(() => target.deleteMany({}));

  const { selected, shapSeeds, plainSeeds } = await collectSeeds(source, base, shapMatch, plainMatch);
  const shapSeedDocs = shapSeeds.map((row) => row.doc);
  const plainSeedDocs = plainSeeds.map((row) => row.doc);
  const shapSeedKeys = new Set(shapSeedDocs.map((d) => d.unique_key));
  const plainSeedKeys = new Set(plainSeedDocs.map((d) => d.unique_key));

  const shapFillBudget = Math.max(0, shapCount - shapSeedDocs.length);
  const plainFillBudget = Math.max(0, plainCount - plainSeedDocs.length);

  let shapFill = await fillShapTier(source, shapMatch, shapFillBudget, shapSeedKeys);
  let shapDocs = [...shapSeedDocs, ...shapFill];
  shapDocs = enforceHeatCap(shapDocs, Math.floor(shapCount * HEAT_CAP_FRACTION));
  shapDocs = await topUp(source, shapMatch, shapDocs, shapCount);

  if (shapDocs.length > shapCount) {
    shapDocs = shapDocs.sort(() => Math.random() - 0.5).slice(0, shapCount);
  }

  const plainFill = await fillPlainTier(source, plainMatch, plainFillBudget, plainSeedKeys);
  let plainDocs = [...plainSeedDocs, ...plainFill];
  plainDocs = await topUp(source, plainMatch, plainDocs, plainCount, [...shapDocs.map((d) => d.unique_key)]);

  if (plainDocs.length > plainCount) {
    plainDocs = plainDocs.sort(() => Math.random() - 0.5).slice(0, plainCount);
  }

  console.log('\nWriting to requests_sample...');
  const shapWritten = await writeBatches(target, shapDocs, 'shap');
  const plainWritten = await writeBatches(target, plainDocs, 'plain');

  const allDetailKeys = [...shapDocs, ...plainDocs].map((d) => d.unique_key);
  const workloadDocs = await fillWorkloadHistory(source, year, workloadHistoryCount, allDetailKeys);
  const workloadWritten = await writeBatches(target, workloadDocs, 'workload');

  console.log(
    `  wrote ${shapWritten.toLocaleString()} SHAP + ${plainWritten.toLocaleString()} plain + ${workloadWritten.toLocaleString()} workload history`,
  );

  console.log('Creating indexes...');
  await ensureRequestIndexes(target);

  const collStats = await db.command({ collStats: TARGET });
  const rollupStats = await db.command({ collStats: 'monthly_rollups' }).catch(() => null);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('\n=== Sample build complete ===');
  console.log(`Tier counts:   ${shapWritten.toLocaleString()} SHAP + ${plainWritten.toLocaleString()} plain + ${workloadWritten.toLocaleString()} workload`);
  console.log(`Documents:     ${(collStats.count ?? 0).toLocaleString()}`);
  console.log(`Logical size:  ${((collStats.size ?? 0) / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Storage size:  ${((collStats.storageSize ?? 0) / 1024 / 1024).toFixed(2)} MB (on-disk, compressed)`);
  console.log(`Index size:    ${((collStats.totalIndexSize ?? 0) / 1024 / 1024).toFixed(2)} MB`);
  const sampleDisk = (collStats.storageSize ?? 0) + (collStats.totalIndexSize ?? 0);
  console.log(`Combined disk: ${(sampleDisk / 1024 / 1024).toFixed(2)} MB (storageSize + indexes)`);
  if (rollupStats) {
    const rollupDisk = (rollupStats.storageSize ?? 0) + (rollupStats.totalIndexSize ?? 0);
    console.log(`+ monthly_rollups: ${(rollupDisk / 1024 / 1024).toFixed(2)} MB (storageSize + indexes)`);
    console.log(`Atlas total est:   ${((rollupDisk + sampleDisk) / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log(`Elapsed:       ${elapsed}s`);

  if (exportDump) {
    const outDir = path.resolve(__dirname, '../dumps/sample-export');
    runMongodump(DB_NAME, TARGET, outDir);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
