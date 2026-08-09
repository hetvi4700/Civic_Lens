#!/usr/bin/env node
/**
 * Drop obsolete indexes on requests_clean that are not in REQUEST_INDEX_SPECS.
 *
 * Usage:
 *   node scripts/drop-unused-indexes.js              # dry run — list only
 *   node scripts/drop-unused-indexes.js --confirm    # actually drop
 *
 * Never drops _id_ or any index in the target set from ensureIndexes.js.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  isProtectedIndex,
  REQUEST_INDEX_SPECS,
} from '../services/ensureIndexes.js';

dotenv.config();

const MONGO = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'civic_lens';
const COLLECTION = 'requests_clean';
const confirm = process.argv.includes('--confirm');

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  await mongoose.connect(MONGO, { dbName: DB_NAME, autoIndex: false });
  const collection = mongoose.connection.db.collection(COLLECTION);
  const stats = await collection.stats();
  const indexSizes = stats.indexSizes ?? {};

  const indexes = await collection.indexes();
  const toDrop = indexes.filter((idx) => !isProtectedIndex(idx.key));

  console.log(`Collection: ${DB_NAME}.${COLLECTION}`);
  console.log(`Current indexes: ${indexes.length}  totalIndexSize: ${formatMb(stats.totalIndexSize)}`);
  console.log(`Target set (${REQUEST_INDEX_SPECS.length} specs + _id):`);
  REQUEST_INDEX_SPECS.forEach((spec) => console.log(`  keep  ${JSON.stringify(spec)}`));
  console.log('  keep  {"_id":1}');

  if (toDrop.length === 0) {
    console.log('\nNo obsolete indexes to drop.');
    await mongoose.disconnect();
    return;
  }

  let reclaimBytes = 0;
  console.log(`\nObsolete indexes to drop (${toDrop.length}):`);
  for (const idx of toDrop) {
    const size = indexSizes[idx.name] ?? 0;
    reclaimBytes += size;
    console.log(`  drop  ${idx.name.padEnd(55)} ${formatMb(size).padStart(8)}  ${JSON.stringify(idx.key)}`);
  }
  console.log(`\nEstimated reclaim: ${formatMb(reclaimBytes)}`);
  console.log(`Projected totalIndexSize: ${formatMb(stats.totalIndexSize - reclaimBytes)}`);

  if (!confirm) {
    console.log('\nDry run only. Re-run with --confirm to drop.');
    await mongoose.disconnect();
    return;
  }

  console.log('\nDropping...');
  for (const idx of toDrop) {
    await collection.dropIndex(idx.name);
    console.log(`  dropped ${idx.name}`);
  }

  const after = await collection.stats();
  console.log(`\nDone. Indexes: ${after.nindexes}  totalIndexSize: ${formatMb(after.totalIndexSize)}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
