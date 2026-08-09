/** Ensure MongoDB indexes used by $match across aggregation endpoints. */
export async function ensureRequestIndexes(collection) {
  await Promise.all([
    collection.createIndex({ created_date: 1 }),
    collection.createIndex({ borough: 1 }),
    collection.createIndex({ complaint_type: 1 }),
    collection.createIndex({ agency: 1 }),
    collection.createIndex({ predicted_delay_bucket: 1 }),
    collection.createIndex({ status: 1 }),
    collection.createIndex({ year: 1, month: 1 }),
    collection.createIndex({ created_date: 1, borough: 1 }),
    collection.createIndex({ created_date: 1, complaint_type: 1 }),
    collection.createIndex({ created_date: 1, agency: 1 }),
    // ML workload — agency-first range scans (store-prediction-mongodb compute_workload)
    collection.createIndex({ agency: 1, created_date: 1 }),
    collection.createIndex({ created_date: 1, status: 1 }),
    collection.createIndex({ created_date: 1, borough: 1, complaint_type: 1 }),
    collection.createIndex({ created_date: 1, latitude: 1, longitude: 1 }),
    // ML case picker — sort/filter by predicted delay under showcase year
    collection.createIndex({ created_date: 1, predicted_response_hours: -1 }),
    collection.createIndex({ created_date: 1, borough: 1, predicted_response_hours: -1 }),
    collection.createIndex({ created_date: 1, complaint_type: 1, predicted_response_hours: -1 }),
    collection.createIndex({ created_date: 1, agency: 1, predicted_response_hours: -1 }),
    collection.createIndex({ created_date: 1, status: 1, predicted_response_hours: -1 }),
    collection.createIndex({ year: 1, borough: 1 }),
    collection.createIndex({ year: 1, complaint_type: 1 }),
    collection.createIndex({ year: 1, agency: 1 }),
    collection.createIndex({ year: 1, is_unresolved: 1 }),
    collection.createIndex({ year: 1, borough: 1, complaint_type: 1 }),
    collection.createIndex({ incident_zip: 1 }),
    collection.createIndex({ is_unresolved: 1 }),
  ]);

  console.log('Indexes ensured on requests collection');
}
