/** MongoDB collection for request detail records (map, case list, model view). */
export function getRequestsCollectionName() {
  if (process.env.REQUESTS_COLLECTION) {
    return process.env.REQUESTS_COLLECTION;
  }
  // Production deploys (Atlas) only restore requests_sample — avoid defaulting to missing requests_clean.
  if (process.env.NODE_ENV === 'production') {
    return 'requests_sample';
  }
  return 'requests_clean';
}
