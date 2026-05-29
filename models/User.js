const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  role: { type: String, enum: ['farmer', 'labourer', 'contractor', 'buyer'], default: 'farmer' },
  profile: {
    name: { type: String, required: true },
    teluguName: { type: String },
    phone: { type: String },
    profileImage: { type: String },
    location: {
      lat: Number,
      lng: Number,
      address: String,
      village: String,
      district: String,
    },
  },
  verification: {
    isPhoneVerified: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
