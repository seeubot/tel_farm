const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

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
    if (privateKey.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');
    firebaseAdmin = admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        privateKey:  privateKey,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    console.log('✅ Firebase Admin initialized');
  } catch (error) {
    console.error('❌ Firebase Admin error:', error.message);
  }
} else {
  console.warn('⚠️  Firebase Admin credentials missing. Running in demo mode.');
}

// ==================== GOOGLE OAUTH CLIENT ====================
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

// Multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  },
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests' },
});
app.use('/api/', limiter);

// ==================== MODELS ====================
const userSchema = new mongoose.Schema({
  firebaseUid: { type: String, unique: true, sparse: true },
  googleId:    { type: String, unique: true, sparse: true },
  email:       { type: String, required: true, unique: true },
  role:        { type: String, enum: ['farmer', 'labourer', 'contractor', 'buyer'], default: 'farmer' },
  ageVerified: { type: Boolean, default: false },
  age:         { type: Number },
  profile: {
    name:         { type: String, required: true },
    teluguName:   { type: String },
    phone:        { type: String },
    profileImage: { type: String },
    location: {
      lat:      Number,
      lng:      Number,
      address:  String,
      village:  String,
      district: String,
    },
  },
  verification: {
    isPhoneVerified:  { type: Boolean, default: false },
    isAadharVerified: { type: Boolean, default: false },
    isVerified:       { type: Boolean, default: false },
    verifiedAt:       Date,
  },
  labourerDetails: {
    age:         Number,
    experience:  Number,
    skills:      [String],
    isAvailable: { type: Boolean, default: true },
  },
  contractorDetails: {
    companyName: String,
    gstNumber:   String,
    teamSize:    String,
    crops:       [String],
  },
  ratings: {
    average: { type: Number, default: 0 },
    count:   { type: Number, default: 0 },
  },
  isActive:  { type: Boolean, default: true },
  deletedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const equipmentSchema = new mongoose.Schema({
  ownerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:     { type: String, required: true },
  teluguName: { type: String },
  category: {
    type: String,
    enum: ['Tractor', 'Harvester', 'Irrigation Pump', 'Power Tiller', 'Sprayer', 'Processing Machine', 'Trailer', 'Other'],
    required: true,
  },
  description: { type: String },
  pricing: {
    perDay:  { type: Number, required: true },
    perHour: { type: Number },
    deposit: { type: Number, required: true },
  },
  location: {
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
    address: String,
    village: String,
    district: String,
  },
  features: [String],
  images:   [String],
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

const problemSchema = new mongoose.Schema({
  farmerId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:             { type: String, required: true },
  teluguTitle:       { type: String },
  description:       { type: String, required: true },
  teluguDescription: { type: String },
  cropType:          { type: String, required: true },
  location: {
    lat:     Number,
    lng:     Number,
    address: String,
    village: String,
  },
  type:          { type: String, enum: ['text', 'image', 'video'], default: 'text' },
  mediaUrl:      { type: String },
  upvotes:       { type: Number, default: 0 },
  upvotedBy:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  solutionCount: { type: Number, default: 0 },
  isActive:      { type: Boolean, default: true },
  createdAt:     { type: Date, default: Date.now },
});

const solutionSchema = new mongoose.Schema({
  problemId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Problem', required: true },
  farmerId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  solution:       { type: String, required: true },
  teluguSolution: { type: String },
  mediaUrl:       { type: String },
  mediaType:      { type: String, enum: ['image', 'video'] },
  upvotes:        { type: Number, default: 0 },
  upvotedBy:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  isActive:       { type: Boolean, default: true },
  createdAt:      { type: Date, default: Date.now },
});

const fertilizerShopSchema = new mongoose.Schema({
  name:           { type: String, required: true },
  teluguName:     { type: String },
  ownerName:      { type: String, required: true },
  phone:          { type: String, required: true },
  alternatePhone: { type: String },
  email:          { type: String },
  location: {
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
    address: { type: String, required: true },
    village: { type: String },
    district: { type: String },
    pincode: { type: String },
  },
  timings: {
    opening:  { type: String, default: '09:00 AM' },
    closing:  { type: String, default: '08:00 PM' },
    closedOn: { type: String, default: 'Sunday' },
  },
  products: [{
    name:     { type: String },
    category: { type: String, enum: ['fertilizer', 'pesticide', 'seed', 'equipment', 'other'] },
    price:    { type: Number },
    inStock:  { type: Boolean, default: true },
  }],
  services:     [{ type: String }],
  rating:       { type: Number, default: 0 },
  totalRatings: { type: Number, default: 0 },
  isVerified:   { type: Boolean, default: false },
  isActive:     { type: Boolean, default: true },
  addedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt:    { type: Date, default: Date.now },
  updatedAt:    { type: Date, default: Date.now },
});

const adSchema = new mongoose.Schema({
  title:           { type: String, required: true },
  teluguTitle:     { type: String },
  description:     { type: String },
  advertiserId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  advertiserName:  { type: String },
  advertiserPhone: { type: String },
  type:            { type: String, enum: ['banner', 'sponsored', 'featured'], default: 'banner' },
  placement:       { type: String, enum: ['home', 'home_premium', 'marketplace', 'equipment', 'solutions', 'all'], default: 'home' },
  targetAudience: {
    roles:    [{ type: String, enum: ['farmer', 'labourer', 'contractor', 'buyer'] }],
    location: { type: String },
    cropType: { type: String },
  },
  media: {
    imageUrl:    { type: String },
    videoUrl:    { type: String },
    redirectUrl: { type: String },
  },
  budget:        { type: Number, required: true },
  duration:      { type: Number, required: true },
  impressions:   { type: Number, default: 0 },
  clicks:        { type: Number, default: 0 },
  status:        { type: String, enum: ['pending', 'active', 'paused', 'completed', 'rejected'], default: 'pending' },
  startDate:     { type: Date },
  endDate:       { type: Date },
  paymentStatus: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  paymentId:     { type: String },
  isActive:      { type: Boolean, default: true },
  createdAt:     { type: Date, default: Date.now },
  updatedAt:     { type: Date, default: Date.now },
});

const paymentSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  adId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', required: true },
  amount:       { type: Number, required: true },
  paymentMethod: { type: String, default: 'upi' },
  status:       { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  paidAt:       { type: Date },
  createdAt:    { type: Date, default: Date.now },
  updatedAt:    { type: Date, default: Date.now },
});

const User           = mongoose.model('User',           userSchema);
const Equipment      = mongoose.model('Equipment',      equipmentSchema);
const Produce        = mongoose.model('Produce',        produceSchema);
const Booking        = mongoose.model('Booking',        bookingSchema);
const Report         = mongoose.model('Report',         reportSchema);
const Problem        = mongoose.model('Problem',        problemSchema);
const Solution       = mongoose.model('Solution',       solutionSchema);
const FertilizerShop = mongoose.model('FertilizerShop', fertilizerShopSchema);
const Ad             = mongoose.model('Ad',             adSchema);
const Payment        = mongoose.model('Payment',        paymentSchema);

// ==================== AUTH MIDDLEWARE ====================
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const rawToken = authHeader.split(' ')[1];

    if (!firebaseAdmin && process.env.NODE_ENV === 'development') {
      req.user = { _id: 'demo123', email: 'demo@example.com', role: 'farmer' };
      return next();
    }

    if (rawToken.startsWith('eyJ')) {
      try {
        const decoded = jwt.verify(rawToken, process.env.JWT_SECRET || 'agriagent-secret-key');
        const user = await User.findById(decoded.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        if (!user.isActive) return res.status(401).json({ error: 'Account deactivated' });
        req.user = user;
        return next();
      } catch (jwtError) {
        return res.status(401).json({ error: 'Invalid JWT token' });
      }
    }

    if (rawToken.startsWith('google_')) {
      const accessToken = rawToken.slice(7);
      const tokenInfoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
      const tokenInfo = await tokenInfoRes.json();
      if (!tokenInfoRes.ok || tokenInfo.error) return res.status(401).json({ error: 'Invalid Google token' });
      const user = await User.findOne({ email: tokenInfo.email });
      if (!user) return res.status(401).json({ error: 'User not found' });
      if (!user.isActive) return res.status(401).json({ error: 'Account deactivated' });
      req.user = user;
      return next();
    }

    if (!firebaseAdmin) return res.status(401).json({ error: 'Auth service not configured' });
    const decodedToken = await firebaseAdmin.auth().verifyIdToken(rawToken);
    let user = await User.findOne({ firebaseUid: decodedToken.uid });
    if (!user) {
      user = await User.create({
        firebaseUid: decodedToken.uid,
        email: decodedToken.email,
        profile: { name: decodedToken.name || decodedToken.email.split('@')[0], profileImage: decodedToken.picture },
      });
    }
    if (!user.isActive) return res.status(401).json({ error: 'Account deactivated' });
    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    res.status(401).json({ error: 'Authentication failed' });
  }
};

// ==================== HELPER ====================
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  if (!lat1 || !lng1 || !lat2 || !lng2) return 999;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
};

// ==================== CONFIG ENDPOINTS ====================
app.get('/api/config/upi', (req, res) => {
  res.json({
    success: true,
    upiId: process.env.MERCHANT_UPI_ID || 'agriagent@upi',
    merchantName: process.env.MERCHANT_NAME || 'AgriAgent Technologies',
  });
});

// ==================== CATBOX UPLOAD ====================
app.post('/api/upload/catbox', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    console.log('📤 Uploading to Catbox:', {
      filename: req.file.originalname,
      size:     req.file.size,
      mimetype: req.file.mimetype,
    });

    const FormDataLib = require('form-data');
    const form = new FormDataLib();

    // reqtype MUST come before fileToUpload
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', req.file.buffer, {
      filename:    req.file.originalname || `upload_${Date.now()}.jpg`,
      contentType: req.file.mimetype || 'image/jpeg',
      knownLength: req.file.size,
    });

    // Provide exact Content-Length so Catbox doesn't reject chunked bodies
    const contentLength = await new Promise((resolve, reject) =>
      form.getLength((err, len) => err ? reject(err) : resolve(len))
    );

    const response = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: {
        ...form.getHeaders(),
        'Content-Length': contentLength,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout:          60000,
      maxContentLength: Infinity,
      maxBodyLength:    Infinity,
    });

    console.log('📥 Catbox response:', response.status, JSON.stringify(response.data));

    const result = typeof response.data === 'string' ? response.data.trim() : String(response.data).trim();
    if (result.startsWith('http')) {
      return res.json({ success: true, url: result });
    }

    console.error('❌ Catbox unexpected response:', response.data);
    return res.status(500).json({ error: `Upload failed: ${result}` });

  } catch (error) {
    const status = error.response?.status;
    const body   = error.response?.data;
    const msg    = error.message;
    console.error('❌ Catbox upload error:', { msg, status, body });
    return res.status(500).json({ error: `Upload failed: ${body || msg}` });
  }
});

