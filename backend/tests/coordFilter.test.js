import { describe, expect, it } from 'vitest';
import { buildMongoFilter } from '../utils/queryFilters.js';
import { coordFilter } from '../services/dashboardAggregation.js';

describe('coordFilter', () => {
  it('adds lat/lng validity bounds on top of the user filter', () => {
    const userFilter = buildMongoFilter({ query: { borough: 'Bronx' } });
    const withCoords = coordFilter(userFilter);

    expect(userFilter.latitude).toBeUndefined();
    expect(userFilter.longitude).toBeUndefined();
    expect(withCoords.borough).toBe('Bronx');
    expect(withCoords.created_date).toEqual(userFilter.created_date);
    expect(withCoords.latitude).toEqual({ $gte: -90, $lte: 90 });
    expect(withCoords.longitude).toEqual({ $gte: -180, $lte: 180 });
  });
});
