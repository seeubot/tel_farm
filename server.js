const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const sharp = require('sharp');
const crypto = require('crypto');
const { GridFSBucket } = require('mongodb');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

// ==================== DATABASE CONNECTION ====================
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
    });
    console.log('MongoDB Connected');
  } catch (error) {
    console.error('MongoDB Error:', error.message);
    process.exit(1);
  }
};

// ==================== IMAGE DATABASE (Movie MongoDB) ====================
const IMAGE_MONGO_URI = process.env.IMAGE_MONGO_URI || 'mongodb+srv://movie:movie@movie.tylkv.mongodb.net/?appName=movie';
let imageDb;
let gridfsBucket;

const connectImageDB = async () => {
  try {
    const conn = mongoose.createConnection(IMAGE_MONGO_URI);
    await conn.asPromise();
    imageDb = conn.db;
    gridfsBucket = new GridFSBucket(imageDb, { bucketName: 'agriagent_images' });
    console.log('Image MongoDB Connected (movie db)');
  } catch (error) {
    console.error('Image MongoDB Error:', error.message);
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
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: privateKey,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    console.log('Firebase Admin initialized');
  } catch (error) {
    console.error('Firebase Admin error:', error.message);
  }
} else {
  console.warn('Firebase Admin credentials missing. Running in demo mode.');
}

// ==================== GOOGLE OAUTH CLIENT ====================
const googleOAuthClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

// ==================== MIDDLEWARE ====================
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: ['http://localhost:19000', 'http://localhost:19006', 'http://localhost:3000', 'exp://*', '*'],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type'), false);
  },
});

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Too many requests' } });
app.use('/api/', limiter);

