import Request from '../models/Request.js';
import {
  buildMapMongoFilter,
  buildMongoFilter,
  buildMongoFilterExcluding,
} from '../utils/queryFilters.js';
import { normalizeMapPoint } from '../utils/delayBuckets.js';
import {
  canDashboardUseRollups,
  runDashboardAggregationFromRollups,
} from './rollupAggregation.js';
import {
  unresolvedCond,
  highDelayCond,
  formatStatsRow,
  formatBoroughBurdenRows,
  formatComplaintDriverRows,
  formatDelayTrendRows,
} from '../utils/aggregationHelpers.js';
import { getCached, setCached, buildCacheKey } from './aggregationCache.js';

const GROUP_METRICS = {
  count: { $sum: 1 },
  avgResponseHours: { $avg: '$response_hours' },
  avgPredictedHours: { $avg: '$predicted_response_hours' },
  avgRisk: { $avg: '$delay_risk_score' },
  unresolvedCount: {
    $sum: { $cond: [unresolvedCond(), 1, 0] },
  },
  highDelayCount: {
    $sum: { $cond: [highDelayCond(), 1, 0] },
  },
};

const MAP_POINT_SELECT = [
  'unique_key',
  'latitude',
  'longitude',
  'borough',
  'complaint_type',
  'agency',
  'status',
  'is_unresolved',
  'descriptor',
  'incident_zip',
  'predicted_response_hours',
  'predicted_delay_bucket',
  'predicted_bucket',
  'actual_bucket',
  'response_hours',
  'delay_risk_score',
].join(' ');

const NYC_BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'];
const DEFAULT_MAP_POINT_LIMIT = Number(process.env.MAP_POINT_LIMIT || 5000);
const MAX_MAP_POINT_LIMIT = Number(process.env.MAX_MAP_POINT_LIMIT || 10000);

export function resolveMapPointLimit(queryLimit) {
  const requested = Number(queryLimit);
  if (!Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_MAP_POINT_LIMIT;
  }
  return Math.min(Math.floor(requested), MAX_MAP_POINT_LIMIT);
}

function coordFilter(filter) {
  return {
    ...filter,
    latitude: { $gte: -90, $lte: 90 },
    longitude: { $gte: -180, $lte: 180 },
  };
}

function formatDashboardBundle(facetResult) {
  const totals = facetResult?.statsTotals?.[0] ?? {};
  const topComplaint = facetResult?.topComplaint?.[0]?._id ?? '—';
  return {
    stats: formatStatsRow(totals, topComplaint),
    boroughBurden: { boroughs: formatBoroughBurdenRows(facetResult?.boroughs ?? []) },
    complaintDrivers: { complaints: formatComplaintDriverRows(facetResult?.complaints ?? [], 10) },
    delayTrend: { timeline: formatDelayTrendRows(facetResult?.timeline ?? []) },
  };
}

