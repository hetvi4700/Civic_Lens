import Request from '../models/Request.js';
import { buildMongoFilter, parseCaseListSort } from '../utils/queryFilters.js';
import {
  getDefaultRequestFilter,
  normalizeRequestForApi,
} from '../utils/normalizeRequest.js';

const CASE_LIST_PAGE_SIZE = Number(process.env.CASE_LIST_PAGE_SIZE || 50);
export { CASE_LIST_PAGE_SIZE };
export const CASE_LIST_MAX_PAGE = Number(process.env.CASE_LIST_MAX_PAGE || 200);

const CASE_LIST_PROJECTION = {
  unique_key: 1,
  complaint_type: 1,
  borough: 1,
  incident_zip: 1,
  predicted_delay_bucket: 1,
  predicted_response_hours: 1,
  agency: 1,
  status: 1,
  created_date: 1,
  is_unresolved: 1,
};

function isCaseListRequest(req) {
  return req.query.caseList === '1' || req.query.caseList === 'true';
}

export function parseCaseListPagination(query = {}) {
  const limit = Math.min(
    Math.max(Number(query.limit) || CASE_LIST_PAGE_SIZE, 1),
    CASE_LIST_MAX_PAGE,
  );
  const skip = Math.max(Number(query.skip) || 0, 0);
  return { limit, skip };
}

function idLookup(id) {
  const isObjectId = /^[a-f\d]{24}$/i.test(String(id));
  return isObjectId
    ? { $or: [{ unique_key: id }, { _id: id }] }
    : { unique_key: id };
}

/** List responses never include SHAP or model_features — use GET /api/requests/:id. */
function normalizeCaseListRecords(docs) {
  return docs.map((doc) => {
    const normalized = normalizeRequestForApi(doc);
    delete normalized.shap_explanation;
    delete normalized.model_features;
    return normalized;
  });
}

export async function getAllRequests(req, res) {
  try {
    if (!isCaseListRequest(req)) {
      return res.status(400).json({
        error: 'This endpoint requires caseList=1. Use GET /api/requests/:id for full request details.',
      });
    }

    const filter = buildMongoFilter(req);
    const { limit, skip } = parseCaseListPagination(req.query);
    const countOnly = req.query.countOnly === '1' || req.query.countOnly === 'true';
    const skipCount = req.query.skipCount === '1'
      || req.query.skipCount === 'true'
      || (!countOnly && req.query.skipCount !== '0');

    if (countOnly) {
      const total = await Request.countDocuments(filter);
      return res.json({
        total,
        caseList: true,
        year: filter.created_date?.$gte?.getUTCFullYear?.() ?? null,
      });
    }

    const docs = await Request.find(filter)
      .select(CASE_LIST_PROJECTION)
      .sort(parseCaseListSort(req))
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();

    const records = normalizeCaseListRecords(docs);

    let total = null;
    let hasMore;
    if (skipCount) {
      hasMore = records.length === limit;
    } else {
      total = await Request.countDocuments(filter);
      hasMore = skip + records.length < total;
    }

    res.json({
      records,
      total,
      skip,
      limit,
      hasMore,
      year: filter.created_date?.$gte?.getUTCFullYear?.() ?? null,
      filtered: true,
      caseList: true,
      countPending: skipCount,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

export async function getRequestById(req, res) {
  try {
    const { id } = req.params;
    const filter = { ...getDefaultRequestFilter(), ...idLookup(id) };

    const doc = await Request.findOne(filter).lean().exec();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(normalizeRequestForApi(doc));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