// ==================== HEALTH CHECK ====================
app.get('/health', async (req, res) => {
  const dbStatus = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' }[mongoose.connection.readyState] || 'unknown';
  res.json({ status: 'OK', timestamp: new Date().toISOString(), uptime: process.uptime(), mongodb: dbStatus, firebase: !!firebaseAdmin });
});

app.get('/', (req, res) => {
  res.json({ message: 'AgriAgent API', version: '1.0.0', status: 'active' });
});

// ==================== AUTH ROUTES ====================
app.get('/api/auth/google-mobile/callback', async (req, res) => {
  try {
    const { code, state: codeVerifier, error: googleError } = req.query;
    if (googleError) return res.redirect(302, `agriagent://auth?error=${encodeURIComponent(googleError)}`);
    if (!code || !codeVerifier) return res.redirect(302, `agriagent://auth?error=${encodeURIComponent('Missing parameters')}`);

    const redirectUri = `${process.env.API_BASE_URL}/api/auth/google-mobile/callback`;
    const { tokens } = await googleOAuthClient.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.access_token) return res.redirect(302, `agriagent://auth?error=${encodeURIComponent('Failed to obtain token')}`);

    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const googleUser = await userInfoRes.json();
    if (!googleUser.email || !googleUser.sub) return res.redirect(302, `agriagent://auth?error=${encodeURIComponent('Failed to fetch user info')}`);

    let user = await User.findOne({ $or: [{ email: googleUser.email }, { googleId: googleUser.sub }] });
    if (!user) {
      user = await User.create({ googleId: googleUser.sub, email: googleUser.email, profile: { name: googleUser.name, profileImage: googleUser.picture } });
    } else if (!user.googleId) {
      user.googleId = googleUser.sub;
      await user.save();
    }

    const appToken = jwt.sign({ userId: user._id, email: user.email, role: user.role }, process.env.JWT_SECRET || 'agriagent-secret-key', { expiresIn: '30d' });
    const params = new URLSearchParams({ token: appToken, userId: user._id.toString(), email: user.email, role: user.role });
    return res.redirect(302, `agriagent://auth?${params.toString()}`);
  } catch (error) {
    return res.redirect(302, `agriagent://auth?error=${encodeURIComponent(error.message)}`);
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { email, name, picture, googleId } = req.body;
    if (!googleId) return res.status(400).json({ error: 'Invalid Google ID' });
    let user = await User.findOne({ $or: [{ email }, { googleId }] });
    if (!user) user = await User.create({ googleId, email, profile: { name, profileImage: picture } });
    res.json({ success: true, user: { id: user._id, email: user.email, role: user.role } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/auth/google-mobile', async (req, res) => {
  try {
    const { code, codeVerifier, redirectUri } = req.body;
    googleOAuthClient.redirectUri = redirectUri;
    const { tokens } = await googleOAuthClient.getToken({ code, codeVerifier });
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const googleUser = await userInfoRes.json();
    let user = await User.findOne({ email: googleUser.email });
    if (!user) user = await User.create({ googleId: googleUser.sub, email: googleUser.email, profile: { name: googleUser.name, profileImage: googleUser.picture } });
    else if (!user.googleId) { user.googleId = googleUser.sub; await user.save(); }
    res.json({ success: true, idToken: tokens.access_token, user: { id: user._id, email: user.email, role: user.role } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/auth/session', authenticate, async (req, res) => {
  res.json({ success: true, user: { id: req.user._id, email: req.user.email, role: req.user.role } });
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  res.json({ success: true, user: req.user });
});

app.put('/api/auth/role', authenticate, async (req, res) => {
  const { role } = req.body;
  if (!['farmer', 'labourer', 'contractor', 'buyer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  req.user.role = role;
  await req.user.save();
  res.json({ success: true });
});

app.put('/api/auth/profile', authenticate, async (req, res) => {
  const { name, teluguName, phone, location, labourerDetails, contractorDetails } = req.body;
  if (name) req.user.profile.name = name;
  if (teluguName) req.user.profile.teluguName = teluguName;
  if (phone) req.user.profile.phone = phone;
  if (location) req.user.profile.location = location;
  if (labourerDetails) req.user.labourerDetails = labourerDetails;
  if (contractorDetails) req.user.contractorDetails = contractorDetails;
  req.user.updatedAt = Date.now();
  await req.user.save();
  res.json({ success: true });
});

app.post('/api/auth/verify-age', authenticate, async (req, res) => {
  const { age } = req.body;
  if (age < 18) return res.status(400).json({ error: 'Must be 18+' });
  req.user.ageVerified = true;
  req.user.age = age;
  await req.user.save();
  res.json({ success: true });
});

// ==================== USER MANAGEMENT ====================
app.delete('/api/users/delete-account', authenticate, async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { isActive: false, deletedAt: new Date() });
  res.json({ success: true });
});

// ==================== EQUIPMENT ====================
app.get('/api/equipment', async (req, res) => {
  const { category, search } = req.query;
  const query = { 'availability.isAvailable': true, isActive: true };
  if (category && category !== 'all') query.category = category;
  if (search) query.$or = [{ name: { $regex: search, $options: 'i' } }];
  const equipment = await Equipment.find(query).populate('ownerId', 'profile.name profile.profileImage verification.isVerified ratings').sort('-createdAt').limit(50);
  res.json({ success: true, equipment });
});

// UPDATED: includes profile.phone and debug logging
app.get('/api/equipment/:id', async (req, res) => {
  try {
    const equipment = await Equipment.findById(req.params.id)
      .populate('ownerId', 'profile.name profile.profileImage profile.phone verification.isVerified ratings');

    if (!equipment) return res.status(404).json({ error: 'Not found' });

    console.log('Equipment owner data:', {
      name:  equipment.ownerId?.profile?.name,
      phone: equipment.ownerId?.profile?.phone,
    });

    res.json({ success: true, equipment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATED: saves contactPhone to user profile if phone is missing
app.post('/api/equipment', authenticate, async (req, res) => {
  try {
    if (!req.user.profile?.phone && req.body.contactPhone) {
      req.user.profile.phone = req.body.contactPhone;
      await req.user.save();
    }

    const equipment = await Equipment.create({ ...req.body, ownerId: req.user._id });
    res.status(201).json({ success: true, equipment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/equipment/:id', authenticate, async (req, res) => {
  const equipment = await Equipment.findById(req.params.id);
  if (!equipment) return res.status(404).json({ error: 'Not found' });
  if (equipment.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  Object.assign(equipment, req.body);
  await equipment.save();
  res.json({ success: true, equipment });
});

app.delete('/api/equipment/:id', authenticate, async (req, res) => {
  const equipment = await Equipment.findById(req.params.id);
  if (!equipment) return res.status(404).json({ error: 'Not found' });
  if (equipment.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  await equipment.deleteOne();
  res.json({ success: true });
});

// ==================== PRODUCE ====================
app.get('/api/produce', async (req, res) => {
  const { crop, search } = req.query;
  const query = { isAvailable: true, isActive: true };
  if (crop && crop !== 'all') query.cropName = crop;
  if (search) query.$or = [{ cropName: { $regex: search, $options: 'i' } }];
  const produce = await Produce.find(query).populate('farmerId', 'profile.name profile.profileImage verification.isVerified ratings').sort('-createdAt').limit(50);
  res.json({ success: true, produce });
});

app.get('/api/produce/:id', async (req, res) => {
  const produce = await Produce.findById(req.params.id).populate('farmerId', 'profile.name profile.profileImage profile.phone verification.isVerified ratings');
  if (!produce) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true, produce });
});

app.post('/api/produce', authenticate, async (req, res) => {
  const produce = await Produce.create({ ...req.body, farmerId: req.user._id });
  res.status(201).json({ success: true, produce });
});

// ==================== BOOKINGS ====================
app.get('/api/bookings', authenticate, async (req, res) => {
  const bookings = await Booking.find({ $or: [{ renterId: req.user._id }, { ownerId: req.user._id }] }).sort('-createdAt');
  res.json({ success: true, bookings });
});

app.post('/api/bookings', authenticate, async (req, res) => {
  const booking = await Booking.create({ ...req.body, renterId: req.user._id });
  res.status(201).json({ success: true, booking });
});

app.put('/api/bookings/:id', authenticate, async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Not found' });
  if (booking.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  booking.status = req.body.status;
  await booking.save();
  res.json({ success: true, booking });
});

// ==================== PROBLEMS & SOLUTIONS ====================
app.get('/api/problems', async (req, res) => {
  const { crop, search } = req.query;
  const query = { isActive: true };
  if (crop && crop !== 'all') query.cropType = crop;
  if (search) query.$or = [{ title: { $regex: search, $options: 'i' } }];
  const problems = await Problem.find(query).populate('farmerId', 'profile.name profile.profileImage verification.isVerified').sort('-upvotes').limit(50);
  res.json({ success: true, problems });
});

app.get('/api/problems/:id', async (req, res) => {
  const problem = await Problem.findById(req.params.id).populate('farmerId', 'profile.name profile.profileImage verification.isVerified ratings');
  if (!problem) return res.status(404).json({ error: 'Not found' });
  const solutions = await Solution.find({ problemId: problem._id, isActive: true }).populate('farmerId', 'profile.name profile.profileImage verification.isVerified').sort('-upvotes');
  res.json({ success: true, problem, solutions });
});

app.post('/api/problems', authenticate, async (req, res) => {
  const problem = await Problem.create({ ...req.body, farmerId: req.user._id });
  res.status(201).json({ success: true, problem });
});

app.post('/api/problems/:id/solutions', authenticate, async (req, res) => {
  const solution = await Solution.create({ problemId: req.params.id, farmerId: req.user._id, ...req.body });
  await Problem.findByIdAndUpdate(req.params.id, { $inc: { solutionCount: 1 } });
  res.status(201).json({ success: true, solution });
});

app.post('/api/problems/:id/upvote', authenticate, async (req, res) => {
  const problem = await Problem.findById(req.params.id);
  if (!problem) return res.status(404).json({ error: 'Not found' });
  const hasUpvoted = problem.upvotedBy.includes(req.user._id);
  if (hasUpvoted) { problem.upvotes -= 1; problem.upvotedBy.pull(req.user._id); }
  else { problem.upvotes += 1; problem.upvotedBy.push(req.user._id); }
  await problem.save();
  res.json({ success: true, upvotes: problem.upvotes });
});

app.post('/api/solutions/:id/upvote', authenticate, async (req, res) => {
  const solution = await Solution.findById(req.params.id);
  if (!solution) return res.status(404).json({ error: 'Not found' });
  const hasUpvoted = solution.upvotedBy.includes(req.user._id);
  if (hasUpvoted) { solution.upvotes -= 1; solution.upvotedBy.pull(req.user._id); }
  else { solution.upvotes += 1; solution.upvotedBy.push(req.user._id); }
  await solution.save();
  res.json({ success: true, upvotes: solution.upvotes });
});

// ==================== LABOURERS ====================
app.get('/api/labourers/nearby', async (req, res) => {
  const { lat, lng, radius = 10, crop } = req.query;
  const query = { role: 'labourer', 'labourerDetails.isAvailable': true, isActive: true };
  if (crop && crop !== 'all') query['labourerDetails.skills'] = crop;
  let labourers = await User.find(query).select('profile labourerDetails ratings verification email').sort('-ratings.average').limit(50);
  if (lat && lng) {
    labourers = labourers.map(lab => ({ ...lab.toObject(), distance: calculateDistance(lat, lng, lab.profile.location?.lat, lab.profile.location?.lng) }))
      .filter(lab => lab.distance <= Number(radius)).sort((a, b) => a.distance - b.distance);
  }
  res.json({ success: true, labourers });
});

app.get('/api/labourers', async (req, res) => {
  const { crop } = req.query;
  const query = { role: 'labourer', isActive: true };
  if (crop && crop !== 'all') query['labourerDetails.skills'] = crop;
  const labourers = await User.find(query).select('profile labourerDetails ratings verification email').sort('-ratings.average').limit(100);
  res.json({ success: true, labourers });
});

// ==================== CONTRACTORS ====================
app.get('/api/contractors', async (req, res) => {
  const { crop } = req.query;
  const query = { role: 'contractor', isActive: true };
  if (crop && crop !== 'all') query['contractorDetails.crops'] = crop;
  const contractors = await User.find(query).select('profile contractorDetails ratings verification email').sort('-ratings.average').limit(100);
  res.json({ success: true, contractors });
});

// ==================== DASHBOARD ====================
app.get('/api/dashboard/stats', authenticate, async (req, res) => {
  const [equipmentCount, produceCount] = await Promise.all([
    Equipment.countDocuments({ ownerId: req.user._id }),
    Produce.countDocuments({ farmerId: req.user._id }),
  ]);
  res.json({ success: true, stats: { equipmentListed: equipmentCount, produceListed: produceCount } });
});

// ==================== FERTILIZER SHOPS ====================
app.get('/api/fertilizer-shops/nearby', async (req, res) => {
  const { lat, lng, radius = 10, search } = req.query;
  let query = { isActive: true };
  if (search) query.$or = [{ name: { $regex: search, $options: 'i' } }, { 'location.village': { $regex: search, $options: 'i' } }];
  let shops = await FertilizerShop.find(query).sort('-isVerified').limit(100);
  if (lat && lng) {
    shops = shops.map(shop => ({ ...shop.toObject(), distance: calculateDistance(parseFloat(lat), parseFloat(lng), shop.location.lat, shop.location.lng) }))
      .filter(shop => shop.distance <= parseFloat(radius)).sort((a, b) => a.distance - b.distance);
  }
  res.json({ success: true, shops });
});

app.get('/api/fertilizer-shops', async (req, res) => {
  const { search, district } = req.query;
  const query = { isActive: true };
  if (search) query.$or = [{ name: { $regex: search, $options: 'i' } }];
  if (district) query['location.district'] = { $regex: district, $options: 'i' };
  const shops = await FertilizerShop.find(query).sort('-rating').limit(100);
  res.json({ success: true, shops });
});

app.get('/api/fertilizer-shops/:id', async (req, res) => {
  const shop = await FertilizerShop.findById(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true, shop });
});

app.post('/api/fertilizer-shops', authenticate, async (req, res) => {
  const shop = await FertilizerShop.create({ ...req.body, addedBy: req.user._id });
  res.status(201).json({ success: true, shop });
});

app.put('/api/fertilizer-shops/:id', authenticate, async (req, res) => {
  const shop = await FertilizerShop.findById(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Not found' });
  if (shop.addedBy?.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  Object.assign(shop, req.body);
  shop.updatedAt = Date.now();
  await shop.save();
  res.json({ success: true, shop });
});

app.post('/api/fertilizer-shops/:id/rate', authenticate, async (req, res) => {
  const { rating } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating 1-5 required' });
  const shop = await FertilizerShop.findById(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Not found' });
  shop.rating = Math.round(((shop.rating * shop.totalRatings + rating) / (shop.totalRatings + 1)) * 10) / 10;
  shop.totalRatings += 1;
  await shop.save();
  res.json({ success: true, rating: shop.rating });
});

// ==================== ADS ====================
app.get('/api/ads/my-ads', authenticate, async (req, res) => {
  const ads = await Ad.find({ advertiserId: req.user._id }).sort('-createdAt');
  res.json({ success: true, ads });
});

app.get('/api/ads/active', async (req, res) => {
  const { placement, limit = 5 } = req.query;
  const query = { status: 'active', isActive: true, startDate: { $lte: new Date() }, endDate: { $gte: new Date() } };
  if (placement && placement !== 'all') query.placement = { $in: [placement, 'all'] };
  const ads = await Ad.find(query).sort('-createdAt').limit(parseInt(limit));
  await Ad.updateMany({ _id: { $in: ads.map(ad => ad._id) } }, { $inc: { impressions: 1 } });
  res.json({ success: true, ads });
});

app.post('/api/ads', authenticate, async (req, res) => {
  const adData = {
    ...req.body,
    advertiserId: req.user._id,
    advertiserName: req.user.profile?.name,
    advertiserPhone: req.user.profile?.phone,
    startDate: new Date(),
    endDate: new Date(Date.now() + req.body.duration * 24 * 60 * 60 * 1000),
  };
  const ad = await Ad.create(adData);
  res.status(201).json({ success: true, ad });
});

app.put('/api/ads/:id/status', authenticate, async (req, res) => {
  const ad = await Ad.findById(req.params.id);
  if (!ad) return res.status(404).json({ error: 'Not found' });
  if (ad.advertiserId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  ad.status = req.body.status;
  ad.updatedAt = Date.now();
  await ad.save();
  res.json({ success: true, ad });
});

app.post('/api/ads/:id/click', async (req, res) => {
  await Ad.findByIdAndUpdate(req.params.id, { $inc: { clicks: 1 } });
  res.json({ success: true });
});

app.get('/api/admin/ads', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const ads = await Ad.find().sort('-createdAt').populate('advertiserId', 'profile.name email');
  res.json({ success: true, ads });
});

// ==================== PAYMENTS ====================
app.post('/api/payments/upi', authenticate, async (req, res) => {
  try {
    const { adId, amount } = req.body;
    if (!adId || !amount) return res.status(400).json({ error: 'Ad ID and amount required' });

    const payment = await Payment.create({
      userId: req.user._id,
      adId,
      amount,
      paymentMethod: 'upi',
      status: 'pending',
    });

    res.json({
      success: true,
      paymentId: payment._id,
      upiDetails: {
        upiId: process.env.MERCHANT_UPI_ID || 'agriagent@upi',
        merchantName: process.env.MERCHANT_NAME || 'AgriAgent Technologies',
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/payments/check-status/:adId', authenticate, async (req, res) => {
  try {
    const payment = await Payment.findOne({ adId: req.params.adId, userId: req.user._id }).sort('-createdAt');
    if (!payment) return res.json({ success: true, paymentStatus: 'not_found' });

    if (payment.status === 'completed') {
      const ad = await Ad.findById(req.params.adId);
      return res.json({ success: true, paymentStatus: 'completed', adStatus: ad?.status });
    }

    res.json({ success: true, paymentStatus: 'pending' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/payments/:id/verify', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Not found' });

    payment.status = 'completed';
    payment.paidAt = new Date();
    payment.updatedAt = new Date();
    await payment.save();

    await Ad.findByIdAndUpdate(payment.adId, {
      status: 'active',
      paymentStatus: 'completed',
      paymentId: payment._id.toString(),
      updatedAt: new Date(),
    });

    res.json({ success: true, message: 'Payment verified, ad activated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/payments/history', authenticate, async (req, res) => {
  const payments = await Payment.find({ userId: req.user._id }).populate('adId', 'title placement budget status').sort('-createdAt').limit(20);
  res.json({ success: true, payments });
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
    console.log(`📍 Health: http://localhost:${PORT}/health`);
    console.log(`📍 UPI Config: http://localhost:${PORT}/api/config/upi`);
    console.log(`📍 Catbox: http://localhost:${PORT}/api/upload/catbox`);
  });
});
