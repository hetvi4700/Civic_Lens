import { Router } from 'express';
import {
  getDashboardBundle,
  getMapBundle,
} from '../controllers/statsController.js';
import { getCascadingFacets } from '../controllers/facetController.js';

const router = Router();

router.get('/facets', getCascadingFacets);
router.get('/dashboard', getDashboardBundle);
router.get('/map-bundle', getMapBundle);

export default router;
