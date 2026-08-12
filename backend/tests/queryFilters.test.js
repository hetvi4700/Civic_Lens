import { describe, expect, it } from 'vitest';
import {
  buildMongoFilter,
  buildMapMongoFilter,
  DELAY_BUCKET_RANGES,
} from '../utils/queryFilters.js';
import { getShowcaseYear } from '../utils/normalizeRequest.js';

function showcaseDateRange() {
  const year = getShowcaseYear();
  return {
    $gte: new Date(`${year}-01-01T00:00:00.000Z`),
    $lt: new Date(`${year + 1}-01-01T00:00:00.000Z`),
  };
}

describe('buildMongoFilter', () => {
  it('returns only the showcase-year date range with no params', () => {
    const filter = buildMongoFilter({ query: {} });
    expect(filter).toEqual({ created_date: showcaseDateRange() });
  });

  it('maps status=Open to is_unresolved: 1', () => {
    const filter = buildMongoFilter({ query: { status: 'Open' } });
    expect(filter.is_unresolved).toBe(1);
    expect(filter.status).toBeUndefined();
    expect(filter.created_date).toEqual(showcaseDateRange());
  });

  it('maps status=Closed to is_unresolved: 0', () => {
    const filter = buildMongoFilter({ query: { status: 'Closed' } });
    expect(filter.is_unresolved).toBe(0);
    expect(filter.status).toBeUndefined();
  });

  it('adds ML-eligible $or when mlOnly=1', () => {
    const filter = buildMongoFilter({ query: { mlOnly: '1' } });
    expect(filter.$or).toEqual([{ is_unresolved: 1 }, { status: 'Open' }]);
  });

  it('adds predicted_response_hours >= 72 when highDelayOnly=1', () => {
    const filter = buildMongoFilter({ query: { highDelayOnly: '1' } });
    expect(filter.predicted_response_hours).toEqual({ $gte: 72 });
  });

  it.each([
    ['Same Day', { $gt: 0, $lte: 24 }],
    ['1–3 Days', { $gt: 24, $lte: 72 }],
    ['3–7 Days', { $gt: 72, $lte: 168 }],
    ['More than 1 Week', { $gt: 168 }],
  ])('maps delayBucket=%s to the correct hour bounds', (bucket, expectedRange) => {
    const filter = buildMongoFilter({ query: { delayBucket: bucket } });
    expect(filter.predicted_response_hours).toEqual(expectedRange);
    expect(DELAY_BUCKET_RANGES[bucket]).toEqual(expectedRange);
  });

  it('combines borough, agency, and status clauses', () => {
    const filter = buildMongoFilter({
      query: { borough: 'Bronx', agency: 'HPD', status: 'Open' },
    });
    expect(filter.borough).toBe('Bronx');
    expect(filter.agency).toBe('HPD');
    expect(filter.is_unresolved).toBe(1);
    expect(filter.created_date).toEqual(showcaseDateRange());
  });
});

describe('buildMapMongoFilter', () => {
  it('does not add coordinate bounds (those are applied at map fetch time)', () => {
    const base = buildMongoFilter({ query: {} });
    const mapFilter = buildMapMongoFilter({ query: {} });
    expect(base.latitude).toBeUndefined();
    expect(base.longitude).toBeUndefined();
    expect(mapFilter.latitude).toBeUndefined();
    expect(mapFilter.longitude).toBeUndefined();
  });

  it('wraps status-aware delay bucket matching unlike buildMongoFilter', () => {
    const plain = buildMongoFilter({ query: { delayBucket: 'Same Day' } });
    const mapFilter = buildMapMongoFilter({ query: { delayBucket: 'Same Day' } });
    expect(plain.predicted_response_hours).toEqual({ $gt: 0, $lte: 24 });
    expect(mapFilter.$and).toBeDefined();
    expect(mapFilter.$and.some((clause) => clause.$or)).toBe(true);
  });
});
