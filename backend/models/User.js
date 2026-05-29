const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  firebaseUid: {
    type: String,
    required: true,
    unique: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  role: {
    type: String,
    enum: ['farmer', 'labourer', 'contractor', 'buyer', 'admin'],
    default: 'farmer',
  },
  profile: {
    name: { type: String, required: true },
    teluguName: { type: String },
    phone: { type: String },
    profileImage: { type: String },
    location: {
      lat: { type: Number },
      lng: { type: Number },
      address: { type: String },
      village: { type: String },
      district: { type: String },
      state: { type: String, default: 'Telangana' },
    },
  },
  verification: {
    isPhoneVerified: { type: Boolean, default: false },
    isAadharVerified: { type: Boolean, default: false },
    isAddressVerified: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    verifiedAt: { type: Date },
    documents: {
      aadharUrl: { type: String },
      panUrl: { type: String },
    },
  },
  labourerDetails: {
    age: { type: Number },
    experience: { type: Number },
    skills: [{ type: String }], // Crop expertise
    isAvailable: { type: Boolean, default: true },
  },
  contractorDetails: {
    companyName: { type: String },
    gstNumber: { type: String },
    teamSize: { type: String },
    crops: [{ type: String }],
  },
  ratings: {
    average: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

userSchema.index({ 'profile.location.coordinates': '2dsphere' });

module.exports = mongoose.model('User', userSchema);
