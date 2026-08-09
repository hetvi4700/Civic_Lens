import express from 'express';
import {
  getAllRequests,
  getRequestById,
} from '../controllers/requestController.js';

const router = express.Router();

router.get('/', getAllRequests);
router.get('/:id', getRequestById);

export default router;
