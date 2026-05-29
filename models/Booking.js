const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  type: { type: String, enum: ['equipment', 'produce'], required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, required: true },
  renterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  startDate: Date,
  endDate: Date,
  quantity: Number,
  totalAmount: Number,
  deposit: Number,
  status: { type: String, enum: ['pending', 'confirmed', 'completed', 'cancelled'], default: 'pending' },
  rentalType: { type: String, enum: ['self', 'withOperator'] },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Booking', bookingSchema);
