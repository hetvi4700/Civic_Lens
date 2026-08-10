import mongoose from 'mongoose';
import { getRequestsCollectionName } from '../utils/requestsCollection.js';

const ShapFactorSchema = new mongoose.Schema({
  feature: String,
  label: String,
  shap_value: Number,
  direction: String,
}, { _id: false });

const ShapExplanationSchema = new mongoose.Schema({
  baseline_value: Number,
  prediction_value: Number,
  factors: [ShapFactorSchema],
  top_features: [ShapFactorSchema],
}, { strict: false, _id: false });

const ModelFeaturesSchema = new mongoose.Schema({}, { strict: false, _id: false });

const RequestSchema = new mongoose.Schema({
  // Index managed by services/ensureIndexes.js (autoIndex disabled on connect).
  unique_key: { type: String },
  created_date: Date,
  closed_date: Date,
  agency: String,
  agency_name: String,
  complaint_type: String,
  descriptor: String,
  status: String,
  resolution_description: String,
  borough: String,
  incident_zip: String,
  incident_address: String,
  latitude: Number,
  longitude: Number,
  community_board: String,
  open_data_channel_type: String,
  response_hours: Number,
  is_unresolved: Number,
  year: Number,
  month: Number,
  day_of_week: Number,
  hour: Number,
  is_weekend: Number,
  is_holiday: Number,
  season: String,
  urgency_score: Number,
  is_vague_resolution: Number,
  predicted_response_hours: Number,
  delay_risk_score: Number,
  predicted_delay_bucket: String,
  prediction_risk_level: String,
  model_features: ModelFeaturesSchema,
  shap_explanation: ShapExplanationSchema,
  prediction_confidence: Number,
  delay_tier: String,
  model_version: String,
  prediction_model: String,
  prediction_scope: String,
  prediction_generated_at: Date,
}, { timestamps: false, collection: getRequestsCollectionName(), strict: false });

export default mongoose.model('Request', RequestSchema, getRequestsCollectionName());
