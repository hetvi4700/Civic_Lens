import mongoose from 'mongoose';
import { getShowcaseYear } from '../utils/normalizeRequest.js';
import { DELAY_BUCKET_RANGES } from '../utils/delayBuckets.js';
import {
  delayBucketToSliceSuffix,
  mergeRollupMetrics,
  rollupMetricsToGroupRow,
  seasonToMonthStrings,
} from '../utils/rollupMetrics.js';

const COLLECTION = 'monthly_rollups';

function isActive(value) {
  return value != null && value !== '' && value !== 'All';
}

function readQueryValue(q, camelKey, snakeKey) {
  return q[camelKey] ?? q[snakeKey];
}

/** Dashboard filters that cannot be served from monthly_rollups. */
export function canDashboardUseRollups(input = {}) {
  const q = input.query ?? input;
  const search = String(q.search ?? q.q ?? '').trim();
  if (search) {
    return { ok: false, reason: 'search regex requires live detail collection' };
  }
  if (isActive(q.status) && q.status !== 'Open' && q.status !== 'Closed') {
    return { ok: false, reason: `status=${q.status} is not represented in rollup slices` };
  }
  const delayBucket = readQueryValue(q, 'delayBucket', 'delay_bucket');
  if (isActive(delayBucket) && !DELAY_BUCKET_RANGES[delayBucket]) {
    return { ok: false, reason: `unknown delayBucket=${delayBucket}` };
  }
  return { ok: true };
}

export function selectRollupSlicePrefix(input = {}) {
  const q = input.query ?? input;
  const mlOnly = q.mlOnly === '1' || q.mlOnly === 'true' || q.mlOnly === true;
  const highDelayOnly = q.highDelayOnly === '1' || q.highDelayOnly === 'true' || q.highDelayOnly === true;
  const delayBucket = readQueryValue(q, 'delayBucket', 'delay_bucket');
  const status = q.status;

  let statusPart = 'all';
  if (mlOnly) statusPart = 'ml';
  else if (status === 'Open') statusPart = 'open';
  else if (status === 'Closed') statusPart = 'closed';

  if (highDelayOnly) {
    if (statusPart === 'all') return 'pred72';
    return `${statusPart}_pred72`;
  }
  if (isActive(delayBucket)) {
    const bucketPart = delayBucketToSliceSuffix(delayBucket);
    if (!bucketPart) return 'all';
    if (statusPart === 'all') return bucketPart;
    return `${statusPart}_${bucketPart}`;
  }
  return statusPart;
}

export function buildRollupMatch(input = {}, { excludeBorough = false } = {}) {
  const q = input.query ?? input;
  const match = {};

  const showcaseYear = getShowcaseYear();
  if (isActive(q.year)) {
    const year = Number(q.year);
    match.month = { $gte: `${year}-01`, $lte: `${year}-12` };
  } else {
    match.month = { $gte: `${showcaseYear}-01`, $lt: `${showcaseYear + 1}-01` };
  }

  if (isActive(q.season)) {
    const seasonMonths = seasonToMonthStrings(q.season);
    const minMonth = match.month.$gte;
    const maxExclusive = match.month.$lt;
    const maxInclusive = match.month.$lte;
    match.month = {
      $in: seasonMonths.filter((m) => {
        if (minMonth && m < minMonth) return false;
        if (maxExclusive && m >= maxExclusive) return false;
        if (maxInclusive && m > maxInclusive) return false;
        return true;
      }),
    };
  }

  if (!excludeBorough && isActive(q.borough)) match.borough = q.borough;
  if (isActive(q.agency)) match.agency = q.agency;
  const complaintType = readQueryValue(q, 'complaintType', 'complaint_type');
  if (isActive(complaintType)) match.complaint_type = complaintType;

  return match;
}

function getRollupCollection() {
  return mongoose.connection.db.collection(COLLECTION);
}

function groupRowsBy(rows, keyFn) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

/** Aggregate dashboard facets from monthly_rollups for the active query slice. */
export async function runDashboardAggregationFromRollups(req, { excludeBorough = false } = {}) {
  const prefix = selectRollupSlicePrefix(req);
  const match = buildRollupMatch(req, { excludeBorough });
  const rows = await getRollupCollection().find(match).toArray();

  const totals = rollupMetricsToGroupRow(mergeRollupMetrics(rows, prefix));

  const complaintGrouped = groupRowsBy(rows, (row) => row.complaint_type);
  const complaints = [...complaintGrouped.entries()]
    .map(([complaintType, groupRows]) => ({
      _id: complaintType,
      ...rollupMetricsToGroupRow(mergeRollupMetrics(groupRows, prefix)),
    }))
    .sort((a, b) => b.count - a.count);

  const timelineGrouped = groupRowsBy(rows, (row) => row.month);
  const timeline = [...timelineGrouped.entries()]
    .map(([monthKey, monthRows]) => {
      const [yearStr, monthStr] = monthKey.split('-');
      return {
        _id: { year: Number(yearStr), month: Number(monthStr) },
        ...rollupMetricsToGroupRow(mergeRollupMetrics(monthRows, prefix)),
      };
    })
    .sort((a, b) => (a._id.year - b._id.year) || (a._id.month - b._id.month));

  const boroughGrouped = groupRowsBy(rows, (row) => row.borough);
  const boroughs = [...boroughGrouped.entries()]
    .map(([borough, groupRows]) => ({
      _id: borough,
      ...rollupMetricsToGroupRow(mergeRollupMetrics(groupRows, prefix)),
    }))
    .filter((row) => row.count > 0);

  return {
    statsTotals: [totals],
    topComplaint: complaints.length ? [{ _id: complaints[0]._id, count: complaints[0].count }] : [],
    complaints,
    timeline,
    boroughs,
  };
}

export async function getRollupDistinct(field, req, excludeField) {
  const q = { ...(req.query ?? {}) };
  if (excludeField === 'borough') delete q.borough;
  if (excludeField === 'complaint_type' || excludeField === 'complaintType') {
    delete q.complaint_type;
    delete q.complaintType;
  }
  if (excludeField === 'agency') delete q.agency;
  if (excludeField === 'status') delete q.status;
  if (excludeField === 'delay_bucket') {
    delete q.delay_bucket;
    delete q.delayBucket;
  }
  const match = buildRollupMatch({ query: q });
  const values = await getRollupCollection().distinct(field, match);
  return values.filter(Boolean).map(String).sort((a, b) => a.localeCompare(b));
}

export async function rollupHasDelayBucket(req, bucketLabel) {
  const prefix = selectRollupSlicePrefix({
    query: {
      ...req.query,
      delayBucket: bucketLabel,
      delay_bucket: bucketLabel,
      highDelayOnly: undefined,
    },
  });
  const match = buildRollupMatch(req);
  const count = await getRollupCollection().countDocuments({
    ...match,
    [`${prefix}_count`]: { $gt: 0 },
  });
  return count > 0;
}
