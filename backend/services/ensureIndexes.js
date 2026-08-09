/**
 * Index definitions for requests_clean.
 *
 * All application indexes are created here on startup. Mongoose schema indexes
 * are disabled (autoIndex: false) so unique_key is not duplicated from Request.js.
 *
 * ML workload (store-prediction-mongodb compute_workload) uses agency+created_date.
 */
export const REQUEST_INDEX_SPECS = [
  { created_date: 1 },
  { created_date: 1, predicted_response_hours: -1 },
  { created_date: 1, borough: 1 },
  { created_date: 1, complaint_type: 1 },
  { created_date: 1, agency: 1 },
  { borough: 1, predicted_response_hours: -1, status: 1 },
  { unique_key: 1 },
  { agency: 1, created_date: 1 },
  { created_date: 1, is_unresolved: 1, predicted_response_hours: -1 },
];

/** Compare MongoDB index key documents (field order matters). */
export function indexKeysEqual(a, b) {
  const keysA = Object.keys(a ?? {});
  const keysB = Object.keys(b ?? {});
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}

/** True if spec matches an index key or is a prefix thereof (for _id-only protection). */
export function isProtectedIndex(key) {
  if (indexKeysEqual(key, { _id: 1 })) return true;
  return REQUEST_INDEX_SPECS.some((spec) => indexKeysEqual(spec, key));
}

/** Ensure MongoDB indexes used by surviving API routes and ML workload queries. */
export async function ensureRequestIndexes(collection) {
  await Promise.all(
    REQUEST_INDEX_SPECS.map((spec) => collection.createIndex(spec)),
  );

  console.log(`Indexes ensured on requests collection (${REQUEST_INDEX_SPECS.length})`);
}
