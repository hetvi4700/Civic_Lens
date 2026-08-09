import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import requestsRouter from './routes/requests.js';
import statsRouter from './routes/stats.js';
import { trySeedDataIfEmpty } from './services/seedData.js';
import { ensureRequestIndexes } from './services/ensureIndexes.js';
import { warmDefaultCache } from './services/dashboardAggregation.js';
import { getDefaultRequestFilter, getMlEligibleFilter } from './utils/normalizeRequest.js';

dotenv.config();

const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const app = express();
app.use(cors({
  origin: corsOrigins,
  methods: ['GET', 'OPTIONS'],
}));
app.use(express.json({ limit: '100kb' }));

const PORT = process.env.PORT || 5001;
const MONGO = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'civic_lens';

async function start() {
  try {
    await mongoose.connect(MONGO, { dbName: DB_NAME });
    console.log('Connected to MongoDB', DB_NAME);

    await trySeedDataIfEmpty();

    const collection = mongoose.connection.db.collection('requests_clean');
    await ensureRequestIndexes(collection);

    const showcaseFilter = getDefaultRequestFilter();
    const mlFilter = getMlEligibleFilter();
    const [showcaseCount, mlEligibleCount] = await Promise.all([
      collection.countDocuments(showcaseFilter),
      collection.countDocuments(mlFilter),
    ]);
    console.log('2026 dataset:', showcaseCount.toLocaleString(), 'records');
    console.log('ML-eligible (unresolved / Open):', mlEligibleCount.toLocaleString());

    app.use('/api/requests', requestsRouter);
    app.use('/api', statsRouter);

    app.get('/api/health', (_req, res) => res.json({
      ok: true,
      dataSource: 'mongodb',
      showcaseFilter,
      showcaseCount,
      mlEligibleCount,
    }));

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      warmDefaultCache();
    });
  } catch (err) {
    console.error('Failed to start server', err);
    process.exit(1);
  }
}

start();
