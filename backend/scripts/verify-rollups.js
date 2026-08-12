#!/usr/bin/env node
/** Compare rollup-backed dashboard vs live requests_clean aggregation. */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { selectRollupSlicePrefix } from '../services/rollupAggregation.js';
import {
  ROLLUP_VERIFY_CASES,
  verifyRollupConsistency,
} from '../services/rollupVerification.js';

dotenv.config();

const MONGO = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'civic_lens';

async function main() {
  await mongoose.connect(MONGO, { dbName: DB_NAME, autoIndex: false });
  const { results, allIssues } = await verifyRollupConsistency();

  for (const row of results) {
    const testCase = ROLLUP_VERIFY_CASES.find((c) => c.label === row.label);
    if (row.skipped) {
      console.log(`\n=== ${row.label} — SKIP (${row.reason}) ===`);
      continue;
    }
    console.log(`\n=== ${row.label} (slice: ${selectRollupSlicePrefix({ query: testCase?.query ?? {} })}) ===`);
    if (row.issues.length === 0) {
      console.log('  MATCH');
    } else {
      console.log('  MISMATCHES:', row.issues);
    }
  }

  console.log(`\nTotal mismatch groups: ${allIssues.length}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
