#!/usr/bin/env node
/** Compare rollup-backed dashboard vs live requests_clean aggregation. */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  buildMongoFilter,
  buildMongoFilterExcluding,
} from '../utils/queryFilters.js';
import {
  runDashboardAggregationFromRequests,
} from '../services/dashboardAggregation.js';
import {
  canDashboardUseRollups,
  runDashboardAggregationFromRollups,
  selectRollupSlicePrefix,
} from '../services/rollupAggregation.js';
import {
  formatStatsRow,
  formatBoroughBurdenRows,
  formatComplaintDriverRows,
  formatDelayTrendRows,
} from '../utils/aggregationHelpers.js';

dotenv.config();

const MONGO = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'civic_lens';

const CASES = [
  { label: 'no filters', query: {} },
  { label: 'borough=Bronx', query: { borough: 'Bronx' } },
  { label: 'agency=HPD', query: { agency: 'HPD' } },
  { label: 'complaintType=HEAT/HOT WATER', query: { complaintType: 'HEAT/HOT WATER' } },
  { label: 'borough=Bronx + complaintType=HEAT/HOT WATER', query: { borough: 'Bronx', complaintType: 'HEAT/HOT WATER' } },
  { label: 'status=Open', query: { status: 'Open' } },
  { label: 'highDelayOnly', query: { highDelayOnly: '1' } },
];

function formatBundle(facetResult) {
  const totals = facetResult?.statsTotals?.[0] ?? facetResult ?? {};
  const topComplaint = facetResult?.topComplaint?.[0]?._id ?? '—';
  return {
    stats: formatStatsRow(totals, topComplaint),
    boroughBurden: { boroughs: formatBoroughBurdenRows(facetResult?.boroughs ?? []) },
    complaintDrivers: { complaints: formatComplaintDriverRows(facetResult?.complaints ?? [], 10) },
    delayTrend: { timeline: formatDelayTrendRows(facetResult?.timeline ?? []) },
  };
}

async function rollupBundle(req) {
  const [main, boroughOnly] = await Promise.all([
    runDashboardAggregationFromRollups(req),
    runDashboardAggregationFromRollups(req, { excludeBorough: true }),
  ]);
  return formatBundle({ ...main, boroughs: boroughOnly.boroughs });
}

async function liveBundle(req) {
  const filter = buildMongoFilter(req);
  const boroughFilter = buildMongoFilterExcluding(req, 'borough');
  return runDashboardAggregationFromRequests(filter, boroughFilter);
}

function diffNumber(a, b, tol = 0.05) {
  if (a === b) return null;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) <= tol) return null;
    return { a, b, delta: a - b };
  }
  if (a !== b) return { a, b };
  return null;
}

function compareBundles(label, live, rollup) {
  console.log(`\n=== ${label} (slice: ${selectRollupSlicePrefix({ query: CASES.find(c => c.label === label)?.query ?? {} })}) ===`);
  const issues = [];
  for (const key of ['totalRequests', 'avgResponseHours', 'avgPredictedHours', 'unresolvedRate', 'highDelayCount', 'highRiskCount', 'topComplaintType']) {
    const d = diffNumber(live.stats[key], rollup.stats[key], key.includes('Rate') ? 0.0001 : 0.05);
    if (d) issues.push({ field: `stats.${key}`, ...d });
  }
  if (live.complaintDrivers.complaints.length !== rollup.complaintDrivers.complaints.length) {
    issues.push({ field: 'complaintDrivers.length', a: live.complaintDrivers.complaints.length, b: rollup.complaintDrivers.complaints.length });
  } else {
    for (let i = 0; i < live.complaintDrivers.complaints.length; i += 1) {
      const l = live.complaintDrivers.complaints[i];
      const r = rollup.complaintDrivers.complaints[i];
      if (l.complaintType !== r.complaintType || l.count !== r.count) {
        issues.push({ field: `complaintDrivers[${i}]`, a: l, b: r });
        break;
      }
    }
  }
  if (live.delayTrend.timeline.length !== rollup.delayTrend.timeline.length) {
    issues.push({ field: 'delayTrend.length', a: live.delayTrend.timeline.length, b: rollup.delayTrend.timeline.length });
  }
  if (live.boroughBurden.boroughs.length !== rollup.boroughBurden.boroughs.length) {
    issues.push({ field: 'boroughBurden.length', a: live.boroughBurden.boroughs.length, b: rollup.boroughBurden.boroughs.length });
  }
  if (issues.length === 0) {
    console.log('  MATCH — stats:', rollup.stats);
  } else {
    console.log('  MISMATCHES:', issues);
  }
  return issues;
}

async function timeDashboard(fn) {
  const t0 = Date.now();
  await fn();
  return Date.now() - t0;
}

async function main() {
  await mongoose.connect(MONGO, { dbName: DB_NAME, autoIndex: false });
  const allIssues = [];

  for (const testCase of CASES) {
    const req = { query: testCase.query };
    const check = canDashboardUseRollups(req);
    if (!check.ok) {
      console.log(`\n=== ${testCase.label} — SKIP (${check.reason}) ===`);
      continue;
    }
    const [live, rollup] = await Promise.all([
      liveBundle(req),
      rollupBundle(req),
    ]);
    allIssues.push(...compareBundles(testCase.label, live, rollup));
  }

  console.log('\n=== Timing (cold, no app cache) ===');
  const unfiltered = { query: {} };
  const liveMs = await timeDashboard(() => liveBundle(unfiltered));
  const rollupMs = await timeDashboard(() => rollupBundle(unfiltered));
  console.log(`  unfiltered live:   ${liveMs} ms`);
  console.log(`  unfiltered rollup: ${rollupMs} ms`);

  const hpd = { query: { agency: 'HPD' } };
  const liveHpdMs = await timeDashboard(() => liveBundle(hpd));
  const rollupHpdMs = await timeDashboard(() => rollupBundle(hpd));
  console.log(`  agency=HPD live:   ${liveHpdMs} ms`);
  console.log(`  agency=HPD rollup: ${rollupHpdMs} ms`);

  console.log(`\nTotal mismatch groups: ${allIssues.length}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
