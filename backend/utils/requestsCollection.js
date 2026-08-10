/** MongoDB collection for request detail records (map, case list, model view). */
export function getRequestsCollectionName() {
  return process.env.REQUESTS_COLLECTION || 'requests_clean';
}
