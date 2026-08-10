#!/usr/bin/env node
/**
 * Verify requests_sample coverage for map, case list, model view, and facets.
 * Run after build-sample.js with REQUESTS_COLLECTION=requests_sample for live API tests.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { buildMongoFilter, buildMongoFilterExcluding } from '../utils/queryFilters.js';
import { DELAY_BUCKET_ORDER, DELAY_BUCKET_RANGES } from '../utils/delayBuckets.js';
import { getShowcaseYear, getDefaultRequestFilter } from '../utils/normalizeRequest.js';
import { getCascadingFacetOptions } from '../services/cascadingFacets.js';
import { fetchFastMapPoints } from '../services/dashboardAggregation.js';

dotenv.config();

const MONGO = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'civic_lens';
const COLLECTION = process.env.REQUESTS_COLLECTION || 'requests_sample';

const BOROUGHS = ['Bronx', 'Brooklyn', 'Manhattan', 'Queens', 'Staten Island', 'Unspecified'];

async function countRequests(col, req) {
  const filter = buildMongoFilter(req);
  return col.countDocuments(filter);
}

async function countCaseList(col, req) {
  const filter = buildMongoFilter({ query: { ...req.query, caseList: '1' } });
  return col.countDocuments(filter);
}

async function main() {
  await mongoose.connect(MONGO, { dbName: DB_NAME, autoIndex: false });
  const db = mongoose.connection.db;
  const col = db.collection(COLLECTION);
  const total = await col.countDocuments();
  const defaultFilter = getDefaultRequestFilter();

  console.log(`=== Verifying ${COLLECTION} (${total.toLocaleString()} docs) ===\n`);

  const collStats = await db.command({ collStats: COLLECTION });
  const rollupStats = await db.command({ collStats: 'monthly_rollups' }).catch(() => null);
  const sampleMb = ((collStats.size ?? 0) + (collStats.totalIndexSize ?? 0)) / 1024 / 1024;
  const rollupMb = rollupStats
    ? ((rollupStats.size ?? 0) + (rollupStats.totalIndexSize ?? 0)) / 1024 / 1024
    : 0;

  console.log('Storage:');
  console.log(`  ${COLLECTION}: ${sampleMb.toFixed(2)} MB (${collStats.count} docs)`);
  console.log(`  monthly_rollups: ${rollupMb.toFixed(2)} MB`);
  console.log(`  combined: ${(sampleMb + rollupMb).toFixed(2)} MB (budget: 450 MB)\n`);

  const issues = [];

  // 1. Default filters — map + case list + count
  const defaultReq = { query: {} };
  const [defaultCount, defaultCases, mapDefault] = await Promise.all([
    col.countDocuments(defaultFilter),
    countCaseList(col, defaultReq),
    fetchFastMapPoints(defaultFilter),
  ]);
  console.log('1. Default filters:');
  console.log(`   records: ${defaultCount}, case list: ${defaultCases}, map points: ${mapDefault.count}`);
  if (defaultCount === 0) issues.push('default filter returns 0 records');
  if (defaultCases === 0) issues.push('default case list returns 0');
  if (mapDefault.count === 0) issues.push('default map returns 0 points');

  // 2. Model view delay buckets (direct count — caseList+delayBucket merge has a known $gt overwrite)
  console.log('\n2. Model view delay buckets (ML case pool):');
  const mlPool = {
    ...defaultFilter,
    $or: [{ is_unresolved: 1 }, { status: 'Open' }],
    predicted_response_hours: { $gt: 0 },
    shap_explanation: { $exists: true, $ne: null },
  };
  for (const bucket of DELAY_BUCKET_ORDER) {
    const n = await col.countDocuments({
      ...mlPool,
      predicted_response_hours: DELAY_BUCKET_RANGES[bucket],
    });
    console.log(`   ${bucket}: ${n}`);
    if (n === 0) issues.push(`delay bucket "${bucket}" ML pool empty`);
  }

  // 3. Single-value facet selections
  const facets = await getCascadingFacetOptions(defaultReq);
  console.log('\n3. Single-value facet selections:');
  for (const borough of facets.borough ?? BOROUGHS) {
    const n = await countRequests(col, { query: { borough } });
    if (n === 0) issues.push(`borough=${borough} empty (${n})`);
  }
  for (const complaintType of facets.complaint_type ?? []) {
    const n = await countRequests(col, { query: { complaintType } });
    if (n === 0) issues.push(`complaintType=${complaintType} empty (${n})`);
  }
  for (const agency of facets.agency ?? []) {
    const n = await countRequests(col, { query: { agency } });
    if (n === 0) issues.push(`agency=${agency} empty (${n})`);
  }
  const singleEmpty = issues.filter((i) => i.includes('borough=') || i.includes('complaintType=') || i.includes('agency='));
  console.log(`   boroughs: ${facets.borough?.length}, complaints: ${facets.complaint_type?.length}, agencies: ${facets.agency?.length}`);
  console.log(`   single-value gaps: ${singleEmpty.length}`);

  // 4. Map markers per borough
  console.log('\n4. Map markers per borough:');
  for (const borough of BOROUGHS) {
    const filter = buildMongoFilter({ query: { borough } });
    const map = await fetchFastMapPoints(filter);
    console.log(`   ${borough}: ${map.count} points`);
    if (map.count === 0 && (facets.borough ?? []).includes(borough)) {
      issues.push(`map empty for borough=${borough}`);
    }
  }

  // 5. Cascading triple gaps (report thin combos, do not hide)
  console.log('\n5. Cascading facet combo spot-check (sample of thin pairs):');
  let comboGaps = 0;
  for (const borough of facets.borough ?? []) {
    const reqB = { query: { borough } };
    const subFacets = await getCascadingFacetOptions(reqB);
    for (const agency of subFacets.agency ?? []) {
      const n = await countRequests(col, { query: { borough, agency } });
      if (n === 0) {
        comboGaps += 1;
        if (comboGaps <= 10) console.log(`   EMPTY: ${borough} + ${agency} (${n})`);
      }
    }
  }
  console.log(`   borough+agency empty combos offered by facets: ${comboGaps}`);

  // Status coverage
  console.log('\n6. Status values:');
  for (const status of facets.status ?? []) {
    const n = await countRequests(col, { query: { status } });
    console.log(`   ${status}: ${n}`);
    if (n === 0) issues.push(`status=${status} empty`);
  }

  console.log(`\n=== Summary: ${issues.length} issue(s) ===`);
  if (issues.length) {
    issues.forEach((issue) => console.log(`  - ${issue}`));
    process.exitCode = 1;
  } else {
    console.log('All checks passed.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
