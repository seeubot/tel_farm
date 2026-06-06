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
const crypto = require('crypto');
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
  origin: ['http://localhost:19000', 'http://localhost:19006', 'http://localhost:3000', 'http://localhost:5000', 'https://*.koyeb.app', 'exp://*', '*'],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type'), false);
  },
});

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Too many requests' } });
app.use('/api/', limiter);

// ==================== MODELS ====================
const userSchema = new mongoose.Schema({
  firebaseUid: { type: String, unique: true, sparse: true },
  googleId:    { type: String, unique: true, sparse: true },
  email:       { type: String, required: true, unique: true },
  roles:       [{ type: String, enum: ['farmer', 'labourer', 'contractor', 'buyer'] }],
  role:        { type: String, enum: ['farmer', 'labourer', 'contractor', 'buyer'], default: 'farmer' },
  ageVerified: { type: Boolean, default: false },
  age:         { type: Number },
  profile: {
    name:         { type: String, required: true },
    teluguName:   { type: String },
    phone:        { type: String },
    profileImage: { type: String },
    location: { lat: Number, lng: Number, address: String, village: String, district: String },
  },
  verification: {
    isPhoneVerified:  { type: Boolean, default: false },
    isAadharVerified: { type: Boolean, default: false },
    isVerified:       { type: Boolean, default: false },
    verifiedAt: Date,
    documents: { aadharUrl: String, panUrl: String },
  },
  labourerDetails: { age: Number, experience: Number, skills: [String], isAvailable: { type: Boolean, default: true } },
  contractorDetails: { companyName: String, gstNumber: String, teamSize: String, crops: [String], isActive: { type: Boolean, default: true } },
  ratings: { average: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
  isActive:  { type: Boolean, default: true },
  deletedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const equipmentSchema = new mongoose.Schema({
  ownerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:     { type: String, required: true },
  teluguName: { type: String },
  category: { type: String, enum: ['Tractor', 'Harvester', 'Irrigation Pump', 'Power Tiller', 'Sprayer', 'Processing Machine', 'Trailer', 'Other'], required: true },
  description: { type: String },
  pricing: { perDay: { type: Number, required: true }, perHour: { type: Number }, deposit: { type: Number, required: true } },
  location: { lat: { type: Number, required: true }, lng: { type: Number, required: true }, address: String, village: String, district: String },
  features: [String],
  images:   [String],
  availability: { isAvailable: { type: Boolean, default: true }, availableFrom: Date, availableTo: Date },
  ratings:      { average: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
  isVerified:   { type: Boolean, default: false },
  totalRentals: { type: Number, default: 0 },
  isActive:     { type: Boolean, default: true },
  createdAt:    { type: Date, default: Date.now },
});

const produceSchema = new mongoose.Schema({
  farmerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  cropName:   { type: String, required: true },
  teluguName: { type: String }, variety: String,
  quantity:   { type: Number, required: true }, unit: { type: String, default: 'kg' },
  price:      { type: Number, required: true }, priceUnit: { type: String, default: 'per quintal' },
  location:   { lat: Number, lng: Number, address: String, village: String },
  description: String, organic: { type: Boolean, default: false }, harvestDate: Date,
  images: [String], isAvailable: { type: Boolean, default: true }, isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

const bookingSchema = new mongoose.Schema({
  type:       { type: String, enum: ['equipment', 'produce'], required: true },
  itemId:     { type: mongoose.Schema.Types.ObjectId, required: true },
  renterId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ownerId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  startDate: Date, endDate: Date, quantity: Number, totalAmount: Number, deposit: Number,
  status:     { type: String, enum: ['pending', 'confirmed', 'completed', 'cancelled'], default: 'pending' },
  rentalType: { type: String, enum: ['self', 'withOperator'] },
  createdAt:  { type: Date, default: Date.now },
});

const reportSchema = new mongoose.Schema({
  reporterId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:        { type: String, enum: ['user', 'equipment', 'produce'], required: true },
  targetId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  reason:      { type: String, required: true }, description: String,
  status:      { type: String, enum: ['pending', 'reviewed', 'resolved'], default: 'pending' },
  createdAt:   { type: Date, default: Date.now },
});

const problemSchema = new mongoose.Schema({
  farmerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:      { type: String, required: true }, teluguTitle: String,
  description: { type: String, required: true }, teluguDescription: String,
  cropType:   { type: String, required: true },
  location:   { lat: Number, lng: Number, address: String, village: String },
  type:       { type: String, enum: ['text', 'image', 'video'], default: 'text' },
  mediaUrl:   String, upvotes: { type: Number, default: 0 },
  upvotedBy:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  solutionCount: { type: Number, default: 0 },
  isActive:   { type: Boolean, default: true },
  createdAt:  { type: Date, default: Date.now },
});

const solutionSchema = new mongoose.Schema({
  problemId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Problem', required: true },
  farmerId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  solution:    { type: String, required: true }, teluguSolution: String,
  mediaUrl:    String, mediaType: { type: String, enum: ['image', 'video'] },
  upvotes:     { type: Number, default: 0 },
  upvotedBy:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  isActive:    { type: Boolean, default: true },
  createdAt:   { type: Date, default: Date.now },
});

const fertilizerShopSchema = new mongoose.Schema({
  name: String, teluguName: String, ownerName: String, phone: String, alternatePhone: String, email: String,
  location: { lat: Number, lng: Number, address: String, village: String, district: String, pincode: String },
  timings: { opening: { type: String, default: '09:00 AM' }, closing: { type: String, default: '08:00 PM' }, closedOn: { type: String, default: 'Sunday' } },
  products: [{ name: String, category: { type: String, enum: ['fertilizer', 'pesticide', 'seed', 'equipment', 'other'] }, price: Number, inStock: { type: Boolean, default: true } }],
  services: [String], rating: { type: Number, default: 0 }, totalRatings: { type: Number, default: 0 },
  isVerified: { type: Boolean, default: false }, isActive: { type: Boolean, default: true },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now },
});

const adSchema = new mongoose.Schema({
  title: String, teluguTitle: String, description: String,
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  advertiserName: String, advertiserPhone: String,
  type: { type: String, enum: ['banner', 'sponsored', 'featured'], default: 'banner' },
  placement: { type: String, enum: ['home', 'home_premium', 'marketplace', 'equipment', 'solutions', 'all'], default: 'home' },
  targetAudience: { roles: [{ type: String }], location: String, cropType: String },
  media: { imageUrl: String, videoUrl: String, redirectUrl: String },
  budget: Number, duration: Number, impressions: { type: Number, default: 0 }, clicks: { type: Number, default: 0 }, ctr: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'active', 'paused', 'completed', 'rejected'], default: 'pending' },
  startDate: Date, endDate: Date,
  paymentStatus: { type: String, enum: ['pending', 'pending_verification', 'completed', 'failed'], default: 'pending' },
  paymentId: String,
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now },
});

const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  adId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', required: true },
  amount: Number, currency: { type: String, default: 'INR' },
  paymentMethod: { type: String, enum: ['upi', 'card', 'netbanking', 'razorpay'], default: 'upi' },
  status: { type: String, enum: ['pending', 'pending_verification', 'completed', 'failed', 'refunded'], default: 'pending' },
  transactionId: String, upiTransactionId: String, utrNumber: String,
  userConfirmed: { type: Boolean, default: false }, userConfirmedAt: Date,
  paymentDetails: { upiId: String, cardLast4: String, bankName: String },
  paidAt: Date, createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now },
});

