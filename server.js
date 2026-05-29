const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();

// ==================== DATABASE CONNECTION ====================
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected');
  } catch (error) {
    console.error('❌ MongoDB Error:', error.message);
    process.exit(1);
  }
};

// ==================== FIREBASE ADMIN INIT ====================
let firebaseAdmin = null;
if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
  try {
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (privateKey.includes('\\n')) {
      privateKey = privateKey.replace(/\\n/g, '\n');
    }
    
    firebaseAdmin = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: privateKey,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    console.log('✅ Firebase Admin initialized for project:', process.env.FIREBASE_PROJECT_ID);
  } catch (error) {
    console.error('❌ Firebase Admin error:', error.message);
  }
} else {
  console.warn('⚠️ Firebase Admin credentials missing. Running in demo mode.');
}

// ==================== MIDDLEWARE ====================
app.use(helmet());
app.use(cors({
  origin: ['http://localhost:19000', 'http://localhost:19006', 'https://*.koyeb.app', 'exp://*', '*'],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// ==================== MODELS ====================
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
    isAadharVerified: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    verifiedAt: Date,
    documents: {
      aadharUrl: String,
      panUrl: String,
    },
  },
  labourerDetails: {
    age: Number,
    experience: Number,
    skills: [String],
    isAvailable: { type: Boolean, default: true },
  },
  contractorDetails: {
    companyName: String,
    gstNumber: String,
    teamSize: String,
    crops: [String],
  },
  ratings: {
    average: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const equipmentSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  teluguName: { type: String },
  category: { type: String, enum: ['Tractor', 'Harvester', 'Irrigation Pump', 'Power Tiller', 'Sprayer', 'Processing Machine', 'Trailer', 'Other'], required: true },
  description: { type: String },
  pricing: {
    perDay: { type: Number, required: true },
    perHour: { type: Number },
    deposit: { type: Number, required: true },
  },
  location: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    address: String,
    village: String,
    district: String,
  },
  features: [String],
  images: [String],
  availability: {
    isAvailable: { type: Boolean, default: true },
    availableFrom: Date,
    availableTo: Date,
  },
  ratings: { average: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
  isVerified: { type: Boolean, default: false },
  totalRentals: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

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

const User = mongoose.model('User', userSchema);
const Equipment = mongoose.model('Equipment', equipmentSchema);
const Produce = mongoose.model('Produce', produceSchema);
const Booking = mongoose.model('Booking', bookingSchema);

// ==================== AUTH MIDDLEWARE ====================
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const idToken = authHeader.split(' ')[1];
    
    // Demo mode for testing without Firebase
    if (!firebaseAdmin && process.env.NODE_ENV === 'development') {
      req.user = { _id: 'demo123', email: 'demo@example.com', role: 'farmer' };
      return next();
    }
    
    if (!firebaseAdmin) {
      return res.status(401).json({ error: 'Auth service not configured' });
    }

    const decodedToken = await firebaseAdmin.auth().verifyIdToken(idToken);
    let user = await User.findOne({ firebaseUid: decodedToken.uid });
    
    if (!user) {
      user = await User.create({
        firebaseUid: decodedToken.uid,
        email: decodedToken.email,
        profile: {
          name: decodedToken.name || decodedToken.email.split('@')[0],
          profileImage: decodedToken.picture,
        },
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    res.status(401).json({ error: 'Authentication failed' });
  }
};

// ==================== API ROUTES ====================

// HEALTH CHECK - Improved for Koyeb
app.get('/health', async (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  }[dbState] || 'unknown';
  
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: dbStatus,
    firebase: !!firebaseAdmin,
    environment: process.env.NODE_ENV || 'production',
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'AgriAgent API is running',
    version: '1.0.0',
    status: 'active',
    endpoints: {
      health: 'GET /health',
      auth: 'GET /api/auth/me, PUT /api/auth/role, PUT /api/auth/profile',
      equipment: 'GET,POST /api/equipment, GET,PUT,DELETE /api/equipment/:id',
      produce: 'GET,POST /api/produce, GET,PUT,DELETE /api/produce/:id',
      bookings: 'GET,POST /api/bookings, PUT /api/bookings/:id',
      users: 'GET /api/users/:id',
      dashboard: 'GET /api/dashboard/stats',
    },
  });
});

// ==================== AUTH ROUTES ====================
app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    res.json({
      success: true,
      user: {
        id: req.user._id,
        email: req.user.email,
        role: req.user.role,
        profile: req.user.profile,
        verification: req.user.verification,
        labourerDetails: req.user.labourerDetails,
        contractorDetails: req.user.contractorDetails,
        ratings: req.user.ratings,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/auth/role', authenticate, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['farmer', 'labourer', 'contractor', 'buyer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    req.user.role = role;
    await req.user.save();
    res.json({ success: true, role: req.user.role });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/auth/profile', authenticate, async (req, res) => {
  try {
    const { name, teluguName, phone, location, labourerDetails, contractorDetails } = req.body;
    if (name) req.user.profile.name = name;
    if (teluguName) req.user.profile.teluguName = teluguName;
    if (phone) req.user.profile.phone = phone;
    if (location) req.user.profile.location = location;
    if (labourerDetails) req.user.labourerDetails = labourerDetails;
    if (contractorDetails) req.user.contractorDetails = contractorDetails;
    req.user.updatedAt = Date.now();
    await req.user.save();
    res.json({ success: true, user: req.user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== EQUIPMENT ROUTES ====================
app.get('/api/equipment', async (req, res) => {
  try {
    const { category, search } = req.query;
    let query = { 'availability.isAvailable': true };
    
    if (category && category !== 'all') query.category = category;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { teluguName: { $regex: search, $options: 'i' } },
      ];
    }
    
    const equipment = await Equipment.find(query)
      .populate('ownerId', 'profile.name profile.profileImage verification.isVerified ratings')
      .sort('-createdAt')
      .limit(50);
    
    res.json({ success: true, equipment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/equipment/:id', async (req, res) => {
  try {
    const equipment = await Equipment.findById(req.params.id)
      .populate('ownerId', 'profile.name profile.profileImage profile.phone verification.isVerified ratings');
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });
    res.json({ success: true, equipment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/equipment', authenticate, async (req, res) => {
  try {
    const equipment = await Equipment.create({ ...req.body, ownerId: req.user._id });
    res.status(201).json({ success: true, equipment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/equipment/:id', authenticate, async (req, res) => {
  try {
    const equipment = await Equipment.findById(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });
    if (equipment.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    Object.assign(equipment, req.body);
    await equipment.save();
    res.json({ success: true, equipment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/equipment/:id', authenticate, async (req, res) => {
  try {
    const equipment = await Equipment.findById(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });
    if (equipment.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    await equipment.deleteOne();
    res.json({ success: true, message: 'Equipment deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== PRODUCE ROUTES ====================
app.get('/api/produce', async (req, res) => {
  try {
    const { crop, search, organic } = req.query;
    let query = { isAvailable: true };
    
    if (crop && crop !== 'all') query.cropName = crop;
    if (search) {
      query.$or = [
        { cropName: { $regex: search, $options: 'i' } },
        { variety: { $regex: search, $options: 'i' } },
      ];
    }
    if (organic === 'true') query.organic = true;
    
    const produce = await Produce.find(query)
      .populate('farmerId', 'profile.name profile.profileImage verification.isVerified ratings')
      .sort('-createdAt')
      .limit(50);
    
    res.json({ success: true, produce });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/produce/:id', async (req, res) => {
  try {
    const produce = await Produce.findById(req.params.id)
      .populate('farmerId', 'profile.name profile.profileImage profile.phone verification.isVerified ratings');
    if (!produce) return res.status(404).json({ error: 'Produce not found' });
    res.json({ success: true, produce });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/produce', authenticate, async (req, res) => {
  try {
    const produce = await Produce.create({ ...req.body, farmerId: req.user._id });
    res.status(201).json({ success: true, produce });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/produce/:id', authenticate, async (req, res) => {
  try {
    const produce = await Produce.findById(req.params.id);
    if (!produce) return res.status(404).json({ error: 'Produce not found' });
    if (produce.farmerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    Object.assign(produce, req.body);
    await produce.save();
    res.json({ success: true, produce });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/produce/:id', authenticate, async (req, res) => {
  try {
    const produce = await Produce.findById(req.params.id);
    if (!produce) return res.status(404).json({ error: 'Produce not found' });
    if (produce.farmerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    await produce.deleteOne();
    res.json({ success: true, message: 'Listing deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== BOOKING ROUTES ====================
app.get('/api/bookings', authenticate, async (req, res) => {
  try {
    const bookings = await Booking.find({
      $or: [{ renterId: req.user._id }, { ownerId: req.user._id }]
    }).sort('-createdAt');
    res.json({ success: true, bookings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bookings', authenticate, async (req, res) => {
  try {
    const booking = await Booking.create({ ...req.body, renterId: req.user._id });
    res.status(201).json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/bookings/:id', authenticate, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    booking.status = req.body.status;
    await booking.save();
    res.json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== DASHBOARD STATS ====================
app.get('/api/dashboard/stats', authenticate, async (req, res) => {
  try {
    const equipmentCount = await Equipment.countDocuments({ ownerId: req.user._id });
    const produceCount = await Produce.countDocuments({ farmerId: req.user._id });
    const bookingsAsRenter = await Booking.countDocuments({ renterId: req.user._id });
    const bookingsAsOwner = await Booking.countDocuments({ ownerId: req.user._id });
    
    res.json({
      success: true,
      stats: {
        equipmentListed: equipmentCount,
        produceListed: produceCount,
        bookingsMade: bookingsAsRenter,
        bookingsReceived: bookingsAsOwner,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== 404 HANDLER ====================
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.url} not found` });
});

// ==================== ERROR HANDLER ====================
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`🔗 API base: http://localhost:${PORT}/`);
  });
});
