import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { verifyRollupConsistency } from '../services/rollupVerification.js';

const hasMongoUri = Boolean(process.env.MONGODB_URI);

describe('rollup vs live dashboard consistency', () => {
  if (!hasMongoUri) {
    it.skip('skipped — set MONGODB_URI to run integration test against MongoDB', () => {});
    return;
  }

  it('matches live requests_clean aggregation for all rollup-supported filter cases', async () => {
    const dbName = process.env.DB_NAME || 'civic_lens';
    await mongoose.connect(process.env.MONGODB_URI, { dbName, autoIndex: false });

    try {
      const { results, allIssues } = await verifyRollupConsistency();
      const ran = results.filter((row) => !row.skipped);
      expect(ran.length).toBeGreaterThan(0);

      if (allIssues.length > 0) {
        const summary = allIssues
          .map((issue) => `${issue.case}: ${issue.field} live=${issue.a} rollup=${issue.b}`)
          .join('\n');
        expect.fail(`rollup/live mismatches:\n${summary}`);
      }
    } finally {
      await mongoose.disconnect();
    }
  }, 120_000);
});