// ==================== ADMIN MODEL ====================
const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  email:    { type: String, required: true, unique: true },
  role:     { type: String, enum: ['admin', 'superadmin'], default: 'admin' },
  lastLogin: Date,
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// Hash password before saving
adminSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  const secret = process.env.JWT_SECRET || 'agriagent-secret-key';
  this.password = crypto.createHash('sha256').update(this.password + secret).digest('hex');
  next();
});

adminSchema.methods.comparePassword = async function(password) {
  const secret = process.env.JWT_SECRET || 'agriagent-secret-key';
  const hash = crypto.createHash('sha256').update(password + secret).digest('hex');
  return hash === this.password;
};

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
const Admin          = mongoose.model('Admin',          adminSchema);

// ==================== AUTH MIDDLEWARE ====================
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
    const rawToken = authHeader.split(' ')[1];

    // Check if it's an admin token
    try {
      const decoded = jwt.verify(rawToken, process.env.JWT_SECRET || 'agriagent-secret-key');
      if (decoded.type === 'admin') {
        const adminUser = await Admin.findById(decoded.adminId);
        if (!adminUser?.isActive) return res.status(401).json({ error: 'Admin account disabled' });
        req.admin = adminUser;
        req.user = { _id: 'admin', email: adminUser.email, role: 'admin', roles: ['admin'] };
        return next();
      }
    } catch (jwtError) {
      // Not an admin token, continue with user auth
    }

    if (!firebaseAdmin && process.env.NODE_ENV === 'development') {
      req.user = { _id: 'demo123', email: 'demo@example.com', role: 'farmer', roles: ['farmer'] };
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
      } catch (jwtError) { return res.status(401).json({ error: 'Invalid JWT token' }); }
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
        firebaseUid: decodedToken.uid, email: decodedToken.email,
        profile: { name: decodedToken.name || decodedToken.email.split('@')[0], profileImage: decodedToken.picture },
        roles: ['farmer'], role: 'farmer',
      });
    }
    if (!user.isActive) return res.status(401).json({ error: 'Account deactivated' });
    req.user = user;
    next();
  } catch (error) { console.error('Auth error:', error.message); res.status(401).json({ error: 'Authentication failed' }); }
};

