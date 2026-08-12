import {
  buildMongoFilter,
  buildMongoFilterExcluding,
} from '../utils/queryFilters.js';
import {
  runDashboardAggregationFromRequests,
} from './dashboardAggregation.js';
import {
  canDashboardUseRollups,
  runDashboardAggregationFromRollups,
} from './rollupAggregation.js';
import {
  formatStatsRow,
  formatBoroughBurdenRows,
  formatComplaintDriverRows,
  formatDelayTrendRows,
} from '../utils/aggregationHelpers.js';

export const ROLLUP_VERIFY_CASES = [
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

export function compareDashboardBundles(live, rollup) {
  const issues = [];
  for (const key of ['totalRequests', 'avgResponseHours', 'avgPredictedHours', 'unresolvedRate', 'highDelayCount', 'highRiskCount', 'topComplaintType']) {
    const d = diffNumber(live.stats[key], rollup.stats[key], key.includes('Rate') ? 0.0001 : 0.05);
    if (d) issues.push({ field: `stats.${key}`, ...d });
  }
  if (live.complaintDrivers.complaints.length !== rollup.complaintDrivers.complaints.length) {
    issues.push({
      field: 'complaintDrivers.length',
      a: live.complaintDrivers.complaints.length,
      b: rollup.complaintDrivers.complaints.length,
    });
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
    issues.push({
      field: 'delayTrend.length',
      a: live.delayTrend.timeline.length,
      b: rollup.delayTrend.timeline.length,
    });
  }
  if (live.boroughBurden.boroughs.length !== rollup.boroughBurden.boroughs.length) {
    issues.push({
      field: 'boroughBurden.length',
      a: live.boroughBurden.boroughs.length,
      b: rollup.boroughBurden.boroughs.length,
    });
  }
  return issues;
}

/** Compare rollup-backed dashboard output against live requests_clean aggregation. */
export async function verifyRollupConsistency() {
  const results = [];

  for (const testCase of ROLLUP_VERIFY_CASES) {
    const req = { query: testCase.query };
    const check = canDashboardUseRollups(req);
    if (!check.ok) {
      results.push({ label: testCase.label, skipped: true, reason: check.reason, issues: [] });
      continue;
    }
    const [live, rollup] = await Promise.all([
      liveBundle(req),
      rollupBundle(req),
    ]);
    const issues = compareDashboardBundles(live, rollup);
    results.push({ label: testCase.label, skipped: false, issues });
  }

  const allIssues = results.flatMap((row) => row.issues.map((issue) => ({ ...issue, case: row.label })));
  return { results, allIssues };
}
