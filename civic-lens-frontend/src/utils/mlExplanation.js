import { formatShapContribution } from './analytics';

export const ML_MODEL_VERSION = 'catboost_v1';

const SHOWCASE_KEYS = new Set(['68598811', '61999001', '61999002', '61999003']);

const FEATURE_LABELS = {
  agency_complaint_median: 'Agency + complaint historical delay',
  borough_complaint_median: 'Borough + complaint median',
  agency_zip_median: 'Agency + ZIP historical delay',
  agency_workload_24h: 'Recent agency workload',
  agency_volume: 'Agency volume',
  complaint_type: 'Complaint type',
  month: 'Month / seasonality',
  borough: 'Borough',
  agency: 'Agency',
  season: 'Season',
  incident_zip: 'Incident ZIP',
  open_data_channel_type: 'Submission channel',
};

export function getDelayTier(predictedHours) {
  const hours = Number(predictedHours) || 0;
  if (hours < 24) return 'low';
  if (hours < 72) return 'medium';
  return 'high';
}

function isOpenRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (Number(record.is_unresolved) === 1) return true;
  return String(record.status ?? '').trim() === 'Open';
}

function hoursBetween(start, end) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
  return (endMs - startMs) / (1000 * 60 * 60);
}

/** Elapsed time for open requests (since created_date); resolved response time for closed. */
export function getElapsedHours(record) {
  if (!record) return 0;

  const responseHours = Number(record.response_hours);
  if (!isOpenRecord(record)) {
    if (Number.isFinite(responseHours) && responseHours > 0) return responseHours;
    if (record.closed_date && record.created_date) {
      return hoursBetween(record.created_date, record.closed_date);
    }
    return Number.isFinite(responseHours) ? Math.max(0, responseHours) : 0;
  }

  if (record.created_date) {
    return hoursBetween(record.created_date, new Date());
  }
  return 0;
}

export function getDelayTierLabel(recordOrTier) {
  if (recordOrTier && typeof recordOrTier === 'object') {
    const bucket = recordOrTier.predicted_delay_bucket;
    if (bucket) return bucket;
    const risk = recordOrTier.prediction_risk_level;
    if (risk) return `${risk} risk`;
    return getDelayTierLabel(getDelayTier(recordOrTier.predicted_response_hours));
  }
  const labels = { low: 'Low delay', medium: 'Moderate delay', high: 'High delay' };
  return labels[recordOrTier] || recordOrTier;
}

function mapShapFactors(record) {
  const shap = record?.shap_explanation;
  const raw = shap?.factors?.length
    ? shap.factors
    : shap?.top_features;

  if (!Array.isArray(raw) || !raw.length) return null;

  return raw.map((row) => {
    const shapValue = Number(row.shap_value) || 0;
    return {
      feature: row.feature,
      label: row.label || FEATURE_LABELS[row.feature] || row.feature,
      value: record.model_features?.[row.feature] ?? record[row.feature] ?? '—',
      shap: shapValue,
      direction: row.direction || (shapValue >= 0 ? 'increases' : 'decreases'),
    };
  });
}

/** Uses embedded `shap_explanation` when present; otherwise returns empty. */
export function buildShapContributions(record) {
  if (!record) return [];
  const mapped = mapShapFactors(record);
  if (mapped) {
    return mapped.sort((a, b) => Math.abs(b.shap) - Math.abs(a.shap));
  }
  return [];
}

/** Resolve log1p SHAP anchors for a record (model target is log1p(response_hours)). */
export function getShapHourContext(record) {
  const predictedHours = Number(record?.predicted_response_hours) || 0;
  const factorsLog = mapShapFactors(record) ?? [];
  const sumShapLog = factorsLog.reduce((sum, row) => sum + row.shap, 0);

  // Anchor on the stored prediction so partial top-feature SHAP sets still reconcile.
  const predLog = Math.log1p(predictedHours);
  const baseLog = predLog - sumShapLog;
  const baselineHours = Math.expm1(baseLog);

  return {
    baseLog,
    predLog,
    baselineHours,
    predictedHours,
    factorsLog,
  };
}

/**
 * Convert log1p SHAP contributions to marginal hour deltas (baseline-dependent).
 * Sorted by |shap| to match the waterfall; hour deltas sum to predicted − baseline.
 */