// Admin-only middleware
const adminAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
    
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'agriagent-secret-key');
    
    if (decoded.type !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    
    const adminUser = await Admin.findById(decoded.adminId);
    if (!adminUser?.isActive) return res.status(401).json({ error: 'Admin account disabled' });
    
    req.admin = adminUser;
    next();
  } catch (error) {
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

// ==================== UPLOADS ====================
app.post('/api/upload/catbox', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', req.file.buffer, { filename: req.file.originalname || `upload_${Date.now()}.jpg`, contentType: req.file.mimetype });
    const response = await axios.post('https://catbox.moe/user/api.php', form, { headers: { ...form.getHeaders() }, timeout: 30000 });
    if (response.data && !response.data.includes('error') && response.data.startsWith('http')) {
      res.json({ success: true, url: response.data });
    } else { res.status(500).json({ error: 'Upload failed' }); }
  } catch (error) { res.status(500).json({ error: 'Upload failed: ' + error.message }); }
});

app.post('/api/upload/image', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const base64 = req.file.buffer.toString('base64');
    res.json({ success: true, url: `data:${req.file.mimetype};base64,${base64}` });
  } catch (error) { res.status(500).json({ error: 'Upload failed: ' + error.message }); }
});

// ==================== HEALTH ====================
app.get('/health', async (req, res) => {
  const dbStatus = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' }[mongoose.connection.readyState] || 'unknown';
  res.json({ status: 'OK', timestamp: new Date().toISOString(), mongodb: dbStatus });
});
app.get('/', (req, res) => res.json({ message: 'AgriAgent API', version: '1.0.0' }));

