const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const BOROUGH_CENTERS = {
  Manhattan: { lat: 40.7831, lng: -73.9712 },
  Brooklyn: { lat: 40.6782, lng: -73.9442 },
  Queens: { lat: 40.7282, lng: -73.7949 },
  Bronx: { lat: 40.8448, lng: -73.8648 },
  'Staten Island': { lat: 40.5795, lng: -74.1502 },
};

const HIGH_DELAY_BUCKETS = ['3–7 Days', 'More than 1 Week'];
const UNRESOLVED_STATUSES = ['Open', 'In Progress', 'Pending'];

export function unresolvedCond() {
  return {
    $or: [
      { $eq: ['$is_unresolved', 1] },
      { $in: ['$status', UNRESOLVED_STATUSES] },
    ],
  };
}

export function highDelayCond() {
  return {
    $or: [
      { $in: ['$predicted_delay_bucket', HIGH_DELAY_BUCKETS] },
      { $gte: ['$predicted_response_hours', 72] },
    ],
  };
}

export function round(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function normalizeSeries(values) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((value) => (value - min) / (max - min));
}

export function formatStatsRow(row, topComplaint = '—') {
  const count = row?.count ?? 0;
  const unresolvedCount = row?.unresolvedCount ?? 0;
  return {
    totalRequests: count,
    avgResponseHours: round(row?.avgResponseHours ?? 0),
    avgPredictedHours: round(row?.avgPredictedHours ?? 0),
    unresolvedRate: count ? round(unresolvedCount / count, 4) : 0,
    highDelayCount: row?.highDelayCount ?? 0,
    highRiskCount: row?.highRiskCount ?? 0,
    topComplaintType: topComplaint || '—',
  };
}

export function formatBoroughBurdenRows(rows) {
  const rawStats = rows.map((row) => {
    const count = row.count ?? 0;
    const unresolvedCount = row.unresolvedCount ?? 0;
    const highDelayCount = row.highDelayCount ?? 0;
    return {
      borough: row._id || 'Unknown',
      count,
      avgResponseHours: round(row.avgResponseHours ?? 0),
      avgPredictedHours: round(row.avgPredictedHours ?? 0),
      unresolvedRate: count ? round(unresolvedCount / count, 4) : 0,
      highDelayCount,
      highDelayRate: count ? round(highDelayCount / count, 4) : 0,
      avgRisk: round(row.avgRisk ?? 0),
      avgDelayRisk: round(row.avgRisk ?? 0),
    };
  });

  const burdenEligible = rawStats.filter((entry) => BOROUGH_CENTERS[entry.borough]);
  const normalizedCounts = normalizeSeries(burdenEligible.map((entry) => entry.count));
  const normalizedResponse = normalizeSeries(burdenEligible.map((entry) => entry.avgResponseHours));
  const normalizedUnresolved = normalizeSeries(burdenEligible.map((entry) => entry.unresolvedRate));
  const normalizedHighDelay = normalizeSeries(burdenEligible.map((entry) => entry.highDelayRate));

  const burdenScores = new Map();
  burdenEligible.forEach((entry, index) => {
    burdenScores.set(
      entry.borough,
      round(
        0.3 * normalizedCounts[index]
        + 0.3 * normalizedResponse[index]
        + 0.25 * normalizedUnresolved[index]
        + 0.15 * normalizedHighDelay[index],
        4,
      ),
    );
  });

  return rawStats
    .map((entry) => {
      const center = BOROUGH_CENTERS[entry.borough] || { lat: 40.7128, lng: -74.006 };
      return {
        ...entry,
        burdenScore: burdenScores.get(entry.borough) ?? null,
        lat: center.lat,
        lng: center.lng,
      };
    })
    .sort((a, b) => (b.burdenScore ?? -1) - (a.burdenScore ?? -1));
}

export function formatComplaintDriverRows(rows, limit = 10) {
  return rows
    .map((row) => {
      const count = row.count ?? 0;
      const unresolvedCount = row.unresolvedCount ?? 0;
      return {
        complaintType: row._id || 'Unknown',
        count,
        avgResponseHours: round(row.avgResponseHours ?? 0),
        unresolvedRate: count ? round(unresolvedCount / count, 4) : 0,
        highDelayCount: row.highDelayCount ?? 0,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function formatDelayTrendRows(rows) {
  return rows
    .map((row) => {
      const year = row._id?.year ?? 0;
      const month = row._id?.month ?? 0;
      const count = row.count ?? 0;
      const unresolvedCount = row.unresolvedCount ?? 0;
      const avgResponseHours = round(row.avgResponseHours ?? 0);
      const avgPredictedHours = round(row.avgPredictedHours ?? 0);
      return {
        year,
        month,
        label: `${MONTH_LABELS[month - 1] || month} ${year}`,
        count,
        avgResponseHours,
        avgPredictedHours,
        unresolvedRate: count ? round(unresolvedCount / count, 4) : 0,
        avgActual: avgResponseHours,
        avgPredicted: avgPredictedHours,
      };
    })
    .sort((a, b) => (a.year - b.year) || (a.month - b.month));
}

export function formatMapStatsFromStats(stats, visibleCount) {
  return {
    visibleRequests: visibleCount ?? 0,
    avgPredictedDelay: stats?.avgPredictedHours ?? 0,
    highDelayCount: stats?.highDelayCount ?? 0,
    unresolvedRate: stats?.unresolvedRate ?? 0,
  };
}
