import { describe, expect, it } from 'vitest';
import { delayBucketFromHours, DELAY_BUCKET_RANGES } from '../utils/delayBuckets.js';

describe('delayBucketFromHours', () => {
  it.each([
    [24, 'Same Day'],
    [72, '1–3 Days'],
    [168, '3–7 Days'],
  ])('assigns boundary value %i hours to %s', (hours, bucket) => {
    expect(delayBucketFromHours(hours)).toBe(bucket);
  });

  it('assigns values above 168 hours to More than 1 Week', () => {
    expect(delayBucketFromHours(169)).toBe('More than 1 Week');
  });

  it('matches filter ranges used by buildMongoFilter', () => {
    expect(DELAY_BUCKET_RANGES['Same Day']).toEqual({ $gt: 0, $lte: 24 });
    expect(DELAY_BUCKET_RANGES['1–3 Days']).toEqual({ $gt: 24, $lte: 72 });
    expect(DELAY_BUCKET_RANGES['3–7 Days']).toEqual({ $gt: 72, $lte: 168 });
    expect(DELAY_BUCKET_RANGES['More than 1 Week']).toEqual({ $gt: 168 });
  });
});