// ==================== ADMIN AUTH ROUTES ====================
// Admin Login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    
    const adminUser = await Admin.findOne({ 
      $or: [{ username }, { email: username }],
      isActive: true 
    });
    
    if (!adminUser) return res.status(401).json({ error: 'Invalid credentials' });
    
    const isMatch = await adminUser.comparePassword(password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
    
    adminUser.lastLogin = new Date();
    await adminUser.save();
    
    const token = jwt.sign(
      { adminId: adminUser._id, role: adminUser.role, type: 'admin' },
      process.env.JWT_SECRET || 'agriagent-secret-key',
      { expiresIn: '12h' }
    );
    
    res.json({ 
      success: true, 
      token,
      admin: {
        id: adminUser._id,
        username: adminUser.username,
        email: adminUser.email,
        role: adminUser.role
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin session check
app.get('/api/admin/session', adminAuth, async (req, res) => {
  res.json({ 
    success: true, 
    admin: {
      id: req.admin._id,
      username: req.admin.username,
      email: req.admin.email,
      role: req.admin.role
    }
  });
});

// Create initial admin (run once with setup key)
app.post('/api/admin/setup', async (req, res) => {
  try {
    const { setupKey, username, password, email } = req.body;
    
    // Verify setup key matches env variable
    if (setupKey !== process.env.ADMIN_SETUP_KEY) {
      return res.status(403).json({ error: 'Invalid setup key' });
    }
    
    // Check if admin already exists
    const existingAdmin = await Admin.findOne({ $or: [{ username }, { email }] });
    if (existingAdmin) return res.status(400).json({ error: 'Admin already exists' });
    
    const adminUser = await Admin.create({ 
      username, 
      password, 
      email, 
      role: 'superadmin' 
    });
    
    res.json({ 
      success: true, 
      message: 'Admin created successfully',
      admin: {
        id: adminUser._id,
        username: adminUser.username,
        email: adminUser.email,
        role: adminUser.role
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Change admin password
app.put('/api/admin/change-password', adminAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    
    const isMatch = await req.admin.comparePassword(currentPassword);
    if (!isMatch) return res.status(401).json({ error: 'Current password is incorrect' });
    
    req.admin.password = newPassword;
    await req.admin.save();
    
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN MANAGEMENT ROUTES ====================

// Get dashboard stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [
      totalUsers, 
      activeLabourers, 
      totalEquipment, 
      totalProduce,
      pendingPayments, 
      totalAds, 
      activeAds,
      totalBookings,
      pendingReports
    ] = await Promise.all([
      User.countDocuments({ isActive: true }),
      User.countDocuments({ isActive: true, roles: 'labourer', 'labourerDetails.isAvailable': true }),
      Equipment.countDocuments({ isActive: true }),
      Produce.countDocuments({ isActive: true, isAvailable: true }),
      Payment.countDocuments({ status: 'pending_verification' }),
      Ad.countDocuments(),
      Ad.countDocuments({ status: 'active' }),
      Booking.countDocuments({ status: 'pending' }),
      Report.countDocuments({ status: 'pending' })
    ]);
    
    res.json({
      success: true,
      stats: {
        totalUsers, 
        activeLabourers, 
        totalEquipment, 
        totalProduce,
        pendingPayments, 
        totalAds, 
        activeAds,
        totalBookings,
        pendingReports
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all users (admin only)
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const { search, role, page = 1, limit = 20 } = req.query;
    const query = { isActive: true };
    
    if (search) {
      query.$or = [
        { 'profile.name': { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { 'profile.phone': { $regex: search, $options: 'i' } }
      ];
    }
    
    if (role) query.roles = role;
    
    const total = await User.countDocuments(query);
    const users = await User.find(query)
      .select('-__v')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    res.json({ 
      success: true, 
      users,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single user details
app.get('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-__v');
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Get user's equipment, produce, bookings
    const [equipment, produce, bookings] = await Promise.all([
      Equipment.find({ ownerId: user._id }),
      Produce.find({ farmerId: user._id }),
      Booking.find({ $or: [{ renterId: user._id }, { ownerId: user._id }] })
    ]);
    
    res.json({ 
      success: true, 
      user,
      details: {
        equipmentCount: equipment.length,
        produceCount: produce.length,
        bookingCount: bookings.length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle user active status
app.put('/api/admin/users/:id/toggle', adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    user.isActive = !user.isActive;
    user.updatedAt = new Date();
    await user.save();
    
    res.json({ success: true, isActive: user.isActive });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user verification status
app.put('/api/admin/users/:id/verify', adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    user.verification.isVerified = true;
    user.verification.verifiedAt = new Date();
    await user.save();
    
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN AD MANAGEMENT ====================

// Get all ads
app.get('/api/admin/ads', adminAuth, async (req, res) => {
  try {
    const { status, type, page = 1, limit = 50 } = req.query;
    const query = {};
    
    if (status) query.status = status;
    if (type) query.type = type;
    
    const total = await Ad.countDocuments(query);
    const ads = await Ad.find(query)
      .populate('advertiserId', 'profile.name profile.phone email')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    res.json({ 
      success: true, 
      ads,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update ad status
app.put('/api/admin/ads/:id/status', adminAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'active', 'paused', 'completed', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    const ad = await Ad.findByIdAndUpdate(
      req.params.id,
      { status, updatedAt: new Date() },
      { new: true }
    ).populate('advertiserId', 'profile.name email');
    
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    
    res.json({ success: true, ad });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN PAYMENT MANAGEMENT ====================

// Get all payments
app.get('/api/admin/payments', adminAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const query = {};
    
    if (status) query.status = status;
    
    const total = await Payment.countDocuments(query);
    const payments = await Payment.find(query)
      .populate('userId', 'profile.name email profile.phone')
      .populate('adId', 'title type budget')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    res.json({ 
      success: true, 
      payments,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify payment
app.put('/api/admin/payments/:id/verify', adminAuth, async (req, res) => {
  try {
    const payment = await Payment.findByIdAndUpdate(
      req.params.id,
      { 
        status: 'completed', 
        paidAt: new Date(),
        updatedAt: new Date() 
      },
      { new: true }
    );
    
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    
    // Activate associated ad
    if (payment.adId) {
      await Ad.findByIdAndUpdate(payment.adId, { 
        status: 'active', 
        paymentStatus: 'completed',
        updatedAt: new Date()
      });
    }
    
    res.json({ success: true, payment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reject payment
app.put('/api/admin/payments/:id/reject', adminAuth, async (req, res) => {
  try {
    const payment = await Payment.findByIdAndUpdate(
      req.params.id,
      { 
        status: 'failed', 
        updatedAt: new Date() 
      },
      { new: true }
    );
    
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    
    // Update associated ad payment status
    if (payment.adId) {
      await Ad.findByIdAndUpdate(payment.adId, { 
        paymentStatus: 'failed',
        updatedAt: new Date()
      });
    }
    
    res.json({ success: true, payment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN REPORT MANAGEMENT ====================

// Get all reports
app.get('/api/admin/reports', adminAuth, async (req, res) => {
  try {
    const { status, type, page = 1, limit = 50 } = req.query;
    const query = {};
    
    if (status) query.status = status;
    if (type) query.type = type;
    
    const total = await Report.countDocuments(query);
    const reports = await Report.find(query)
      .populate('reporterId', 'profile.name email')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    res.json({ 
      success: true, 
      reports,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update report status
app.put('/api/admin/reports/:id', adminAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'reviewed', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    const report = await Report.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate('reporterId', 'profile.name email');
    
    if (!report) return res.status(404).json({ error: 'Report not found' });
    
    res.json({ success: true, report });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN EQUIPMENT MANAGEMENT ====================

// Get all equipment
app.get('/api/admin/equipment', adminAuth, async (req, res) => {
  try {
    const { category, isVerified, page = 1, limit = 50 } = req.query;
    const query = {};
    
    if (category) query.category = category;
    if (isVerified !== undefined) query.isVerified = isVerified === 'true';
    
    const total = await Equipment.countDocuments(query);
    const equipment = await Equipment.find(query)
      .populate('ownerId', 'profile.name profile.phone email')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    res.json({ 
      success: true, 
      equipment,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify equipment
app.put('/api/admin/equipment/:id/verify', adminAuth, async (req, res) => {
  try {
    const equipment = await Equipment.findByIdAndUpdate(
      req.params.id,
      { isVerified: true },
      { new: true }
    );
    
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });
    
    res.json({ success: true, equipment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN FERTILIZER SHOP MANAGEMENT ====================

// Get all shops
app.get('/api/admin/shops', adminAuth, async (req, res) => {
  try {
    const { isVerified, page = 1, limit = 50 } = req.query;
    const query = {};
    
    if (isVerified !== undefined) query.isVerified = isVerified === 'true';
    
    const total = await FertilizerShop.countDocuments(query);
    const shops = await FertilizerShop.find(query)
      .populate('addedBy', 'profile.name email')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    res.json({ 
      success: true, 
      shops,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify shop
app.put('/api/admin/shops/:id/verify', adminAuth, async (req, res) => {
  try {
    const shop = await FertilizerShop.findByIdAndUpdate(
      req.params.id,
      { isVerified: true, updatedAt: new Date() },
      { new: true }
    );
    
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    
    res.json({ success: true, shop });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== AUTH ROUTES ====================
app.get('/api/auth/google-mobile/callback', async (req, res) => {
  try {
    const { code, state: codeVerifier, error: googleError } = req.query;
    if (googleError) return res.redirect(302, `agriagent://auth?error=${encodeURIComponent(googleError)}`);
    if (!code || !codeVerifier) return res.redirect(302, `agriagent://auth?error=Missing parameters`);
    const redirectUri = `${process.env.API_BASE_URL}/api/auth/google-mobile/callback`;
    const { tokens } = await googleOAuthClient.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.access_token) return res.redirect(302, `agriagent://auth?error=Failed to obtain token`);
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const googleUser = await userInfoRes.json();
    if (!googleUser.email || !googleUser.sub) return res.redirect(302, `agriagent://auth?error=Failed to fetch user info`);
    let user = await User.findOne({ $or: [{ email: googleUser.email }, { googleId: googleUser.sub }] });
    if (!user) {
      user = await User.create({
        googleId: googleUser.sub, email: googleUser.email,
        profile: { name: googleUser.name, profileImage: googleUser.picture },
        roles: ['farmer'], role: 'farmer',
      });
    } else { if (!user.googleId) { user.googleId = googleUser.sub; await user.save(); } }
    const appToken = jwt.sign({ userId: user._id, email: user.email, role: user.role }, process.env.JWT_SECRET || 'agriagent-secret-key', { expiresIn: '30d' });
    const params = new URLSearchParams({ token: appToken, userId: user._id.toString(), email: user.email, role: user.role });
    return res.redirect(302, `agriagent://auth?${params.toString()}`);
  } catch (error) { return res.redirect(302, `agriagent://auth?error=${encodeURIComponent(error.message)}`); }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { email, name, picture, googleId } = req.body;
    if (!googleId) return res.status(400).json({ error: 'Invalid Google ID' });
    let user = await User.findOne({ $or: [{ email }, { googleId }] });
    if (!user) user = await User.create({ googleId, email, profile: { name, profileImage: picture }, roles: ['farmer'], role: 'farmer' });
    res.json({ success: true, user: { id: user._id, email: user.email, role: user.role, roles: user.roles } });
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
    if (!user) user = await User.create({ googleId: googleUser.sub, email: googleUser.email, profile: { name: googleUser.name, profileImage: googleUser.picture }, roles: ['farmer'], role: 'farmer' });
    else if (!user.googleId) { user.googleId = googleUser.sub; await user.save(); }
    res.json({ success: true, idToken: tokens.access_token, user: { id: user._id, email: user.email, role: user.role } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/auth/session', authenticate, async (req, res) => res.json({ success: true, user: req.user }));
app.get('/api/auth/me', authenticate, async (req, res) => res.json({ success: true, user: req.user }));

app.put('/api/auth/role', authenticate, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['farmer', 'labourer', 'contractor', 'buyer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!req.user.roles) req.user.roles = ['farmer'];
    if (!req.user.roles.includes(role)) req.user.roles.push(role);
    req.user.role = role;
    await req.user.save();
    res.json({ success: true, roles: req.user.roles, role: req.user.role });
  } catch (error) { res.status(500).json({ error: error.message }); }
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
  res.json({ success: true, user: req.user });
});

app.post('/api/auth/verify-age', authenticate, async (req, res) => {
  const { age } = req.body;
  if (age < 18) return res.status(400).json({ error: 'Must be 18+' });
  req.user.ageVerified = true; req.user.age = age;
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
  if (search) query.$or = [{ name: { $regex: search, $options: 'i' } }, { teluguName: { $regex: search, $options: 'i' } }];
  const equipment = await Equipment.find(query).populate('ownerId', 'profile.name profile.profileImage verification.isVerified ratings').sort('-createdAt').limit(50);
  res.json({ success: true, equipment });
});

app.get('/api/equipment/:id', async (req, res) => {
  const equipment = await Equipment.findById(req.params.id).populate('ownerId', 'profile.name profile.profileImage profile.phone verification.isVerified ratings');
  if (!equipment) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true, equipment });
});

app.post('/api/equipment', authenticate, async (req, res) => {
  const equipment = await Equipment.create({ ...req.body, ownerId: req.user._id });
  res.status(201).json({ success: true, equipment });
});

app.put('/api/equipment/:id', authenticate, async (req, res) => {
  const equipment = await Equipment.findById(req.params.id);
  if (!equipment) return res.status(404).json({ error: 'Not found' });
  if (equipment.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  Object.assign(equipment, req.body); await equipment.save();
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
  const { crop, search, organic } = req.query;
  const query = { isAvailable: true, isActive: true };
  if (crop && crop !== 'all') query.cropName = crop;
  if (search) query.$or = [{ cropName: { $regex: search, $options: 'i' } }, { variety: { $regex: search, $options: 'i' } }];
  if (organic === 'true') query.organic = true;
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

app.put('/api/produce/:id', authenticate, async (req, res) => {
  const produce = await Produce.findById(req.params.id);
  if (!produce) return res.status(404).json({ error: 'Not found' });
  if (produce.farmerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  Object.assign(produce, req.body); await produce.save();
  res.json({ success: true, produce });
});

app.delete('/api/produce/:id', authenticate, async (req, res) => {
  const produce = await Produce.findById(req.params.id);
  if (!produce) return res.status(404).json({ error: 'Not found' });
  if (produce.farmerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  produce.isActive = false;
  await produce.save();
  res.json({ success: true, message: 'Produce listing removed' });
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
  booking.status = req.body.status; await booking.save();
  res.json({ success: true, booking });
});

// ==================== PROBLEMS & SOLUTIONS ====================
// GET all problems
app.get('/api/problems', async (req, res) => {
  try {
    const { crop, search } = req.query;
    const query = { isActive: true };
    if (crop && crop !== 'all') query.cropType = crop;
    if (search) query.$or = [{ title: { $regex: search, $options: 'i' } }, { description: { $regex: search, $options: 'i' } }];
    const problems = await Problem.find(query).populate('farmerId', 'profile.name profile.profileImage verification.isVerified').sort('-upvotes').limit(50);
    res.json({ success: true, problems });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET single problem with solutions
app.get('/api/problems/:id', async (req, res) => {
  try {
    const problem = await Problem.findById(req.params.id).populate('farmerId', 'profile.name profile.profileImage verification.isVerified ratings');
    if (!problem) return res.status(404).json({ error: 'Not found' });
    const solutions = await Solution.find({ problemId: problem._id, isActive: true }).populate('farmerId', 'profile.name profile.profileImage verification.isVerified').sort('-upvotes');
    res.json({ success: true, problem, solutions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE problem
app.post('/api/problems', authenticate, async (req, res) => {
  try {
    const problem = await Problem.create({ ...req.body, farmerId: req.user._id });
    res.status(201).json({ success: true, problem });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE problem
app.put('/api/problems/:id', authenticate, async (req, res) => {
  try {
    const problem = await Problem.findById(req.params.id);
    if (!problem) return res.status(404).json({ error: 'Problem not found' });
    
    // Only the creator or admin can update
    if (problem.farmerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    Object.assign(problem, req.body);
    await problem.save();
    
    res.json({ success: true, problem });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE problem (soft delete)
app.delete('/api/problems/:id', authenticate, async (req, res) => {
  try {
    const problem = await Problem.findById(req.params.id);
    
    if (!problem) {
      return res.status(404).json({ error: 'Problem not found' });
    }
    
    // Only the creator or admin can delete
    if (problem.farmerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // Soft delete - mark as inactive
    problem.isActive = false;
    await problem.save();
    
    res.json({ success: true, message: 'Problem deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upvote problem
app.post('/api/problems/:id/upvote', authenticate, async (req, res) => {
  try {
    const problem = await Problem.findById(req.params.id);
    if (!problem) return res.status(404).json({ error: 'Not found' });
    const hasUpvoted = problem.upvotedBy.includes(req.user._id);
    if (hasUpvoted) { problem.upvotes -= 1; problem.upvotedBy.pull(req.user._id); }
    else { problem.upvotes += 1; problem.upvotedBy.push(req.user._id); }
    await problem.save();
    res.json({ success: true, upvotes: problem.upvotes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE solution
app.post('/api/problems/:id/solutions', authenticate, async (req, res) => {
  try {
    const solution = await Solution.create({ problemId: req.params.id, farmerId: req.user._id, ...req.body });
    await Problem.findByIdAndUpdate(req.params.id, { $inc: { solutionCount: 1 } });
    res.status(201).json({ success: true, solution });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE solution
app.put('/api/solutions/:id', authenticate, async (req, res) => {
  try {
    const solution = await Solution.findById(req.params.id);
    if (!solution) return res.status(404).json({ error: 'Solution not found' });
    
    // Only the creator or admin can update
    if (solution.farmerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    Object.assign(solution, req.body);
    await solution.save();
    
    res.json({ success: true, solution });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE solution (soft delete)
app.delete('/api/solutions/:id', authenticate, async (req, res) => {
  try {
    const solution = await Solution.findById(req.params.id);
    
    if (!solution) {
      return res.status(404).json({ error: 'Solution not found' });
    }
    
    // Only the creator or admin can delete
    if (solution.farmerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // Soft delete
    solution.isActive = false;
    await solution.save();
    
    // Decrement solution count on problem
    await Problem.findByIdAndUpdate(solution.problemId, { $inc: { solutionCount: -1 } });
    
    res.json({ success: true, message: 'Solution deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upvote solution
app.post('/api/solutions/:id/upvote', authenticate, async (req, res) => {
  try {
    const solution = await Solution.findById(req.params.id);
    if (!solution) return res.status(404).json({ error: 'Not found' });
    const hasUpvoted = solution.upvotedBy.includes(req.user._id);
    if (hasUpvoted) { solution.upvotes -= 1; solution.upvotedBy.pull(req.user._id); }
    else { solution.upvotes += 1; solution.upvotedBy.push(req.user._id); }
    await solution.save();
    res.json({ success: true, upvotes: solution.upvotes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== LABOURERS ====================
app.get('/api/labourers/nearby', async (req, res) => {
  const { lat, lng, radius = 10, crop } = req.query;
  const query = { roles: 'labourer', 'labourerDetails.isAvailable': true, isActive: true };
  if (crop && crop !== 'all') query['labourerDetails.skills'] = crop;
  let labourers = await User.find(query).select('profile labourerDetails ratings verification email').sort('-ratings.average').limit(50);
  if (lat && lng) {
    labourers = labourers.map(lab => ({ ...lab.toObject(), distance: calculateDistance(lat, lng, lab.profile.location?.lat, lab.profile.location?.lng) }))
      .filter(lab => lab.distance <= Number(radius)).sort((a, b) => a.distance - b.distance);
  }
  res.json({ success: true, labourers });
});

app.get('/api/labourers', async (req, res) => {
  const { crop, isAvailable } = req.query;
  const query = { roles: 'labourer', isActive: true };
  if (crop && crop !== 'all') query['labourerDetails.skills'] = crop;
  if (isAvailable !== undefined) query['labourerDetails.isAvailable'] = isAvailable === 'true';
  const labourers = await User.find(query).select('profile labourerDetails ratings verification email').sort('-ratings.average').limit(100);
  res.json({ success: true, labourers });
});

app.get('/api/labourers/:id', async (req, res) => {
  const labourer = await User.findOne({ _id: req.params.id, roles: 'labourer' }).select('profile labourerDetails ratings verification email');
  if (!labourer) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true, labourer });
});

// ==================== CONTRACTORS ====================
app.get('/api/contractors', async (req, res) => {
  const { crop } = req.query;
  const query = { roles: 'contractor', isActive: true };
  if (crop && crop !== 'all') query['contractorDetails.crops'] = crop;
  const contractors = await User.find(query).select('profile contractorDetails ratings verification email').sort('-ratings.average').limit(100);
  res.json({ success: true, contractors });
});

app.get('/api/contractors/:id', async (req, res) => {
  const contractor = await User.findOne({ _id: req.params.id, roles: 'contractor' }).select('profile contractorDetails ratings verification email');
  if (!contractor) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true, contractor });
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
  Object.assign(shop, req.body); shop.updatedAt = Date.now(); await shop.save();
  res.json({ success: true, shop });
});

app.post('/api/fertilizer-shops/:id/rate', authenticate, async (req, res) => {
  const { rating } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating 1-5 required' });
  const shop = await FertilizerShop.findById(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Not found' });
  shop.rating = Math.round(((shop.rating * shop.totalRatings + rating) / (shop.totalRatings + 1)) * 10) / 10;
  shop.totalRatings += 1; await shop.save();
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
  const adData = { ...req.body, advertiserId: req.user._id, advertiserName: req.user.profile?.name, advertiserPhone: req.user.profile?.phone, startDate: new Date(), endDate: new Date(Date.now() + req.body.duration * 24 * 60 * 60 * 1000) };
  const ad = await Ad.create(adData);
  res.status(201).json({ success: true, ad });
});

app.put('/api/ads/:id/status', authenticate, async (req, res) => {
  const ad = await Ad.findById(req.params.id);
  if (!ad) return res.status(404).json({ error: 'Not found' });
  if (ad.advertiserId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  ad.status = req.body.status; ad.updatedAt = Date.now(); await ad.save();
  res.json({ success: true, ad });
});

app.post('/api/ads/:id/click', async (req, res) => {
  await Ad.findByIdAndUpdate(req.params.id, { $inc: { clicks: 1 } });
  res.json({ success: true });
});

// ==================== PAYMENTS ====================
app.get('/api/payments/upi-details', async (req, res) => {
  res.json({ success: true, upiId: process.env.MERCHANT_UPI_ID || 'siddhikreddy@ibl', merchantName: process.env.MERCHANT_NAME || 'AgriAgent Technologies', qrCodeUrl: process.env.QR_CODE_URL || '' });
});

app.post('/api/payments/upi', authenticate, async (req, res) => {
  const { adId, amount } = req.body;
  if (!adId || !amount) return res.status(400).json({ error: 'Ad ID and amount required' });
  const payment = await Payment.create({ userId: req.user._id, adId, amount, paymentMethod: 'upi', status: 'pending' });
  res.json({ success: true, paymentId: payment._id });
});

app.post('/api/payments/confirm-payment', authenticate, async (req, res) => {
  const { adId, utrNumber } = req.body;
  if (!adId) return res.status(400).json({ error: 'Ad ID required' });
  if (!utrNumber) return res.status(400).json({ error: 'UTR number required' });
  const payment = await Payment.findOne({ adId, userId: req.user._id }).sort('-createdAt');
  if (!payment) {
    const newPayment = await Payment.create({ userId: req.user._id, adId, amount: 0, paymentMethod: 'upi', status: 'pending_verification', utrNumber, userConfirmed: true, userConfirmedAt: new Date() });
    await Ad.findByIdAndUpdate(adId, { paymentStatus: 'pending_verification' });
    return res.json({ success: true, paymentId: newPayment._id });
  }
  payment.utrNumber = utrNumber; payment.status = 'pending_verification'; payment.userConfirmed = true; payment.userConfirmedAt = new Date();
  await payment.save();
  await Ad.findByIdAndUpdate(adId, { paymentStatus: 'pending_verification' });
  res.json({ success: true, message: 'Payment submitted for verification' });
});

app.put('/api/payments/:id/verify', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Not found' });
  payment.status = 'completed'; payment.paidAt = new Date(); await payment.save();
  await Ad.findByIdAndUpdate(payment.adId, { status: 'active', paymentStatus: 'completed' });
  res.json({ success: true, message: 'Payment verified' });
});

// ==================== DEBUG ====================
app.get('/api/debug/labourers', async (req, res) => {
  try {
    const count = await User.countDocuments({ roles: 'labourer', isActive: true });
    const labourers = await User.find({ roles: 'labourer', isActive: true }).select('profile.name profile.phone profile.location labourerDetails roles').limit(20);
    res.json({ success: true, totalLabourers: count, labourers: labourers.map(l => ({ id: l._id, name: l.profile?.name, phone: l.profile?.phone, hasLocation: !!(l.profile?.location?.lat && l.profile?.location?.lng), lat: l.profile?.location?.lat, lng: l.profile?.location?.lng, skills: l.labourerDetails?.skills || [], isAvailable: l.labourerDetails?.isAvailable, roles: l.roles })) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/debug/contractors', async (req, res) => {
  try {
    const count = await User.countDocuments({ roles: 'contractor', isActive: true });
    const contractors = await User.find({ roles: 'contractor', isActive: true }).select('profile.name profile.phone profile.location contractorDetails roles').limit(20);
    res.json({ success: true, totalContractors: count, contractors: contractors.map(c => ({ id: c._id, name: c.profile?.name, companyName: c.contractorDetails?.companyName, phone: c.profile?.phone, hasLocation: !!(c.profile?.location?.lat && c.profile?.location?.lng), crops: c.contractorDetails?.crops || [], teamSize: c.contractorDetails?.teamSize, roles: c.roles })) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/debug/payments', async (req, res) => {
  const payments = await Payment.find().sort('-createdAt').limit(20);
  res.json({ total: payments.length, payments: payments.map(p => ({ id: p._id, adId: p.adId, userId: p.userId, amount: p.amount, utrNumber: p.utrNumber, userConfirmed: p.userConfirmed, status: p.status })) });
});

// ==================== 404 / ERROR ====================
app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.url} not found` }));
app.use((err, req, res, next) => { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); });

// ==================== START ====================
const PORT = process.env.PORT || 5000;
connectDB().then(() => app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`)));

module.exports = app;
