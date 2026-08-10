#!/usr/bin/env node
/**
 * Backfill monthly_rollups from requests_clean.
 *
 * Usage:
 *   node scripts/build-rollups.js              # all months
 *   node scripts/build-rollups.js --month 2026-03
 *
 * Idempotent: deletes and rebuilds rollups for the month(s) processed.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  HIGH_DELAY_PREDICTED_BUCKETS,
  ROLLUP_SLICE_PREFIXES,
  SLICE_METRIC_FIELDS,
  UNRESOLVED_STATUSES,
} from '../utils/rollupMetrics.js';

dotenv.config();

const MONGO = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'civic_lens';
const SOURCE = 'requests_clean';
const TARGET = 'monthly_rollups';

const monthArg = process.argv.find((arg) => arg.startsWith('--month='))?.split('=')[1]
  ?? (process.argv.includes('--month') ? process.argv[process.argv.indexOf('--month') + 1] : null);

const NUMERIC_TYPES = ['double', 'int', 'long', 'decimal'];

function hasNumericField(fieldExpr) {
  return { $in: [{ $type: fieldExpr }, NUMERIC_TYPES] };
}

function hoursInBucket(hoursExpr, min, max, exclusiveMin = true) {
  const lower = exclusiveMin
    ? { $gt: [hoursExpr, min] }
    : { $gte: [hoursExpr, min] };
  if (max == null) return lower;
  return { $and: [lower, { $lte: [hoursExpr, max] }] };
}

function buildSliceCondition(prefix) {
  const isOpen = { $eq: ['$is_unresolved', 1] };
  const isClosed = { $eq: ['$is_unresolved', 0] };
  const isMl = {
    $or: [isOpen, { $eq: ['$status', 'Open'] }],
  };
  const isPred72 = { $gte: ['$predicted_response_hours', 72] };
  const predSameDay = hoursInBucket('$predicted_response_hours', 0, 24);
  const pred1_3 = hoursInBucket('$predicted_response_hours', 24, 72);
  const pred3_7 = hoursInBucket('$predicted_response_hours', 72, 168);
  const pred7Plus = hoursInBucket('$predicted_response_hours', 168, null);
  const isHighDelay = {
    $or: [
      { $in: ['$predicted_delay_bucket', HIGH_DELAY_PREDICTED_BUCKETS] },
      isPred72,
    ],
  };
  const isUnresolvedCond = {
    $or: [
      isOpen,
      { $in: ['$status', UNRESOLVED_STATUSES] },
    ],
  };
  const isHighRisk = { $gte: ['$delay_risk_score', 0.75] };
  const respSameDay = hoursInBucket('$response_hours', 0, 24);
  const resp1_3 = hoursInBucket('$response_hours', 24, 72);
  const resp3_7 = hoursInBucket('$response_hours', 72, 168);
  const resp7Plus = hoursInBucket('$response_hours', 168, null);

  const base = {
    all: true,
    open: isOpen,
    closed: isClosed,
    ml: isMl,
    pred72: isPred72,
    open_pred72: { $and: [isOpen, isPred72] },
    closed_pred72: { $and: [isClosed, isPred72] },
    ml_pred72: { $and: [isMl, isPred72] },
    pred_b_same_day: predSameDay,
    pred_b_1_3: pred1_3,
    pred_b_3_7: pred3_7,
    pred_b_7_plus: pred7Plus,
    open_pred_b_same_day: { $and: [isOpen, predSameDay] },
    open_pred_b_1_3: { $and: [isOpen, pred1_3] },
    open_pred_b_3_7: { $and: [isOpen, pred3_7] },
    open_pred_b_7_plus: { $and: [isOpen, pred7Plus] },
    closed_pred_b_same_day: { $and: [isClosed, predSameDay] },
    closed_pred_b_1_3: { $and: [isClosed, pred1_3] },
    closed_pred_b_3_7: { $and: [isClosed, pred3_7] },
    closed_pred_b_7_plus: { $and: [isClosed, pred7Plus] },
    ml_pred_b_same_day: { $and: [isMl, predSameDay] },
    ml_pred_b_1_3: { $and: [isMl, pred1_3] },
    ml_pred_b_3_7: { $and: [isMl, pred3_7] },
    ml_pred_b_7_plus: { $and: [isMl, pred7Plus] },
  };
  return { condition: base[prefix], isHighDelay, isHighRisk, isUnresolvedCond, respSameDay, resp1_3, resp3_7, resp7Plus };
}

function metricAdd(field, conditionExpr, valueExpr = 1) {
  return { $sum: { $cond: [conditionExpr, valueExpr, 0] } };
}

function metricSum(field, conditionExpr) {
  return {
    $sum: {
      $cond: [conditionExpr, field, 0],
    },
  };
}

function buildGroupStage() {
  const group = {
    _id: {
      month: '$month',
      borough: '$borough',
      complaint_type: '$complaint_type',
      agency: '$agency',
    },
  };

  for (const prefix of ROLLUP_SLICE_PREFIXES) {
    const { condition, isHighDelay, isHighRisk, isUnresolvedCond, respSameDay, resp1_3, resp3_7, resp7Plus } = buildSliceCondition(prefix);
    const inSlice = condition === true ? { $gte: [1, 0] } : condition;
    const hasRh = { $and: [inSlice, { $eq: ['$has_response_hours', true] }] };
    const hasPh = { $and: [inSlice, { $eq: ['$has_predicted_hours', true] }] };
    const hasRk = { $and: [inSlice, { $eq: ['$has_risk_score', true] }] };
    group[`${prefix}_count`] = metricAdd('count', inSlice);
    group[`${prefix}_sum_response_hours`] = metricSum('$response_hours', hasRh);
    group[`${prefix}_response_hours_count`] = metricAdd('rh', hasRh);
    group[`${prefix}_sum_predicted_response_hours`] = metricSum('$predicted_response_hours', hasPh);
    group[`${prefix}_predicted_hours_count`] = metricAdd('ph', hasPh);
    group[`${prefix}_sum_delay_risk_score`] = metricSum('$delay_risk_score', hasRk);
    group[`${prefix}_risk_score_count`] = metricAdd('rk', hasRk);
    group[`${prefix}_high_delay_count`] = metricAdd('hd', { $and: [inSlice, isHighDelay] });
    group[`${prefix}_high_risk_count`] = metricAdd('hr', { $and: [inSlice, isHighRisk] });
    group[`${prefix}_unresolved_cond_count`] = metricAdd('uc', { $and: [inSlice, isUnresolvedCond] });
    group[`${prefix}_bucket_same_day`] = metricAdd('b0', { $and: [inSlice, respSameDay] });
    group[`${prefix}_bucket_1_3_days`] = metricAdd('b1', { $and: [inSlice, resp1_3] });
    group[`${prefix}_bucket_3_7_days`] = metricAdd('b2', { $and: [inSlice, resp3_7] });
    group[`${prefix}_bucket_7_plus_days`] = metricAdd('b3', { $and: [inSlice, resp7Plus] });
  }

  group.resolved_count = metricAdd('resolved', { $eq: ['$is_unresolved', 0] });
  group.unresolved_count = metricAdd('unresolved', {
    $or: [
      { $eq: ['$is_unresolved', 1] },
      { $in: ['$status', UNRESOLVED_STATUSES] },
    ],
  });

  return { $group: group };
}

function flattenGroupDoc(doc) {
  const out = {
    month: doc._id.month,
    borough: doc._id.borough,
    complaint_type: doc._id.complaint_type,
    agency: doc._id.agency,
    count: doc.all_count ?? 0,
    resolved_count: doc.resolved_count ?? 0,
    unresolved_count: doc.unresolved_count ?? 0,
    sum_response_hours: doc.all_sum_response_hours ?? 0,
    high_delay_count: doc.all_high_delay_count ?? 0,
    bucket_same_day: doc.all_bucket_same_day ?? 0,
    bucket_1_3_days: doc.all_bucket_1_3_days ?? 0,
    bucket_3_7_days: doc.all_bucket_3_7_days ?? 0,
    bucket_7_plus_days: doc.all_bucket_7_plus_days ?? 0,
  };
  for (const prefix of ROLLUP_SLICE_PREFIXES) {
    for (const field of SLICE_METRIC_FIELDS) {
      out[`${prefix}_${field}`] = doc[`${prefix}_${field}`] ?? 0;
    }
  }
  return out;
}

async function ensureRollupIndexes(collection) {
  await Promise.all([
    collection.createIndex({ month: 1 }),
    collection.createIndex({ month: 1, borough: 1 }),
    collection.createIndex({ month: 1, agency: 1 }),
    collection.createIndex({ month: 1, complaint_type: 1 }),
    collection.createIndex(
      { month: 1, borough: 1, complaint_type: 1, agency: 1 },
      { unique: true },
    ),
  ]);
}

async function main() {
  const started = Date.now();
  await mongoose.connect(MONGO, { dbName: DB_NAME, autoIndex: false });
  const db = mongoose.connection.db;
  const source = db.collection(SOURCE);
  const target = db.collection(TARGET);

  await ensureRollupIndexes(target);

  const matchStage = {};
  if (monthArg) {
    if (!/^\d{4}-\d{2}$/.test(monthArg)) {
      throw new Error(`Invalid --month format (expected YYYY-MM): ${monthArg}`);
    }
    const [year, month] = monthArg.split('-').map(Number);
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    matchStage.created_date = { $gte: start, $lt: end };
    console.log(`Rebuilding rollups for month ${monthArg}...`);
    const del = await target.deleteMany({ month: monthArg });
    console.log(`  deleted ${del.deletedCount.toLocaleString()} existing rollup docs`);
  } else {
    console.log('Rebuilding rollups for ALL months...');
    await target.deleteMany({});
  }

  const sourceCount = await source.countDocuments(matchStage);
  console.log(`Source rows to scan: ${sourceCount.toLocaleString()}`);

  const pipeline = [
    ...(Object.keys(matchStage).length ? [{ $match: matchStage }] : []),
    {
      $project: {
        month: { $dateToString: { format: '%Y-%m', date: '$created_date' } },
        borough: { $ifNull: ['$borough', 'Unknown'] },
        complaint_type: { $ifNull: ['$complaint_type', 'Unknown'] },
        agency: { $ifNull: ['$agency', 'Unknown'] },
        response_hours: '$response_hours',
        predicted_response_hours: '$predicted_response_hours',
        delay_risk_score: '$delay_risk_score',
        is_unresolved: { $ifNull: ['$is_unresolved', 0] },
        status: { $ifNull: ['$status', ''] },
        predicted_delay_bucket: '$predicted_delay_bucket',
        has_response_hours: hasNumericField('$response_hours'),
        has_predicted_hours: hasNumericField('$predicted_response_hours'),
        has_risk_score: hasNumericField('$delay_risk_score'),
      },
    },
    buildGroupStage(),
    { $sort: { '_id.month': 1 } },
  ];

  console.log('Running aggregation pipeline (allowDiskUse)...');
  const cursor = source.aggregate(pipeline, { allowDiskUse: true });
  let batch = [];
  let written = 0;
  const BATCH = 500;

  for await (const doc of cursor) {
    batch.push(flattenGroupDoc(doc));
    if (batch.length >= BATCH) {
      await target.insertMany(batch, { ordered: false });
      written += batch.length;
      if (written % 2000 === 0) console.log(`  inserted ${written.toLocaleString()} rollup docs...`);
      batch = [];
    }
  }
  if (batch.length) {
    await target.insertMany(batch, { ordered: false });
    written += batch.length;
  }

  const stats = await target.stats();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n=== Rollup backfill complete ===');
  console.log(`Documents written: ${written.toLocaleString()}`);
  console.log(`Collection count:  ${stats.count.toLocaleString()}`);
  console.log(`Storage size:      ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Total index size:  ${(stats.totalIndexSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Elapsed:           ${elapsed}s`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
