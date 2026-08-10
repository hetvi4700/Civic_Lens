/** Shared rollup slice definitions and response-hour bucket boundaries. */

export const RESPONSE_HOUR_BUCKETS = {
  same_day: { min: 0, max: 24, exclusiveMin: true },
  days_1_3: { min: 24, max: 72, exclusiveMin: true },
  days_3_7: { min: 72, max: 168, exclusiveMin: true },
  days_7_plus: { min: 168, max: null, exclusiveMin: true },
};

/** Matches backend/utils/delayBuckets.js and preprocessing-training/calibration.py bucket(). */
export const PREDICTED_HOUR_BUCKETS = {
  same_day: { min: 0, max: 24, exclusiveMin: true },
  days_1_3: { min: 24, max: 72, exclusiveMin: true },
  days_3_7: { min: 72, max: 168, exclusiveMin: true },
  days_7_plus: { min: 168, max: null, exclusiveMin: true },
};

export const HIGH_DELAY_PREDICTED_BUCKETS = ['3–7 Days', 'More than 1 Week'];
export const UNRESOLVED_STATUSES = ['Open', 'In Progress', 'Pending'];

/** Rollup metric suffixes stored per slice prefix. */
export const SLICE_METRIC_FIELDS = [
  'count',
  'sum_response_hours',
  'response_hours_count',
  'sum_predicted_response_hours',
  'predicted_hours_count',
  'sum_delay_risk_score',
  'risk_score_count',
  'high_delay_count',
  'high_risk_count',
  'unresolved_cond_count',
  'bucket_same_day',
  'bucket_1_3_days',
  'bucket_3_7_days',
  'bucket_7_plus_days',
];

/**
 * Slice prefixes precomputed in monthly_rollups.
 * Query layer picks one via selectRollupSlicePrefix().
 */
export const ROLLUP_SLICE_PREFIXES = [
  'all',
  'open',
  'closed',
  'ml',
  'pred72',
  'open_pred72',
  'closed_pred72',
  'ml_pred72',
  'pred_b_same_day',
  'pred_b_1_3',
  'pred_b_3_7',
  'pred_b_7_plus',
  'open_pred_b_same_day',
  'open_pred_b_1_3',
  'open_pred_b_3_7',
  'open_pred_b_7_plus',
  'closed_pred_b_same_day',
  'closed_pred_b_1_3',
  'closed_pred_b_3_7',
  'closed_pred_b_7_plus',
  'ml_pred_b_same_day',
  'ml_pred_b_1_3',
  'ml_pred_b_3_7',
  'ml_pred_b_7_plus',
];

export function delayBucketToSliceSuffix(label) {
  switch (label) {
    case 'Same Day': return 'pred_b_same_day';
    case '1–3 Days': return 'pred_b_1_3';
    case '3–7 Days': return 'pred_b_3_7';
    case 'More than 1 Week': return 'pred_b_7_plus';
    default: return null;
  }
}

export function seasonToMonthStrings(season, yearMin = 2016, yearMax = 2030) {
  const monthNums = {
    Winter: [12, 1, 2],
    Spring: [3, 4, 5],
    Summer: [6, 7, 8],
    Fall: [9, 10, 11],
  }[season] ?? [];
  const months = [];
  for (let year = yearMin; year <= yearMax; year += 1) {
    for (const m of monthNums) {
      months.push(`${year}-${String(m).padStart(2, '0')}`);
    }
  }
  return months;
}

export function mergeRollupMetrics(rows, prefix) {
  const totals = Object.fromEntries(SLICE_METRIC_FIELDS.map((f) => [f, 0]));
  for (const row of rows) {
    for (const field of SLICE_METRIC_FIELDS) {
      totals[field] += Number(row[`${prefix}_${field}`] ?? 0);
    }
  }
  return totals;
}

export function rollupMetricsToGroupRow(totals) {
  const count = totals.count ?? 0;
  const responseHoursCount = totals.response_hours_count ?? 0;
  const predictedHoursCount = totals.predicted_hours_count ?? 0;
  const riskScoreCount = totals.risk_score_count ?? 0;
  return {
    count,
    avgResponseHours: responseHoursCount
      ? totals.sum_response_hours / responseHoursCount
      : 0,
    avgPredictedHours: predictedHoursCount
      ? totals.sum_predicted_response_hours / predictedHoursCount
      : 0,
    avgRisk: riskScoreCount ? totals.sum_delay_risk_score / riskScoreCount : 0,
    unresolvedCount: totals.unresolved_cond_count ?? 0,
    highDelayCount: totals.high_delay_count ?? 0,
    highRiskCount: totals.high_risk_count ?? 0,
  };
}