export async function runStatsAggregation(filter) {
  const [result] = await Request.aggregate([
    { $match: filter },
    {
      $facet: {
        statsTotals: [
          {
            $group: {
              _id: null,
              ...GROUP_METRICS,
              highRiskCount: {
                $sum: { $cond: [{ $gte: ['$delay_risk_score', 0.75] }, 1, 0] },
              },
            },
          },
        ],
        topComplaint: [
          { $group: { _id: '$complaint_type', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 1 },
        ],
      },
    },
  ]);

  const totals = result?.statsTotals?.[0] ?? {};
  const topComplaint = result?.topComplaint?.[0]?._id ?? '—';
  return formatStatsRow(totals, topComplaint);
}

export async function runDashboardAggregationFromRequests(filter, boroughFilter = filter) {
  const [dashboardResult, boroughRows] = await Promise.all([
    Request.aggregate([
      { $match: filter },
      {
        $facet: {
          statsTotals: [
            {
              $group: {
                _id: null,
                ...GROUP_METRICS,
                highRiskCount: {
                  $sum: { $cond: [{ $gte: ['$delay_risk_score', 0.75] }, 1, 0] },
                },
              },
            },
          ],
          topComplaint: [
            { $group: { _id: '$complaint_type', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 1 },
          ],
          complaints: [
            { $group: { _id: '$complaint_type', ...GROUP_METRICS } },
            { $sort: { count: -1 } },
            { $limit: 10 },
          ],
          timeline: [
            {
              $group: {
                _id: { year: '$year', month: '$month' },
                count: { $sum: 1 },
                avgResponseHours: { $avg: '$response_hours' },
                avgPredictedHours: { $avg: '$predicted_response_hours' },
                unresolvedCount: {
                  $sum: { $cond: [unresolvedCond(), 1, 0] },
                },
              },
            },
            { $sort: { '_id.year': 1, '_id.month': 1 } },
          ],
        },
      },
    ]),
    Request.aggregate([
      { $match: boroughFilter },
      { $group: { _id: '$borough', ...GROUP_METRICS } },
    ]),
  ]);

  const result = dashboardResult[0] ?? {};
  return formatDashboardBundle({
    ...result,
    boroughs: boroughRows,
  });
}

function normalizeMapRecords(records) {
  return records.map(normalizeMapPoint).filter(Boolean);
}

export async function fetchFastMapPoints(filter, sampleSize = DEFAULT_MAP_POINT_LIMIT) {
  const match = coordFilter(filter);
  const limit = resolveMapPointLimit(sampleSize);

  if (match.borough) {
    const records = await Request.find(match)
      .select(MAP_POINT_SELECT)
      .limit(limit)
      .lean();
    const normalized = normalizeMapRecords(records);
    return { records: normalized, count: normalized.length, limit };
  }

  const perBorough = Math.ceil(limit / NYC_BOROUGHS.length);
  const chunks = await Promise.all(
    NYC_BOROUGHS.map((borough) =>
      Request.find({ ...match, borough })
        .select(MAP_POINT_SELECT)
        .limit(perBorough)
        .lean(),
    ),
  );

  const records = normalizeMapRecords(chunks.flat());
  return { records, count: records.length, limit };
}

async function runDashboardViaRollups(req) {
  const [dashboardResult, boroughResult] = await Promise.all([
    runDashboardAggregationFromRollups(req),
    runDashboardAggregationFromRollups(req, { excludeBorough: true }),
  ]);
  return formatDashboardBundle({
    ...dashboardResult,
    boroughs: boroughResult.boroughs,
  });
}

export async function getDashboardBundleData(req) {
  const cacheKey = buildCacheKey('dashboard', req);
  const cached = getCached(cacheKey);
  if (cached) return { payload: cached, cache: 'HIT' };

  const rollupCheck = canDashboardUseRollups(req);
  let payload;
  if (rollupCheck.ok) {
    payload = await runDashboardViaRollups(req);
  } else {
    console.warn(`Dashboard rollup fallback (${rollupCheck.reason})`);
    const filter = buildMongoFilter(req);
    const boroughFilter = buildMongoFilterExcluding(req, 'borough');
    payload = await runDashboardAggregationFromRequests(filter, boroughFilter);
  }
  setCached(cacheKey, payload);
  return { payload, cache: 'MISS' };
}

export async function getMapBundleData(req) {
  const cacheKey = buildCacheKey('map', req);
  const cached = getCached(cacheKey);
  if (cached) return { payload: cached, cache: 'HIT' };

  const filter = buildMapMongoFilter(req);
  const mapLimit = resolveMapPointLimit(req.query?.limit);
  const [stats, mapPoints] = await Promise.all([
    runStatsAggregation(filter),
    fetchFastMapPoints(filter, mapLimit),
  ]);

  const payload = { stats, mapPoints };
  setCached(cacheKey, payload);
  return { payload, cache: 'MISS' };
}

/** Pre-compute default (unfiltered) dashboard + map so first page load is instant. */
export async function warmDefaultCache() {
  const emptyQuery = { query: {} };
  const started = Date.now();
  try {
    const filter = buildMongoFilter(emptyQuery);
    const rollupCheck = canDashboardUseRollups(emptyQuery);
    const dashboard = rollupCheck.ok
      ? await runDashboardViaRollups(emptyQuery)
      : await runDashboardAggregationFromRequests(filter);
    const mapPoints = await fetchFastMapPoints(filter);
    setCached(buildCacheKey('dashboard', emptyQuery), dashboard);
    setCached(buildCacheKey('map', emptyQuery), { stats: dashboard.stats, mapPoints });
    console.log(`Aggregation cache warmed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.warn('Aggregation cache warm failed:', err.message);
  }
}
