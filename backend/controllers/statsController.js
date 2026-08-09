import {
  getDashboardBundleData,
  getMapBundleData,
} from '../services/dashboardAggregation.js';

const isDev = process.env.NODE_ENV !== 'production';

export async function getDashboardBundle(req, res) {
  const started = Date.now();
  try {
    const { payload, cache } = await getDashboardBundleData(req);
    if (isDev) {
      console.debug(`[api] GET /api/dashboard cache=${cache} ${Date.now() - started}ms`);
    }
    res.set('X-Cache', cache);
    res.json(payload);
  } catch (err) {
    console.error('getDashboardBundle failed', err);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
}

export async function getMapBundle(req, res) {
  const started = Date.now();
  try {
    const { payload, cache } = await getMapBundleData(req);
    if (isDev) {
      console.debug(`[api] GET /api/map-bundle cache=${cache} ${Date.now() - started}ms`);
    }
    res.set('X-Cache', cache);
    res.json(payload);
  } catch (err) {
    console.error('getMapBundle failed', err);
    res.status(500).json({ error: 'Failed to fetch map data' });
  }
}