// ==================== MODELS ====================
const userSchema = new mongoose.Schema({
  firebaseUid: { type: String, unique: true, sparse: true },
  googleId: { type: String, unique: true, sparse: true },
  email: { type: String, required: true, unique: true },
  roles: [{ type: String, enum: ['farmer', 'labourer', 'contractor', 'buyer'] }],
  role: { type: String, enum: ['farmer', 'labourer', 'contractor', 'buyer'], default: 'farmer' },
  ageVerified: { type: Boolean, default: false },
  age: { type: Number },
  profile: {
    name: { type: String, required: true },
    teluguName: { type: String },
    phone: { type: String },
    profileImage: { type: String },
    location: { lat: Number, lng: Number, address: String, village: String, district: String },
  },
  verification: {
    isPhoneVerified: { type: Boolean, default: false },
    isAadharVerified: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    verifiedAt: Date,
    documents: { aadharUrl: String, panUrl: String },
  },
  labourerDetails: { 
    age: Number, 
    experience: Number, 
    skills: [String], 
    isAvailable: { type: Boolean, default: true },
    serviceRadius: { type: Number, default: 10 }
  },
  contractorDetails: { companyName: String, gstNumber: String, teamSize: String, crops: [String], isActive: { type: Boolean, default: true } },
  ratings: { average: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
  isActive: { type: Boolean, default: true },
  deletedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// ==================== EQUIPMENT SCHEMA (UPDATED: supports rent AND/OR sale) ====================
const equipmentSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  teluguName: { type: String },
  category: { type: String, enum: ['Tractor', 'Harvester', 'Irrigation Pump', 'Power Tiller', 'Sprayer', 'Processing Machine', 'Trailer', 'Other'], required: true },
  description: { type: String },

  // NEW: what kind of listing this is
  listingType: { type: String, enum: ['rent', 'sale', 'both'], default: 'rent', required: true },

  pricing: {
    perDay: { type: Number },      // required only if listingType is 'rent' or 'both' (validated below)
    perHour: { type: Number },
    deposit: { type: Number },     // required only if listingType is 'rent' or 'both'
    salePrice: { type: Number },   // NEW — required only if listingType is 'sale' or 'both'
  },

  location: { lat: { type: Number, required: true }, lng: { type: Number, required: true }, address: String, village: String, district: String },
  features: [String],
  images: [String],
  availability: { isAvailable: { type: Boolean, default: true }, availableFrom: Date, availableTo: Date },
  ratings: { average: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
  isVerified: { type: Boolean, default: false },
  totalRentals: { type: Number, default: 0 },
  totalSales: { type: Number, default: 0 },   // NEW
  isSold: { type: Boolean, default: false },  // NEW — true once a 'sale'/'both' listing has been sold
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

// NEW: enforce correct pricing fields depending on listingType
equipmentSchema.pre('validate', function (next) {
  const type = this.listingType || 'rent';
  if (['rent', 'both'].includes(type)) {
    if (this.pricing?.perDay == null) return next(new Error('pricing.perDay is required for rental listings'));
    if (this.pricing?.deposit == null) return next(new Error('pricing.deposit is required for rental listings'));
  }
  if (['sale', 'both'].includes(type)) {
    if (this.pricing?.salePrice == null) return next(new Error('pricing.salePrice is required for sale listings'));
  }
  next();
});

const produceSchema = new mongoose.Schema({
  farmerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  cropName: { type: String, required: true },
  teluguName: { type: String }, variety: String,
  quantity: { type: Number, required: true }, unit: { type: String, default: 'kg' },
  price: { type: Number, required: true }, priceUnit: { type: String, default: 'per quintal' },
  location: { lat: Number, lng: Number, address: String, village: String },
  description: String, organic: { type: Boolean, default: false }, harvestDate: Date,
  images: [String], isAvailable: { type: Boolean, default: true }, isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

// ==================== BOOKING SCHEMA (UPDATED: supports purchase transactions) ====================
const bookingSchema = new mongoose.Schema({
  type: { type: String, enum: ['equipment', 'produce'], required: true },
  transactionType: { type: String, enum: ['rental', 'purchase'], default: 'rental' }, // NEW
  itemId: { type: mongoose.Schema.Types.ObjectId, required: true },
  renterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // acts as buyerId for purchases
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  startDate: Date, endDate: Date, quantity: Number, totalAmount: Number, deposit: Number,
  status: { type: String, enum: ['pending', 'confirmed', 'completed', 'cancelled'], default: 'pending' },
  rentalType: { type: String, enum: ['self', 'withOperator'] },
  createdAt: { type: Date, default: Date.now },
});

const reportSchema = new mongoose.Schema({
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['user', 'equipment', 'produce'], required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  reason: { type: String, required: true }, description: String,
  status: { type: String, enum: ['pending', 'reviewed', 'resolved'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
});

const problemSchema = new mongoose.Schema({
  farmerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true }, teluguTitle: String,
  description: { type: String, required: true }, teluguDescription: String,
  cropType: { type: String, required: true },
  location: { lat: Number, lng: Number, address: String, village: String },
  type: { type: String, enum: ['text', 'image', 'video'], default: 'text' },
  mediaUrl: String, upvotes: { type: Number, default: 0 },
  upvotedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  solutionCount: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

const solutionSchema = new mongoose.Schema({
  problemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Problem', required: true },
  farmerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  solution: { type: String, required: true }, teluguSolution: String,
  mediaUrl: String, mediaType: { type: String, enum: ['image', 'video'] },
  upvotes: { type: Number, default: 0 },
  upvotedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
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
  adId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', required: true },
  amount: Number, currency: { type: String, default: 'INR' },
  paymentMethod: { type: String, enum: ['upi', 'card', 'netbanking', 'razorpay'], default: 'upi' },
  status: { type: String, enum: ['pending', 'pending_verification', 'completed', 'failed', 'refunded'], default: 'pending' },
  transactionId: String, upiTransactionId: String, utrNumber: String,
  userConfirmed: { type: Boolean, default: false }, userConfirmedAt: Date,
  paymentDetails: { upiId: String, cardLast4: String, bankName: String },
  paidAt: Date, createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now },
});

const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  role: { type: String, enum: ['admin', 'superadmin'], default: 'admin' },
  lastLogin: Date,
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

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

const User = mongoose.model('User', userSchema);
const Equipment = mongoose.model('Equipment', equipmentSchema);
const Produce = mongoose.model('Produce', produceSchema);
const Booking = mongoose.model('Booking', bookingSchema);
const Report = mongoose.model('Report', reportSchema);
const Problem = mongoose.model('Problem', problemSchema);
const Solution = mongoose.model('Solution', solutionSchema);
const FertilizerShop = mongoose.model('FertilizerShop', fertilizerShopSchema);
const Ad = mongoose.model('Ad', adSchema);
const Payment = mongoose.model('Payment', paymentSchema);
const Admin = mongoose.model('Admin', adminSchema);

// ==================== AUTH MIDDLEWARE ====================
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
    const rawToken = authHeader.split(' ')[1];

    try {
      const decoded = jwt.verify(rawToken, process.env.JWT_SECRET || 'agriagent-secret-key');
      if (decoded.type === 'admin') {
        const adminUser = await Admin.findById(decoded.adminId);
        if (!adminUser?.isActive) return res.status(401).json({ error: 'Admin account disabled' });
        req.admin = adminUser;
        req.user = { _id: 'admin', email: adminUser.email, role: 'admin', roles: ['admin'] };
        return next();
      }
    } catch (jwtError) {}

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
  } catch (error) { res.status(401).json({ error: 'Authentication failed' }); }
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

// ==================== IMAGE UPLOAD ROUTES (MongoDB GridFS) ====================
app.post('/api/upload/image', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!gridfsBucket) return res.status(503).json({ error: 'Image service not ready' });

    const optimizedBuffer = await sharp(req.file.buffer)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    const filename = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}.webp`;
    const uploadStream = gridfsBucket.openUploadStream(filename, {
      contentType: 'image/webp',
      metadata: {
        uploadedBy: req.user._id.toString(),
        originalName: req.file.originalname,
        size: optimizedBuffer.length,
        createdAt: new Date(),
      },
    });

    const fileId = uploadStream.id;

    uploadStream.on('finish', () => {
      const imageUrl = `${process.env.API_BASE_URL}/api/images/${fileId}`;
      res.json({ success: true, url: imageUrl, id: fileId, size: optimizedBuffer.length });
    });

    uploadStream.on('error', (error) => {
      console.error('Upload stream error:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Upload failed' });
    });

    uploadStream.end(optimizedBuffer);
  } catch (error) {
    console.error('Upload error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
});

app.post('/api/upload/images', authenticate, upload.array('files', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files provided' });
    if (!gridfsBucket) return res.status(503).json({ error: 'Image service not ready' });

    const urls = await Promise.all(req.files.map(async (file) => {
      const optimizedBuffer = await sharp(file.buffer)
        .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

      const filename = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}.webp`;

      return new Promise((resolve, reject) => {
        const uploadStream = gridfsBucket.openUploadStream(filename, {
          contentType: 'image/webp',
          metadata: { uploadedBy: req.user._id.toString() },
        });

        const fileId = uploadStream.id;

        uploadStream.on('finish', () =>
          resolve(`${process.env.API_BASE_URL}/api/images/${fileId}`)
        );
        uploadStream.on('error', reject);
        uploadStream.end(optimizedBuffer);
      });
    }));

    res.json({ success: true, urls });
  } catch (error) {
    res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
});

app.get('/api/images/:id', async (req, res) => {
  try {
    if (!gridfsBucket) return res.status(503).json({ error: 'Image service not ready' });
    const _id = new mongoose.Types.ObjectId(req.params.id);
    const files = await imageDb.collection('agriagent_images.files').findOne({ _id });
    if (!files) return res.status(404).json({ error: 'Image not found' });
    res.set({ 'Content-Type': files.contentType || 'image/webp', 'Cache-Control': 'public, max-age=31536000' });
    const downloadStream = gridfsBucket.openDownloadStream(_id);
    downloadStream.pipe(res);
    downloadStream.on('error', () => res.status(404).json({ error: 'Image not found' }));
  } catch (error) {
    if (error.name === 'CastError') return res.status(400).json({ error: 'Invalid image ID' });
    res.status(500).json({ error: 'Failed to fetch image' });
  }
});

app.delete('/api/images/:id', authenticate, async (req, res) => {
  try {
    if (!gridfsBucket) return res.status(503).json({ error: 'Image service not ready' });
    const _id = new mongoose.Types.ObjectId(req.params.id);
    await gridfsBucket.delete(_id);
    res.json({ success: true, message: 'Image deleted' });
  } catch (error) { res.status(500).json({ error: 'Delete failed' }); }
});

// ==================== HEALTH ====================
app.get('/health', async (req, res) => {
  const dbStatus = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' }[mongoose.connection.readyState] || 'unknown';
  res.json({ status: 'OK', timestamp: new Date().toISOString(), mongodb: dbStatus, imageDb: gridfsBucket ? 'connected' : 'disconnected' });
});

app.get('/', (req, res) => res.json({ message: 'AgriAgent API', version: '2.0.0', imageStorage: 'MongoDB GridFS' }));
app.get('/api/ping', (req, res) => res.json({ pong: true }));

// ==================== WEATHER ====================
app.get('/api/weather', async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'Latitude and longitude required' });
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,rain,cloud_cover&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,rain_sum,weather_code,wind_speed_10m_max,sunrise,sunset,uv_index_max&timezone=auto&forecast_days=6`;
    const response = await fetch(url);
    const data = await response.json();
    if (!data.current) return res.status(500).json({ error: 'Failed to fetch weather data' });
    const weatherCodes = {
      0: { description: 'Clear Sky', icon: 'clear' }, 1: { description: 'Mainly Clear', icon: 'clear' }, 2: { description: 'Partly Cloudy', icon: 'partly-cloudy' }, 3: { description: 'Overcast', icon: 'cloudy' }, 45: { description: 'Foggy', icon: 'fog' }, 48: { description: 'Depositing Rime Fog', icon: 'fog' }, 51: { description: 'Light Drizzle', icon: 'drizzle' }, 53: { description: 'Moderate Drizzle', icon: 'drizzle' }, 55: { description: 'Dense Drizzle', icon: 'drizzle' }, 61: { description: 'Slight Rain', icon: 'rain' }, 63: { description: 'Moderate Rain', icon: 'rain' }, 65: { description: 'Heavy Rain', icon: 'heavy-rain' }, 71: { description: 'Slight Snow', icon: 'snow' }, 73: { description: 'Moderate Snow', icon: 'snow' }, 75: { description: 'Heavy Snow', icon: 'snow' }, 80: { description: 'Rain Showers', icon: 'rain' }, 81: { description: 'Moderate Rain Showers', icon: 'rain' }, 82: { description: 'Violent Rain Showers', icon: 'heavy-rain' }, 95: { description: 'Thunderstorm', icon: 'thunderstorm' }, 96: { description: 'Thunderstorm with Hail', icon: 'thunderstorm' }, 99: { description: 'Severe Thunderstorm', icon: 'thunderstorm' }
    };
    const current = { temperature: Math.round(data.current.temperature_2m), feelsLike: Math.round(data.current.apparent_temperature), humidity: data.current.relative_humidity_2m, windSpeed: data.current.wind_speed_10m, windDirection: data.current.wind_direction_10m, precipitation: data.current.precipitation, rain: data.current.rain, cloudCover: data.current.cloud_cover, weatherCode: data.current.weather_code, weather: weatherCodes[data.current.weather_code] || { description: 'Unknown', icon: 'cloudy' } };
    const daily = data.daily.time.map((date, index) => ({ date, dayName: new Date(date).toLocaleDateString('en-US', { weekday: 'short' }), dateFormatted: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), temperatureMax: Math.round(data.daily.temperature_2m_max[index]), temperatureMin: Math.round(data.daily.temperature_2m_min[index]), precipitation: data.daily.precipitation_sum[index], rainSum: data.daily.rain_sum[index], weatherCode: data.daily.weather_code[index], weather: weatherCodes[data.daily.weather_code[index]] || { description: 'Unknown', icon: 'cloudy' }, windSpeedMax: data.daily.wind_speed_10m_max[index], sunrise: data.daily.sunrise[index] ? data.daily.sunrise[index].split('T')[1]?.substring(0, 5) : null, sunset: data.daily.sunset[index] ? data.daily.sunset[index].split('T')[1]?.substring(0, 5) : null, uvIndex: data.daily.uv_index_max[index] }));
    res.json({ success: true, current, daily, location: { lat: parseFloat(lat), lng: parseFloat(lng) } });
  } catch (error) { res.status(500).json({ error: 'Failed to fetch weather data' }); }
});

// ==================== ADMIN AUTH ROUTES ====================
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const adminUser = await Admin.findOne({ $or: [{ username }, { email: username }], isActive: true });
    if (!adminUser) return res.status(401).json({ error: 'Invalid credentials' });
    const isMatch = await adminUser.comparePassword(password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
    adminUser.lastLogin = new Date();
    await adminUser.save();
    const token = jwt.sign({ adminId: adminUser._id, role: adminUser.role, type: 'admin' }, process.env.JWT_SECRET || 'agriagent-secret-key', { expiresIn: '12h' });
    res.json({ success: true, token, admin: { id: adminUser._id, username: adminUser.username, email: adminUser.email, role: adminUser.role } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/admin/session', adminAuth, async (req, res) => {
  res.json({ success: true, admin: { id: req.admin._id, username: req.admin.username, email: req.admin.email, role: req.admin.role } });
});

app.post('/api/admin/setup', async (req, res) => {
  try {
    const { setupKey, username, password, email } = req.body;
    if (setupKey !== process.env.ADMIN_SETUP_KEY) return res.status(403).json({ error: 'Invalid setup key' });
    const existingAdmin = await Admin.findOne({ $or: [{ username }, { email }] });
    if (existingAdmin) return res.status(400).json({ error: 'Admin already exists' });
    const adminUser = await Admin.create({ username, password, email, role: 'superadmin' });
    res.json({ success: true, message: 'Admin created successfully', admin: { id: adminUser._id, username: adminUser.username, email: adminUser.email, role: adminUser.role } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/admin/change-password', adminAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
    const isMatch = await req.admin.comparePassword(currentPassword);
    if (!isMatch) return res.status(401).json({ error: 'Current password is incorrect' });
    req.admin.password = newPassword;
    await req.admin.save();
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==================== ADMIN MANAGEMENT ROUTES ====================
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [totalUsers, activeLabourers, totalEquipment, totalProduce, pendingPayments, totalAds, activeAds, totalBookings, pendingReports] = await Promise.all([
      User.countDocuments({ isActive: true }), User.countDocuments({ isActive: true, roles: 'labourer', 'labourerDetails.isAvailable': true }), Equipment.countDocuments({ isActive: true }), Produce.countDocuments({ isActive: true, isAvailable: true }), Payment.countDocuments({ status: 'pending_verification' }), Ad.countDocuments(), Ad.countDocuments({ status: 'active' }), Booking.countDocuments({ status: 'pending' }), Report.countDocuments({ status: 'pending' })
    ]);
    res.json({ success: true, stats: { totalUsers, activeLabourers, totalEquipment, totalProduce, pendingPayments, totalAds, activeAds, totalBookings, pendingReports } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const { search, role, page = 1, limit = 20 } = req.query;
    const query = { isActive: true };
    if (search) query.$or = [{ 'profile.name': { $regex: search, $options: 'i' } }, { email: { $regex: search, $options: 'i' } }, { 'profile.phone': { $regex: search, $options: 'i' } }];
    if (role) query.roles = role;
    const total = await User.countDocuments(query);
    const users = await User.find(query).select('-__v').sort('-createdAt').skip((page - 1) * limit).limit(parseInt(limit));
    res.json({ success: true, users, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit), limit: parseInt(limit) } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-__v');
    if (!user) return res.status(404).json({ error: 'User not found' });
    const [equipment, produce, bookings] = await Promise.all([Equipment.find({ ownerId: user._id }), Produce.find({ farmerId: user._id }), Booking.find({ $or: [{ renterId: user._id }, { ownerId: user._id }] })]);
    res.json({ success: true, user, details: { equipmentCount: equipment.length, produceCount: produce.length, bookingCount: bookings.length } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/admin/users/:id/toggle', adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.isActive = !user.isActive; user.updatedAt = new Date(); await user.save();
    res.json({ success: true, isActive: user.isActive });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/admin/users/:id/verify', adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.verification.isVerified = true; user.verification.verifiedAt = new Date(); await user.save();
    res.json({ success: true, user });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/admin/ads', adminAuth, async (req, res) => {
  try {
    const { status, type, page = 1, limit = 50 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (type) query.type = type;
    const total = await Ad.countDocuments(query);
    const ads = await Ad.find(query).populate('advertiserId', 'profile.name profile.phone email').sort('-createdAt').skip((page - 1) * limit).limit(parseInt(limit));
    res.json({ success: true, ads, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/admin/ads/:id/status', adminAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'active', 'paused', 'completed', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const ad = await Ad.findByIdAndUpdate(req.params.id, { status, updatedAt: new Date() }, { new: true }).populate('advertiserId', 'profile.name email');
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    res.json({ success: true, ad });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/admin/payments', adminAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const query = {};
    if (status) query.status = status;
    const total = await Payment.countDocuments(query);
    const payments = await Payment.find(query).populate('userId', 'profile.name email profile.phone').populate('adId', 'title type budget').sort('-createdAt').skip((page - 1) * limit).limit(parseInt(limit));
    res.json({ success: true, payments, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/admin/payments/:id/verify', adminAuth, async (req, res) => {
  try {
    const payment = await Payment.findByIdAndUpdate(req.params.id, { status: 'completed', paidAt: new Date(), updatedAt: new Date() }, { new: true });
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.adId) await Ad.findByIdAndUpdate(payment.adId, { status: 'active', paymentStatus: 'completed', updatedAt: new Date() });
    res.json({ success: true, payment });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/admin/payments/:id/reject', adminAuth, async (req, res) => {
  try {
    const payment = await Payment.findByIdAndUpdate(req.params.id, { status: 'failed', updatedAt: new Date() }, { new: true });
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.adId) await Ad.findByIdAndUpdate(payment.adId, { paymentStatus: 'failed', updatedAt: new Date() });
    res.json({ success: true, payment });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/admin/reports', adminAuth, async (req, res) => {
  try {
    const { status, type, page = 1, limit = 50 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (type) query.type = type;
    const total = await Report.countDocuments(query);
    const reports = await Report.find(query).populate('reporterId', 'profile.name email').sort('-createdAt').skip((page - 1) * limit).limit(parseInt(limit));
    res.json({ success: true, reports, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/admin/reports/:id', adminAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'reviewed', 'resolved'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const report = await Report.findByIdAndUpdate(req.params.id, { status }, { new: true }).populate('reporterId', 'profile.name email');
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json({ success: true, report });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/admin/equipment', adminAuth, async (req, res) => {
  try {
    const { category, isVerified, listingType, page = 1, limit = 50 } = req.query;
    const query = {};
    if (category) query.category = category;
    if (isVerified !== undefined) query.isVerified = isVerified === 'true';
    if (listingType) query.listingType = listingType; // NEW: filter admin view by listing type
    const total = await Equipment.countDocuments(query);
    const equipment = await Equipment.find(query).populate('ownerId', 'profile.name profile.phone email').sort('-createdAt').skip((page - 1) * limit).limit(parseInt(limit));
    res.json({ success: true, equipment, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/admin/equipment/:id/verify', adminAuth, async (req, res) => {
  try {
    const equipment = await Equipment.findByIdAndUpdate(req.params.id, { isVerified: true }, { new: true });
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });
    res.json({ success: true, equipment });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/admin/shops', adminAuth, async (req, res) => {
  try {
    const { isVerified, page = 1, limit = 50 } = req.query;
    const query = {};
    if (isVerified !== undefined) query.isVerified = isVerified === 'true';
    const total = await FertilizerShop.countDocuments(query);
    const shops = await FertilizerShop.find(query).populate('addedBy', 'profile.name email').sort('-createdAt').skip((page - 1) * limit).limit(parseInt(limit));
    res.json({ success: true, shops, pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/admin/shops/:id/verify', adminAuth, async (req, res) => {
  try {
    const shop = await FertilizerShop.findByIdAndUpdate(req.params.id, { isVerified: true, updatedAt: new Date() }, { new: true });
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    res.json({ success: true, shop });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==================== AUTH ROUTES ====================
app.get('/api/auth/google-mobile/callback', async (req, res) => {
  try {
    const { code, state: codeVerifier, error: googleError } = req.query;
    if (googleError) return res.redirect(302, `agriagent://auth?error=${encodeURIComponent(googleError)}`);
    if (!code || !codeVerifier) return res.redirect(302, `agriagent://auth?error=Missing parameters`);

    // Fixed redirect_uri to match exactly what's registered in Google Cloud Console
    const redirectUri = `https://agriagentt.vercel.app/api/auth/google-mobile/callback`;
    console.log('[OAuth] Token exchange redirect_uri:', redirectUri);

    const { tokens } = await googleOAuthClient.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.access_token) return res.redirect(302, `agriagent://auth?error=Failed to obtain token`);
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const googleUser = await userInfoRes.json();
    if (!googleUser.email || !googleUser.sub) return res.redirect(302, `agriagent://auth?error=Failed to fetch user info`);
    let user = await User.findOne({ $or: [{ email: googleUser.email }, { googleId: googleUser.sub }] });
    if (!user) user = await User.create({ googleId: googleUser.sub, email: googleUser.email, profile: { name: googleUser.name, profileImage: googleUser.picture }, roles: ['farmer'], role: 'farmer' });
    else if (!user.googleId) { user.googleId = googleUser.sub; await user.save(); }
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

