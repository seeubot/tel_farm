const mongoose = require('mongoose');

const produceSchema = new mongoose.Schema({
  farmerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  cropName: { type: String, required: true },
  teluguName: { type: String },
  variety: String,
  quantity: { type: Number, required: true },
  unit: { type: String, default: 'kg' },
  price: { type: Number, required: true },
  priceUnit: { type: String, default: 'per quintal' },
  location: {
    lat: Number,
    lng: Number,
    address: String,
    village: String,
  },
  description: String,
  organic: { type: Boolean, default: false },
  harvestDate: Date,
  images: [String],
  isAvailable: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Produce', produceSchema);
