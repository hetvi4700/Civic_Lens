import { describe, expect, it } from 'vitest';
import { normalizeRequestForApi } from '../utils/normalizeRequest.js';

describe('normalizeRequestForApi', () => {
  it('strips shap_explanation and model_features from CLOSED records', () => {
    const closed = {
      unique_key: 'closed-1',
      status: 'Closed',
      is_unresolved: 0,
      shap_explanation: { top_features: [{ feature: 'borough', shap_value: 1 }] },
      model_features: { borough: 'Bronx' },
      predicted_response_hours: 48,
    };
    const out = normalizeRequestForApi(closed);
    expect(out.shap_explanation).toBeUndefined();
    expect(out.model_features).toBeUndefined();
    expect(out.predicted_response_hours).toBeUndefined();
    expect(out.ml_eligible).toBe(false);
  });

  it('returns shap_explanation for ML-eligible OPEN records with predictions', () => {
    const open = {
      unique_key: 'open-1',
      status: 'Open',
      is_unresolved: 1,
      predicted_response_hours: 96,
      shap_explanation: {
        top_features: [{ feature: 'borough', shap_value: 2.5, direction: 'increases' }],
      },
      model_features: { borough: 'Bronx' },
    };
    const out = normalizeRequestForApi(open);
    expect(out.ml_eligible).toBe(true);
    expect(out.shap_explanation).toBeDefined();
    expect(out.shap_explanation.factors?.length).toBeGreaterThan(0);
    expect(out.model_features).toEqual({ borough: 'Bronx' });
  });
});
