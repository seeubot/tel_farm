const mongoose = require('mongoose');

const equipmentSchema = new mongoose.Schema({
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  teluguName: {
    type: String,
  },
  category: {
    type: String,
    enum: ['Tractor', 'Harvester', 'Irrigation Pump', 'Power Tiller', 'Sprayer', 'Processing Machine', 'Trailer', 'Other'],
    required: true,
  },
  description: {
    type: String,
  },
  pricing: {
    perDay: { type: Number, required: true },
    perHour: { type: Number },
    deposit: { type: Number, required: true },
  },
  location: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    address: { type: String },
    village: { type: String },
    district: { type: String },
  },
  features: [{ type: String }],
  images: [{ type: String }],
  availability: {
    isAvailable: { type: Boolean, default: true },
    availableFrom: { type: Date },
    availableTo: { type: Date },
  },
  ratings: {
    average: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
  },
  isVerified: { type: Boolean, default: false },
  totalRentals: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

equipmentSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Equipment', equipmentSchema);