// ==================== EQUIPMENT (UPDATED: rent + sale) ====================
app.get('/api/equipment', async (req, res) => {
  try {
    const { category, search, owner, listingType } = req.query;
    // exclude sold-out items from the default listing feed
    const query = { isActive: true, isSold: { $ne: true } };
    if (category && category !== 'all') query.category = category;
    if (search) query.$or = [{ name: { $regex: search, $options: 'i' } }, { teluguName: { $regex: search, $options: 'i' } }];
    if (owner) query.ownerId = owner;
    // NEW: filter by rent / sale / both. 'both' listings show up under either filter.
    if (listingType && listingType !== 'all') {
      query.$or = [...(query.$or || []), { listingType }, { listingType: 'both' }];
    }
    const equipment = await Equipment.find(query).populate('ownerId', 'profile.name profile.profileImage verification.isVerified ratings').sort('-createdAt').limit(50);
    res.json({ success: true, equipment });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/equipment/:id', async (req, res) => {
  try {
    const equipment = await Equipment.findById(req.params.id).populate('ownerId', 'profile.name profile.profileImage profile.phone verification.isVerified ratings');
    if (!equipment) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, equipment });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/equipment', authenticate, async (req, res) => {
  try {
    // listingType defaults to 'rent' in the schema if not provided; validation enforces
    // the right pricing fields for 'rent' / 'sale' / 'both'
    const equipment = await Equipment.create({ ...req.body, ownerId: req.user._id });
    res.status(201).json({ success: true, equipment });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.put('/api/equipment/:id', authenticate, async (req, res) => {
  try {
    const equipment = await Equipment.findById(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Not found' });
    if (equipment.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
    Object.assign(equipment, req.body); await equipment.save();
    res.json({ success: true, equipment });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// NEW: dedicated endpoint to switch a listing between rent / sale / both without a full PUT
app.put('/api/equipment/:id/listing-type', authenticate, async (req, res) => {
  try {
    const { listingType, pricing } = req.body;
    if (!['rent', 'sale', 'both'].includes(listingType)) return res.status(400).json({ error: 'Invalid listing type' });
    const equipment = await Equipment.findById(req.params.id);
    if (!equipment) return res.status(404).json({ error: 'Not found' });
    if (equipment.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
    equipment.listingType = listingType;
    if (pricing) equipment.pricing = { ...equipment.pricing.toObject(), ...pricing };
    await equipment.save(); // pre('validate') hook enforces correct pricing fields
    res.json({ success: true, equipment });
  } catch (error) { res.status(400).json({ error: error.message }); }
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
  const { crop, search, organic, farmer } = req.query;
  const query = { isActive: true };
  if (crop && crop !== 'all') query.cropName = crop;
  if (search) query.$or = [{ cropName: { $regex: search, $options: 'i' } }, { variety: { $regex: search, $options: 'i' } }];
  if (organic === 'true') query.organic = true;
  if (farmer) query.farmerId = farmer;
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

// ==================== BOOKINGS (UPDATED: handles equipment purchase too) ====================
app.get('/api/bookings', authenticate, async (req, res) => {
  const bookings = await Booking.find({ $or: [{ renterId: req.user._id }, { ownerId: req.user._id }] }).sort('-createdAt');
  res.json({ success: true, bookings });
});

app.post('/api/bookings', authenticate, async (req, res) => {
  try {
    const { type, itemId, transactionType } = req.body;

    // NEW: equipment purchase flow
    if (type === 'equipment' && transactionType === 'purchase') {
      const equipment = await Equipment.findById(itemId);
      if (!equipment) return res.status(404).json({ error: 'Equipment not found' });
      if (!['sale', 'both'].includes(equipment.listingType)) return res.status(400).json({ error: 'This equipment is not listed for sale' });
      if (equipment.isSold) return res.status(400).json({ error: 'This equipment has already been sold' });
      if (equipment.ownerId.toString() === req.user._id.toString()) return res.status(400).json({ error: 'You cannot purchase your own listing' });

      const booking = await Booking.create({
        type: 'equipment',
        transactionType: 'purchase',
        itemId,
        renterId: req.user._id,
        ownerId: equipment.ownerId,
        totalAmount: equipment.pricing.salePrice,
        status: 'pending',
      });
      return res.status(201).json({ success: true, booking });
    }

    // existing rental / produce flow, unchanged behavior
    const booking = await Booking.create({ ...req.body, transactionType: 'rental', renterId: req.user._id });
    res.status(201).json({ success: true, booking });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/bookings/:id', authenticate, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Not found' });
    if (booking.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
    booking.status = req.body.status; await booking.save();

    // NEW: when an equipment sale completes, mark the listing sold and hide it
    if (booking.type === 'equipment' && booking.transactionType === 'purchase' && booking.status === 'completed') {
      await Equipment.findByIdAndUpdate(booking.itemId, {
        isSold: true,
        isActive: false,
        $inc: { totalSales: 1 },
      });
    } else if (booking.type === 'equipment' && booking.transactionType === 'rental' && booking.status === 'completed') {
      await Equipment.findByIdAndUpdate(booking.itemId, { $inc: { totalRentals: 1 } });
    }

    res.json({ success: true, booking });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==================== PROBLEMS & SOLUTIONS ====================
app.get('/api/problems', async (req, res) => {
  try {
    const { crop, search } = req.query;
    const query = { isActive: true };
    if (crop && crop !== 'all') query.cropType = crop;
    if (search) query.$or = [{ title: { $regex: search, $options: 'i' } }, { description: { $regex: search, $options: 'i' } }];
    const problems = await Problem.find(query).populate('farmerId', 'profile.name profile.profileImage verification.isVerified').sort('-upvotes').limit(50);
    res.json({ success: true, problems });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/problems/:id', async (req, res) => {
  try {
    const problem = await Problem.findById(req.params.id).populate('farmerId', 'profile.name profile.profileImage verification.isVerified ratings');
    if (!problem) return res.status(404).json({ error: 'Not found' });
    const solutions = await Solution.find({ problemId: problem._id, isActive: true }).populate('farmerId', 'profile.name profile.profileImage verification.isVerified').sort('-upvotes');
    res.json({ success: true, problem, solutions });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/problems', authenticate, async (req, res) => {
  try {
    const problem = await Problem.create({ ...req.body, farmerId: req.user._id });
    res.status(201).json({ success: true, problem });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/problems/:id', authenticate, async (req, res) => {
  try {
    const problem = await Problem.findById(req.params.id);
    if (!problem) return res.status(404).json({ error: 'Problem not found' });
    if (problem.farmerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
    Object.assign(problem, req.body); await problem.save();
    res.json({ success: true, problem });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/problems/:id', authenticate, async (req, res) => {
  try {
    const problem = await Problem.findById(req.params.id);
    if (!problem) return res.status(404).json({ error: 'Problem not found' });
    if (problem.farmerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
    problem.isActive = false; await problem.save();
    res.json({ success: true, message: 'Problem deleted' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/problems/:id/upvote', authenticate, async (req, res) => {
  try {
    const problem = await Problem.findById(req.params.id);
    if (!problem) return res.status(404).json({ error: 'Not found' });
    const hasUpvoted = problem.upvotedBy.includes(req.user._id);
    if (hasUpvoted) { problem.upvotes -= 1; problem.upvotedBy.pull(req.user._id); }
    else { problem.upvotes += 1; problem.upvotedBy.push(req.user._id); }
    await problem.save();
    res.json({ success: true, upvotes: problem.upvotes });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/problems/:id/solutions', authenticate, async (req, res) => {
  try {
    const solution = await Solution.create({ problemId: req.params.id, farmerId: req.user._id, ...req.body });
    await Problem.findByIdAndUpdate(req.params.id, { $inc: { solutionCount: 1 } });
    res.status(201).json({ success: true, solution });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/solutions/:id', authenticate, async (req, res) => {
  try {
    const solution = await Solution.findById(req.params.id);
    if (!solution) return res.status(404).json({ error: 'Solution not found' });
    if (solution.farmerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
    Object.assign(solution, req.body); await solution.save();
    res.json({ success: true, solution });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/solutions/:id', authenticate, async (req, res) => {
  try {
    const solution = await Solution.findById(req.params.id);
    if (!solution) return res.status(404).json({ error: 'Solution not found' });
    if (solution.farmerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
    solution.isActive = false; await solution.save();
    await Problem.findByIdAndUpdate(solution.problemId, { $inc: { solutionCount: -1 } });
    res.json({ success: true, message: 'Solution deleted' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/solutions/:id/upvote', authenticate, async (req, res) => {
  try {
    const solution = await Solution.findById(req.params.id);
    if (!solution) return res.status(404).json({ error: 'Not found' });
    const hasUpvoted = solution.upvotedBy.includes(req.user._id);
    if (hasUpvoted) { solution.upvotes -= 1; solution.upvotedBy.pull(req.user._id); }
    else { solution.upvotes += 1; solution.upvotedBy.push(req.user._id); }
    await solution.save();
    res.json({ success: true, upvotes: solution.upvotes });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==================== LABOURERS ====================
app.get('/api/labourers/nearby', async (req, res) => {
  const { lat, lng, radius = 10, crop, village } = req.query;
  const query = { roles: 'labourer', 'labourerDetails.isAvailable': true, isActive: true };
  
  if (crop && crop !== 'all' && crop !== 'All crops') query['labourerDetails.skills'] = crop;
  
  if (village) {
    query.$or = [
      { 'profile.location.village': { $regex: village, $options: 'i' } },
      { 'profile.location.address': { $regex: village, $options: 'i' } },
      { 'profile.location.district': { $regex: village, $options: 'i' } }
    ];
  }
  
  let labourers = await User.find(query)
    .select('profile labourerDetails ratings verification email')
    .sort('-ratings.average')
    .limit(100);
  
  if (lat && lng) {
    labourers = labourers.map(l => {
      const labourerLat = l.profile.location?.lat;
      const labourerLng = l.profile.location?.lng;
      const distance = calculateDistance(
        parseFloat(lat), 
        parseFloat(lng), 
        labourerLat, 
        labourerLng
      );
      
      const serviceRadius = l.labourerDetails?.serviceRadius || 10;
      const searchRadius = Number(radius);
      const effectiveRadius = Math.min(serviceRadius, searchRadius);
      
      return { 
        ...l.toObject(), 
        distance,
        serviceRadius,
        withinRange: distance <= effectiveRadius
      };
    })
    .filter(l => l.withinRange)
    .sort((a, b) => a.distance - b.distance);
  }
  
  res.json({ success: true, labourers });
});

app.get('/api/labourers', async (req, res) => {
  const { crop, isAvailable, village } = req.query;
  const query = { roles: 'labourer', isActive: true };
  
  if (crop && crop !== 'all' && crop !== 'All crops') query['labourerDetails.skills'] = crop;
  if (isAvailable !== undefined) query['labourerDetails.isAvailable'] = isAvailable === 'true';
  
  if (village) {
    query.$or = [
      { 'profile.location.village': { $regex: village, $options: 'i' } },
      { 'profile.location.address': { $regex: village, $options: 'i' } },
      { 'profile.location.district': { $regex: village, $options: 'i' } }
    ];
  }
  
  const labourers = await User.find(query)
    .select('profile labourerDetails ratings verification email')
    .sort('-ratings.average')
    .limit(100);
  
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
  const { lat, lng, radius = 20, search } = req.query;
  let query = { isActive: true };
  if (search) query.$or = [{ name: { $regex: search, $options: 'i' } }, { 'location.village': { $regex: search, $options: 'i' } }];
  let shops = await FertilizerShop.find(query).sort('-isVerified').limit(100);
  if (lat && lng) {
    shops = shops.map(s => ({ ...s.toObject(), distance: calculateDistance(parseFloat(lat), parseFloat(lng), s.location.lat, s.location.lng) }))
      .filter(s => s.distance <= parseFloat(radius)).sort((a, b) => a.distance - b.distance);
  }
  res.json({ success: true, shops });
});

app.get('/api/fertilizer-shops', async (req, res) => {
  const { search, district, addedBy } = req.query;
  const query = { isActive: true };
  if (search) query.$or = [{ name: { $regex: search, $options: 'i' } }];
  if (district) query['location.district'] = { $regex: district, $options: 'i' };
  if (addedBy) query.addedBy = addedBy;
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

// FIXED: Delete endpoint for fertilizer shops
app.delete('/api/fertilizer-shops/:id', authenticate, async (req, res) => {
  try {
    const shop = await FertilizerShop.findById(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    if (shop.addedBy?.toString() !== req.user._id.toString() && req.user.role !== 'admin') 
      return res.status(403).json({ error: 'Unauthorized' });
    
    // Soft delete to be consistent with other endpoints
    shop.isActive = false;
    shop.updatedAt = new Date();
    await shop.save();
    res.json({ success: true, message: 'Shop deleted successfully' });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
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

// ==================== REPORTS ====================
app.post('/api/reports', authenticate, async (req, res) => {
  try {
    const report = await Report.create({ ...req.body, reporterId: req.user._id });
    res.status(201).json({ success: true, report });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==================== DEBUG ====================
app.get('/api/debug/labourers', async (req, res) => {
  try {
    const count = await User.countDocuments({ roles: 'labourer', isActive: true });
    const labourers = await User.find({ roles: 'labourer', isActive: true }).select('profile.name profile.phone profile.location labourerDetails roles').limit(20);
    res.json({ success: true, totalLabourers: count, labourers: labourers.map(l => ({ id: l._id, name: l.profile?.name, phone: l.profile?.phone, hasLocation: !!(l.profile?.location?.lat && l.profile?.location?.lng), lat: l.profile?.location?.lat, lng: l.profile?.location?.lng, skills: l.labourerDetails?.skills || [], isAvailable: l.labourerDetails?.isAvailable, serviceRadius: l.labourerDetails?.serviceRadius || 10, roles: l.roles })) });
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

// ==================== ERROR HANDLERS ====================
app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.url} not found` }));
app.use((err, req, res, next) => { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); });

// ==================== START SERVER ====================
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectDB();
  await connectImageDB();

  // NEW: one-time migration for pre-existing equipment docs missing listingType
  try {
    await Equipment.updateMany({ listingType: { $exists: false } }, { $set: { listingType: 'rent' } });
  } catch (err) {
    console.error('Equipment listingType migration error:', err.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AgriAgent Server running on port ${PORT}`);
    console.log(`Image Storage: MongoDB GridFS (movie db)`);
    console.log(`Health: http://localhost:${PORT}/health`);
  });
};

startServer();

module.exports = app;
