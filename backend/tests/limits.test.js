import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resolveMapPointLimit } from '../services/dashboardAggregation.js';
import {
  parseCaseListPagination,
  CASE_LIST_PAGE_SIZE,
  CASE_LIST_MAX_PAGE,
} from '../controllers/requestController.js';

describe('resolveMapPointLimit', () => {
  const originalMax = process.env.MAX_MAP_POINT_LIMIT;
  const originalDefault = process.env.MAP_POINT_LIMIT;

  beforeEach(() => {
    delete process.env.MAX_MAP_POINT_LIMIT;
    delete process.env.MAP_POINT_LIMIT;
  });

  afterEach(() => {
    if (originalMax === undefined) delete process.env.MAX_MAP_POINT_LIMIT;
    else process.env.MAX_MAP_POINT_LIMIT = originalMax;
    if (originalDefault === undefined) delete process.env.MAP_POINT_LIMIT;
    else process.env.MAP_POINT_LIMIT = originalDefault;
  });

  it('applies the default limit when none is given', () => {
    expect(resolveMapPointLimit(undefined)).toBe(5000);
    expect(resolveMapPointLimit(null)).toBe(5000);
    expect(resolveMapPointLimit('')).toBe(5000);
  });

  it('clamps requests above the max instead of honoring them', () => {
    expect(resolveMapPointLimit(999_999)).toBe(10000);
    expect(resolveMapPointLimit(50_000)).toBe(10000);
  });
});

describe('parseCaseListPagination', () => {
  it('uses the default page size when limit is omitted', () => {
    expect(parseCaseListPagination({})).toEqual({ limit: CASE_LIST_PAGE_SIZE, skip: 0 });
  });

  it('caps caseList pages at CASE_LIST_MAX_PAGE (200 by default)', () => {
    expect(parseCaseListPagination({ limit: '999' })).toEqual({ limit: CASE_LIST_MAX_PAGE, skip: 0 });
    expect(CASE_LIST_MAX_PAGE).toBe(200);
  });
});