export function buildShapContributionsInHours(record, { limit } = {}) {
  const { baseLog, factorsLog } = getShapHourContext(record);
  if (!factorsLog.length) return [];

  const sorted = [...factorsLog].sort((a, b) => Math.abs(b.shap) - Math.abs(a.shap));
  let runningLog = baseLog;

  const converted = sorted.map((row) => {
    const hoursBefore = Math.expm1(runningLog);
    runningLog += row.shap;
    const hoursAfter = Math.expm1(runningLog);
    return {
      ...row,
      shapLog: row.shap,
      shap: hoursAfter - hoursBefore,
    };
  });

  return limit != null ? converted.slice(0, limit) : converted;
}

export function buildModelFeatureRows(record) {
  const features = record?.model_features;
  const shapRows = buildShapContributionsInHours(record);

  if (features && shapRows.length) {
    const shapByFeature = Object.fromEntries(shapRows.map((row) => [row.feature, row]));
    return Object.entries(features).map(([feature, value]) => {
      const shapRow = shapByFeature[feature];
      const shap = shapRow?.shap ?? 0;
      return {
        feature,
        label: shapRow?.label ?? feature.replace(/_/g, ' '),
        value: value ?? '—',
        shap,
        shapLog: shapRow?.shapLog,
        direction: shap >= 0 ? 'increases' : 'decreases',
        impactLabel: formatShapContribution(shap),
      };
    });
  }

  return shapRows.map((row) => ({
    ...row,
    direction: row.shap >= 0 ? 'increases' : 'decreases',
    impactLabel: formatShapContribution(row.shap),
  }));
}

export function getPredictionSummary(record) {
  if (!record) {
    return {
      predictedHours: 0,
      actualHours: 0,
      confidence: 0,
      delayTier: 'low',
      delayBucket: 'Same Day',
      riskLevel: 'Low',
      riskScore: 0,
      modelVersion: ML_MODEL_VERSION,
      baselineHours: 0,
    };
  }

  const { baselineHours, predictedHours } = getShapHourContext(record);
  const elapsed = getElapsedHours(record);
  const confidence = Number(record.prediction_confidence) || 0.75;

  return {
    predictedHours,
    actualHours: elapsed,
    confidence,
    delayTier: record.delay_tier || getDelayTier(predictedHours),
    delayBucket: record.predicted_delay_bucket || 'Same Day',
    riskLevel: record.prediction_risk_level || 'Low',
    riskScore: Number(record.delay_risk_score) || 0,
    modelVersion: record.prediction_model || record.model_version || ML_MODEL_VERSION,
    predictionScope: record.prediction_scope || null,
    predictionGeneratedAt: record.prediction_generated_at || null,
    baselineHours,
    predictionValue: predictedHours,
  };
}

/** Curated cases — prioritizes recognizable showcase records with ML data. */
export function getDemoCases(requests, limit = 10) {
  const list = (Array.isArray(requests) ? requests : [])
    .filter((record) => record?.ml_eligible !== false && Number(record?.predicted_response_hours) > 0);

  if (!list.length) return [];

  const showcases = list.filter((record) => SHOWCASE_KEYS.has(record.unique_key));
  const others = list
    .filter((record) => !SHOWCASE_KEYS.has(record.unique_key))
    .map((record) => {
      const predicted = Number(record.predicted_response_hours) || 0;
      const actual = Number(record.response_hours) || 0;
      const error = Math.abs(predicted - actual);
      const risk = Number(record.delay_risk_score) || 0;
      const interest = error * 0.35 + risk * 40 + (record.complaint_type?.includes('HEAT') ? 12 : 0);
      return { record, interest };
    })
    .sort((a, b) => b.interest - a.interest)
    .map(({ record }) => record);

  const ordered = [...showcases, ...others];
  return ordered.slice(0, limit);
}

export function getCaseLabel(record) {
  const type = record?.complaint_type || 'Request';
  const short = type.length > 28 ? `${type.slice(0, 26)}…` : type;
  const bucket = record?.predicted_delay_bucket;
  return bucket ? `${short} · ${bucket}` : `${short} · ${record?.borough || 'NYC'}`;
}
