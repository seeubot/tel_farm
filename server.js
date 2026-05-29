const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const { OAuth2Client } = require('google-auth-library'); // npm install google-auth-library
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
  console.warn('⚠️  Firebase Admin credentials missing. Running in demo mode.');
}

// ==================== GOOGLE OAUTH CLIENT ====================
// Used by the new PKCE mobile auth flow to exchange auth codes for tokens.
// Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
const googleOAuthClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

// ==================== MIDDLEWARE ====================
app.use(helmet());
app.use(cors({
  origin: ['http://localhost:19000', 'http://localhost:19006', 'https://*.koyeb.app', 'exp://*', '*'],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// ==================== MODELS ====================
const userSchema = new mongoose.Schema({
  firebaseUid: { type: String, unique: true, sparse: true }, // sparse: allows null for non-Firebase users
  googleId:    { type: String, unique: true, sparse: true }, // set for PKCE-auth users
  email: { type: String, required: true, unique: true },
  role: { type: String, enum: ['farmer', 'labourer', 'contractor', 'buyer'], default: 'farmer' },
  ageVerified: { type: Boolean, default: false },
  age: { type: Number },
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
    count:   { type: Number, default: 0 },
  },
  isActive: { type: Boolean, default: true },
  deletedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const equipmentSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  teluguName: { type: String },
  category: {
    type: String,
    enum: ['Tractor', 'Harvester', 'Irrigation Pump', 'Power Tiller', 'Sprayer', 'Processing Machine', 'Trailer', 'Other'],
    required: true,
  },
  description: { type: String },
  pricing: {
    perDay:   { type: Number, required: true },
    perHour:  { type: Number },
    deposit:  { type: Number, required: true },
  },
  location: {
    lat:      { type: Number, required: true },
    lng:      { type: Number, required: true },
    address:  String,
    village:  String,
    district: String,
  },
  features: [String],
  images: [String],
  availability: {
    isAvailable:   { type: Boolean, default: true },
    availableFrom: Date,
    availableTo:   Date,
  },
  ratings:      { average: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
  isVerified:   { type: Boolean, default: false },
  totalRentals: { type: Number, default: 0 },
  isActive:     { type: Boolean, default: true },
  createdAt:    { type: Date, default: Date.now },
});

const produceSchema = new mongoose.Schema({
  farmerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  cropName:   { type: String, required: true },
  teluguName: { type: String },
  variety:    String,
  quantity:   { type: Number, required: true },
  unit:       { type: String, default: 'kg' },
  price:      { type: Number, required: true },
  priceUnit:  { type: String, default: 'per quintal' },
  location: {
    lat:     Number,
    lng:     Number,
    address: String,
    village: String,
  },
  description: String,
  organic:     { type: Boolean, default: false },
  harvestDate: Date,
  images:      [String],
  isAvailable: { type: Boolean, default: true },
  isActive:    { type: Boolean, default: true },
  createdAt:   { type: Date, default: Date.now },
});

const bookingSchema = new mongoose.Schema({
  type:        { type: String, enum: ['equipment', 'produce'], required: true },
  itemId:      { type: mongoose.Schema.Types.ObjectId, required: true },
  renterId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ownerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  startDate:   Date,
  endDate:     Date,
  quantity:    Number,
  totalAmount: Number,
  deposit:     Number,
  status:      { type: String, enum: ['pending', 'confirmed', 'completed', 'cancelled'], default: 'pending' },
  rentalType:  { type: String, enum: ['self', 'withOperator'] },
  createdAt:   { type: Date, default: Date.now },
});

const reportSchema = new mongoose.Schema({
  reporterId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:        { type: String, enum: ['user', 'equipment', 'produce'], required: true },
  targetId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  reason:      { type: String, required: true },
  description: { type: String },
  status:      { type: String, enum: ['pending', 'reviewed', 'resolved'], default: 'pending' },
  createdAt:   { type: Date, default: Date.now },
});

const User      = mongoose.model('User',      userSchema);
const Equipment = mongoose.model('Equipment', equipmentSchema);
const Produce   = mongoose.model('Produce',   produceSchema);
const Booking   = mongoose.model('Booking',   bookingSchema);
const Report    = mongoose.model('Report',    reportSchema);

// ==================== AUTH MIDDLEWARE ====================
/**
 * Supports two token types:
 *
 *   1. Firebase ID token  — issued by Firebase Auth (legacy / web flow).
 *      Verified via firebaseAdmin.auth().verifyIdToken().
 *
 *   2. Google access token — issued by the new PKCE mobile flow.
 *      Verified by calling Google's tokeninfo endpoint.
 *      Prefixed with "google_" so middleware can distinguish the two.
 *
 * Both paths upsert a User document and attach it to req.user.
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const rawToken = authHeader.split(' ')[1];

    // ── Dev shortcut (no Firebase, no Google) ──────────────────────────────
    if (!firebaseAdmin && process.env.NODE_ENV === 'development') {
      req.user = { _id: 'demo123', email: 'demo@example.com', role: 'farmer' };
      return next();
    }

    // ── PKCE / Google access token (prefixed by our mobile client) ─────────
    if (rawToken.startsWith('google_')) {
      const accessToken = rawToken.slice(7); // strip "google_" prefix

      const tokenInfoRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`
      );
      const tokenInfo = await tokenInfoRes.json();

      if (!tokenInfoRes.ok || tokenInfo.error) {
        return res.status(401).json({ error: 'Invalid Google access token' });
      }

      // Upsert user by email
      let user = await User.findOne({ email: tokenInfo.email });
      if (!user) {
        return res.status(401).json({ error: 'User not found. Please sign in first.' });
      }
      if (!user.isActive) {
        return res.status(401).json({ error: 'Account has been deactivated' });
      }

      req.user = user;
      return next();
    }

    // ── Firebase ID token (existing flow) ─────────────────────────────────
    if (!firebaseAdmin) {
      return res.status(401).json({ error: 'Auth service not configured' });
    }

    const decodedToken = await firebaseAdmin.auth().verifyIdToken(rawToken);
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

    if (!user.isActive) {
      return res.status(401).json({ error: 'Account has been deactivated' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    res.status(401).json({ error: 'Authentication failed' });
  }
};

// ==================== HEALTH CHECK ====================
app.get('/health', async (req, res) => {
  const dbStatus = {
    0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting',
  }[mongoose.connection.readyState] || 'unknown';

  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: dbStatus,
    firebase: !!firebaseAdmin,
    environment: process.env.NODE_ENV || 'production',
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'AgriAgent API is running',
    version: '1.0.0',
    status: 'active',
    endpoints: {
      health:    'GET /health',
      auth:      'POST /api/auth/google, POST /api/auth/google-mobile, GET /api/auth/me, PUT /api/auth/role',
      equipment: 'GET,POST /api/equipment, GET,PUT,DELETE /api/equipment/:id',
      produce:   'GET,POST /api/produce, GET,PUT,DELETE /api/produce/:id',
      bookings:  'GET,POST /api/bookings, PUT /api/bookings/:id',
      users:     'DELETE /api/users/delete-account, GET /api/users/export-data',
      reports:   'POST /api/reports',
    },
  });
});

// ==================== GOOGLE AUTH — LEGACY (web / Firebase flow) ====================
app.post('/api/auth/google', async (req, res) => {
  try {
    const { email, name, picture, googleId } = req.body;

    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        firebaseUid: googleId,
        email,
        profile: { name, profileImage: picture },
        verification: { isVerified: false },
        ageVerified: false,
      });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        profile: user.profile,
        verification: user.verification,
        ageVerified: user.ageVerified,
      },
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== GOOGLE AUTH — PKCE MOBILE FLOW ====================
/**
 * Receives the authorization code + PKCE verifier from the mobile app.
 * Exchanges them for tokens server-side (keeps GOOGLE_CLIENT_SECRET off the device).
 *
 * Request body:
 *   { code: string, codeVerifier: string, redirectUri: string }
 *
 * Response:
 *   { success: true, idToken: string, user: { id, email, role, profile, verification, ageVerified } }
 *
 * The mobile app stores `idToken` (Google access token) and prefixes it with
 * "google_" when calling authenticated endpoints so the middleware can route it
 * correctly.
 */
app.post('/api/auth/google-mobile', async (req, res) => {
  try {
    const { code, codeVerifier, redirectUri } = req.body;

    if (!code || !codeVerifier || !redirectUri) {
      return res.status(400).json({ error: 'code, codeVerifier, and redirectUri are required' });
    }

    // Exchange auth code for tokens using PKCE verifier
    googleOAuthClient.redirectUri = redirectUri;
    const { tokens } = await googleOAuthClient.getToken({
      code,
      codeVerifier,
    });

    if (!tokens.access_token) {
      return res.status(400).json({ error: 'Failed to obtain access token from Google' });
    }

    // Fetch the user's Google profile
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoRes.ok) {
      return res.status(400).json({ error: 'Failed to fetch Google user info' });
    }

    const googleUser = await userInfoRes.json();
    // googleUser: { sub, email, name, picture, email_verified }

    // Upsert user in MongoDB
    let user = await User.findOne({ email: googleUser.email });

    if (!user) {
      user = await User.create({
        googleId: googleUser.sub,
        email: googleUser.email,
        profile: {
          name: googleUser.name,
          profileImage: googleUser.picture,
        },
        verification: { isVerified: false },
        ageVerified: false,
      });
    } else {
      // Backfill googleId if this user previously signed in via Firebase
      if (!user.googleId) {
        user.googleId = googleUser.sub;
        await user.save();
      }
    }

    if (!user.isActive) {
      return res.status(401).json({ error: 'Account has been deactivated' });
    }

    // Return the access token — mobile app will prefix it with "google_"
    // when calling authenticated endpoints (see authenticate middleware above)
    res.json({
      success: true,
      idToken: tokens.access_token, // stored as 'idToken' key to match existing AsyncStorage key
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        profile: user.profile,
        verification: user.verification,
        ageVerified: user.ageVerified,
      },
    });
  } catch (error) {
    console.error('PKCE token exchange error:', error);
    res.status(500).json({ error: error.message || 'Token exchange failed' });
  }
});

// ==================== AGE VERIFICATION ====================
app.post('/api/auth/verify-age', authenticate, async (req, res) => {
  try {
    const { age } = req.body;
    if (age < 18) {
      return res.status(400).json({ error: 'You must be 18 years or older to use AgriAgent' });
    }
    req.user.ageVerified = true;
    req.user.age = age;
    await req.user.save();
    res.json({ success: true, message: 'Age verified successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
        ageVerified: req.user.ageVerified,
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
    if (name)               req.user.profile.name = name;
    if (teluguName)         req.user.profile.teluguName = teluguName;
    if (phone)              req.user.profile.phone = phone;
    if (location)           req.user.profile.location = location;
    if (labourerDetails)    req.user.labourerDetails = labourerDetails;
    if (contractorDetails)  req.user.contractorDetails = contractorDetails;
    req.user.updatedAt = Date.now();
    await req.user.save();
    res.json({ success: true, user: req.user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== USER MANAGEMENT (GDPR) ====================
app.delete('/api/users/delete-account', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    await User.findByIdAndUpdate(userId, {
      isActive: false,
      deletedAt: new Date(),
      'profile.name': '[Deleted User]',
      'profile.phone': null,
    });
    await Equipment.deleteMany({ ownerId: userId });
    await Produce.deleteMany({ farmerId: userId });
    await Booking.updateMany(
      { $or: [{ renterId: userId }, { ownerId: userId }] },
      { $set: { renterId: null, ownerId: null, totalAmount: 0 } }
    );
    res.json({ success: true, message: 'Account permanently deleted' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users/export-data', authenticate, async (req, res) => {
  try {
    const user      = await User.findById(req.user._id).select('-__v');
    const equipment = await Equipment.find({ ownerId: req.user._id });
    const produce   = await Produce.find({ farmerId: req.user._id });
    const bookings  = await Booking.find({
      $or: [{ renterId: req.user._id }, { ownerId: req.user._id }],
    });
    res.json({ success: true, exportedAt: new Date(), data: { user, equipment, produce, bookings } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== REPORT ROUTE ====================
app.post('/api/reports', authenticate, async (req, res) => {
  try {
    const { type, targetId, reason, description } = req.body;
    if (!['user', 'equipment', 'produce'].includes(type)) {
      return res.status(400).json({ error: 'Invalid report type' });
    }
    const report = await Report.create({
      reporterId: req.user._id,
      type,
      targetId,
      reason,
      description,
    });
    console.log(`📢 New report: ${type}/${targetId} by ${req.user.email}`);
    res.json({
      success: true,
      message: 'Report submitted successfully. We will review within 24 hours.',
      reportId: report._id,
    });
  } catch (error) {
    console.error('Report error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== EQUIPMENT ROUTES ====================
app.get('/api/equipment', async (req, res) => {
  try {
    const { category, search } = req.query;
    const query = { 'availability.isAvailable': true, isActive: true };
    if (category && category !== 'all') query.category = category;
    if (search) {
      query.$or = [
        { name:       { $regex: search, $options: 'i' } },
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
    const query = { isAvailable: true, isActive: true };
    if (crop && crop !== 'all') query.cropName = crop;
    if (search) {
      query.$or = [
        { cropName: { $regex: search, $options: 'i' } },
        { variety:  { $regex: search, $options: 'i' } },
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
      $or: [{ renterId: req.user._id }, { ownerId: req.user._id }],
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
    const [equipmentCount, produceCount, bookingsAsRenter, bookingsAsOwner] = await Promise.all([
      Equipment.countDocuments({ ownerId: req.user._id }),
      Produce.countDocuments({ farmerId: req.user._id }),
      Booking.countDocuments({ renterId: req.user._id }),
      Booking.countDocuments({ ownerId: req.user._id }),
    ]);
    res.json({
      success: true,
      stats: {
        equipmentListed:   equipmentCount,
        produceListed:     produceCount,
        bookingsMade:      bookingsAsRenter,
        bookingsReceived:  bookingsAsOwner,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== 404 / ERROR HANDLERS ====================
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.url} not found` });
});

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
  });
});
