import Request from '../models/Request.js';

// This seed attempts to import the frontend mockRequests.js module if database is empty.
// Disabled in production — an empty DB should stay empty rather than serving mock data.
export async function trySeedDataIfEmpty() {
  const count = await Request.countDocuments();
  if (count > 0) {
    console.log('Database already has', count, 'requests');
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    console.error(
      'ERROR: Database is empty and seeding is disabled in production (NODE_ENV=production). '
      + 'Import data into requests_clean — the API will serve empty results until then.',
    );
    return;
  }

  try {
    // Import the frontend mockRequests module dynamically.
    // The path assumes this backend folder sits beside `civic-lens-frontend`.
    const modulePath = new URL('../civic-lens-frontend/src/data/mockRequests.js', import.meta.url);
    // eslint-disable-next-line import/no-unresolved
    const mod = await import(modulePath.href);
    const arr = mod.mockRequests ?? [];
    if (!Array.isArray(arr) || !arr.length) {
      console.log('No mock requests found to seed');
      return;
    }
    console.log('Seeding database with', arr.length, 'mock requests (this may take a moment)');
    const normalized = arr.map((r) => ({
      ...r,
      created_date: r.created_date ? new Date(r.created_date) : undefined,
      closed_date: r.closed_date ? new Date(r.closed_date) : undefined,
    }));
    await Request.insertMany(normalized, { ordered: false });
    console.log('Seeding complete');
  } catch (err) {
    console.warn('Seeding failed:', err.message || err);
  }
}
