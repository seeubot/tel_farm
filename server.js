const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1); // Trust Koyeb's load balancer

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
  firebaseUid: { type: String, unique: true, sparse: true },
  googleId:    { type: String, unique: true, sparse: true },
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
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const rawToken = authHeader.split(' ')[1];

    // Dev shortcut
    if (!firebaseAdmin && process.env.NODE_ENV === 'development') {
      req.user = { _id: 'demo123', email: 'demo@example.com', role: 'farmer' };
      return next();
    }

    // JWT token (from mobile callback)
    if (rawToken.startsWith('eyJ')) {
      try {
        const decoded = jwt.verify(rawToken, process.env.JWT_SECRET || 'agriagent-secret-key');
        const user = await User.findById(decoded.userId);
        if (!user) {
          return res.status(401).json({ error: 'User not found' });
        }
        if (!user.isActive) {
          return res.status(401).json({ error: 'Account has been deactivated' });
        }
        req.user = user;
        return next();
      } catch (jwtError) {
        return res.status(401).json({ error: 'Invalid JWT token' });
      }
    }

    // PKCE / Google access token
    if (rawToken.startsWith('google_')) {
      const accessToken = rawToken.slice(7);
      const tokenInfoRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`
      );
      const tokenInfo = await tokenInfoRes.json();

      if (!tokenInfoRes.ok || tokenInfo.error) {
        return res.status(401).json({ error: 'Invalid Google access token' });
      }

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

    // Firebase ID token
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
      auth:      'POST /api/auth/google, POST /api/auth/google-mobile, GET /api/auth/google-mobile/callback, GET /api/auth/me, PUT /api/auth/role',
      equipment: 'GET,POST /api/equipment, GET,PUT,DELETE /api/equipment/:id',
      produce:   'GET,POST /api/produce, GET,PUT,DELETE /api/produce/:id',
      bookings:  'GET,POST /api/bookings, PUT /api/bookings/:id',
      users:     'DELETE /api/users/delete-account, GET /api/users/export-data',
      reports:   'POST /api/reports',
    },
  });
});

// ==================== HELPER: Generate Redirect HTML ====================
function getRedirectHTML(data, error, logs = []) {
  const timestamp = new Date().toISOString();
  
  let deepLink;
  if (data) {
    const params = new URLSearchParams({
      token: data.token,
      userId: data.userId,
      email: data.email,
      role: data.role
    });
    deepLink = `agriagent://auth?${params.toString()}`;
  } else {
    const errorMsg = error || 'Unknown error';
    deepLink = `agriagent://auth?error=${encodeURIComponent(errorMsg)}`;
  }

  const logEntries = logs.map(log => 
    `<div class="log-entry"><span class="log-timestamp">[${log.timestamp || timestamp}]</span> ${log.message}</div>`
  ).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>AgriAgent - Redirecting...</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          padding: 20px;
        }
        .container {
          background: white;
          padding: 30px;
          border-radius: 20px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          text-align: center;
          max-width: 500px;
          width: 100%;
        }
        .status-icon {
          font-size: 48px;
          margin-bottom: 15px;
        }
        h2 {
          color: #333;
          margin-bottom: 10px;
          font-size: 24px;
        }
        .message {
          color: #666;
          margin-bottom: 20px;
          line-height: 1.5;
        }
        .error-message {
          color: #dc3545;
          background: #f8d7da;
          padding: 10px;
          border-radius: 8px;
          margin: 10px 0;
        }
        .success-message {
          color: #28a745;
          background: #d4edda;
          padding: 10px;
          border-radius: 8px;
          margin: 10px 0;
        }
        .button-group {
          display: flex;
          flex-direction: column;
          gap: 10px;
          margin: 20px 0;
        }
        button {
          padding: 12px 24px;
          border: none;
          border-radius: 10px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }
        button:active {
          transform: scale(0.98);
        }
        .primary-btn {
          background: #667eea;
          color: white;
        }
        .primary-btn:hover {
          background: #5a67d8;
        }
        .secondary-btn {
          background: #e2e8f0;
          color: #4a5568;
        }
        .secondary-btn:hover {
          background: #cbd5e0;
        }
        .copy-btn {
          background: #48bb78;
          color: white;
        }
        .copy-btn:hover {
          background: #38a169;
        }
        button:disabled {
          background: #cbd5e0;
          color: #a0aec0;
          cursor: not-allowed;
        }
        .log-container {
          margin-top: 20px;
          padding: 15px;
          background: #1a202c;
          border-radius: 10px;
          text-align: left;
          max-height: 250px;
          overflow-y: auto;
        }
        .log-title {
          color: #a0aec0;
          font-size: 12px;
          font-weight: 600;
          margin-bottom: 10px;
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        .log-entry {
          color: #68d391;
          font-family: 'Courier New', monospace;
          font-size: 11px;
          margin: 4px 0;
          padding: 3px 0;
          border-bottom: 1px solid #2d3748;
        }
        .log-timestamp {
          color: #a0aec0;
          font-size: 10px;
        }
        .deep-link-display {
          background: #f7fafc;
          padding: 10px;
          border-radius: 8px;
          font-family: 'Courier New', monospace;
          font-size: 11px;
          word-break: break-all;
          color: #4a5568;
          margin: 10px 0;
          border: 1px solid #e2e8f0;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="status-icon">${data ? '✅' : '❌'}</div>
        <h2>${data ? 'Authentication Successful' : 'Authentication Failed'}</h2>
        
        ${data ? 
          `<div class="success-message">
            Successfully authenticated!<br>
            Redirecting to AgriAgent app...
          </div>` :
          `<div class="error-message">
            ${error || 'An error occurred during authentication'}
          </div>`
        }
        
        <div class="deep-link-display">
          <strong>Deep Link:</strong><br>
          ${deepLink}
        </div>
        
        <div class="button-group">
          <button class="primary-btn" onclick="retryRedirect()" ${!data ? 'disabled' : ''}>
            🔄 Open AgriAgent App
          </button>
          <button class="copy-btn" onclick="copyDeepLink()">
            📋 Copy Deep Link
          </button>
          <button class="secondary-btn" onclick="showDebugInfo()">
            🔍 Debug Info
          </button>
        </div>
        
        <div class="log-container">
          <div class="log-title">📋 Redirect Logs</div>
          <div id="logs">
            <div class="log-entry"><span class="log-timestamp">[${timestamp}]</span> Page loaded</div>
            <div class="log-entry"><span class="log-timestamp">[${timestamp}]</span> Deep link generated</div>
            ${logEntries}
          </div>
        </div>
      </div>

      <script>
        const deepLink = '${deepLink.replace(/'/g, "\\'")}';
        const hasData = ${!!data};
        const logs = document.getElementById('logs');
        
        function addLog(message) {
          const logEntry = document.createElement('div');
          logEntry.className = 'log-entry';
          logEntry.innerHTML = '<span class="log-timestamp">[' + new Date().toISOString() + ']</span> ' + message;
          logs.appendChild(logEntry);
          logs.scrollTop = logs.scrollHeight;
        }

        function tryRedirect(method) {
          addLog('Attempting redirect via: ' + method);
          
          switch(method) {
            case 'location':
              window.location.href = deepLink;
              break;
            case 'iframe':
              const iframe = document.createElement('iframe');
              iframe.style.display = 'none';
              iframe.src = deepLink;
              document.body.appendChild(iframe);
              setTimeout(() => document.body.removeChild(iframe), 2000);
              break;
            case 'anchor':
              const a = document.createElement('a');
              a.href = deepLink;
              a.style.display = 'none';
              document.body.appendChild(a);
              a.click();
              setTimeout(() => document.body.removeChild(a), 1000);
              break;
            case 'intent':
              const intentUrl = 'intent://auth?' + deepLink.split('?')[1] + '#Intent;scheme=agriagent;package=com.yourcompany.agriagent;end';
              window.location.href = intentUrl;
              break;
          }
          
          setTimeout(() => {
            addLog('Still on page after ' + method + ' redirect attempt');
          }, 1500);
        }

        function retryRedirect() {
          addLog('Manual retry initiated');
          tryRedirect('location');
          setTimeout(() => {
            addLog('Trying alternative redirect methods...');
            tryRedirect('iframe');
          }, 1500);
          setTimeout(() => tryRedirect('anchor'), 3000);
          if (/android/i.test(navigator.userAgent)) {
            setTimeout(() => tryRedirect('intent'), 4500);
          }
        }

        function copyDeepLink() {
          const textarea = document.createElement('textarea');
          textarea.value = deepLink;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          try {
            document.execCommand('copy');
            addLog('✅ Deep link copied to clipboard');
            alert('Deep link copied! You can paste and open it in your notes app.');
          } catch (err) {
            navigator.clipboard.writeText(deepLink).then(() => {
              addLog('✅ Deep link copied to clipboard (modern API)');
              alert('Deep link copied! You can paste and open it in your notes app.');
            }).catch(err => {
              addLog('❌ Failed to copy: ' + err);
              alert('Failed to copy. Please manually copy the deep link shown above.');
            });
          }
          document.body.removeChild(textarea);
        }

        function showDebugInfo() {
          const info = {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            language: navigator.language,
            cookiesEnabled: navigator.cookieEnabled,
            onLine: navigator.onLine,
            deepLink: deepLink,
            hasData: hasData,
            timestamp: new Date().toISOString()
          };
          addLog('Debug Info: ' + JSON.stringify(info, null, 2));
          alert('Debug info added to logs. Please scroll down to view.');
        }

        window.addEventListener('load', () => {
          addLog('Window loaded');
          if (hasData) {
            addLog('Auto-redirect will start in 1 second...');
            setTimeout(() => {
              addLog('Starting auto-redirect sequence');
              tryRedirect('location');
            }, 1000);
            setTimeout(() => tryRedirect('iframe'), 2500);
            setTimeout(() => tryRedirect('anchor'), 4000);
            if (/android/i.test(navigator.userAgent)) {
              setTimeout(() => tryRedirect('intent'), 5500);
            }
          } else {
            addLog('Auto-redirect skipped due to authentication error');
          }
        });

        window.addEventListener('error', (e) => {
          addLog('❌ JS Error: ' + e.message + ' at ' + e.filename + ':' + e.lineno);
        });

        document.addEventListener('visibilitychange', () => {
          addLog('Page visibility: ' + (document.hidden ? 'hidden' : 'visible'));
        });
      </script>
    </body>
    </html>
  `;
}

// ==================== GOOGLE AUTH — CALLBACK (HTML Page with Multiple Redirect Methods) ====================
app.get('/api/auth/google-mobile/callback', async (req, res) => {
  const logs = [];
  
  try {
    logs.push({ timestamp: new Date().toISOString(), message: 'Callback received' });
    
    const { code, state: codeVerifier, error: googleError } = req.query;
    
    logs.push({ 
      timestamp: new Date().toISOString(), 
      message: `Code: ${!!code}, Verifier: ${!!codeVerifier}, Google Error: ${googleError || 'none'}` 
    });
    
    console.log('[Auth Callback] Received:', {
      hasCode: !!code,
      hasVerifier: !!codeVerifier,
      error: googleError || 'none'
    });
    
    if (googleError) {
      console.error('[Auth Callback] Google error:', googleError);
      logs.push({ timestamp: new Date().toISOString(), message: `Google error: ${googleError}` });
      return res.send(getRedirectHTML(null, googleError, logs));
    }
    
    if (!code || !codeVerifier) {
      console.error('[Auth Callback] Missing parameters');
      logs.push({ timestamp: new Date().toISOString(), message: 'Missing code or verifier' });
      return res.send(getRedirectHTML(null, 'Missing authentication parameters', logs));
    }
    
    const redirectUri = `${process.env.API_BASE_URL}/api/auth/google-mobile/callback`;
    logs.push({ timestamp: new Date().toISOString(), message: 'Exchanging code for tokens...' });
    
    const { tokens } = await googleOAuthClient.getToken({
      code,
      codeVerifier,
      redirect_uri: redirectUri
    });
    
    logs.push({ 
      timestamp: new Date().toISOString(), 
      message: `Tokens received - Access: ${!!tokens.access_token}` 
    });
    
    console.log('[Auth Callback] Tokens:', { hasAccessToken: !!tokens.access_token });
    
    if (!tokens.access_token) {
      logs.push({ timestamp: new Date().toISOString(), message: 'No access token received' });
      return res.send(getRedirectHTML(null, 'Failed to obtain access token', logs));
    }
    
    logs.push({ timestamp: new Date().toISOString(), message: 'Fetching user info from Google...' });
    
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const googleUser = await userInfoRes.json();
    
    logs.push({ 
      timestamp: new Date().toISOString(), 
      message: `User: ${googleUser.email}` 
    });
    
    console.log('[Auth Callback] User:', { email: googleUser.email });
    
    logs.push({ timestamp: new Date().toISOString(), message: 'Looking up user in database...' });
    
    let user = await User.findOne({ email: googleUser.email });
    if (!user) {
      logs.push({ timestamp: new Date().toISOString(), message: 'Creating new user...' });
      user = await User.create({
        googleId: googleUser.sub,
        email: googleUser.email,
        profile: { 
          name: googleUser.name, 
          profileImage: googleUser.picture 
        },
        verification: { isVerified: false },
        ageVerified: false,
      });
      logs.push({ timestamp: new Date().toISOString(), message: `User created: ${user._id}` });
    } else {
      logs.push({ timestamp: new Date().toISOString(), message: `User found: ${user._id}` });
      if (!user.googleId) {
        user.googleId = googleUser.sub;
        await user.save();
        logs.push({ timestamp: new Date().toISOString(), message: 'Updated Google ID' });
      }
    }
    
    // Generate JWT token
    const appToken = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'agriagent-secret-key',
      { expiresIn: '30d' }
    );
    
    logs.push({ 
      timestamp: new Date().toISOString(), 
      message: '✅ JWT token generated, sending redirect page' 
    });
    
    console.log('[Auth Callback] ✅ Success, sending HTML page');
    
    res.send(getRedirectHTML({
      token: appToken,
      userId: user._id,
      email: user.email,
      role: user.role,
    }, null, logs));
    
  } catch (error) {
    console.error('[Auth Callback] ❌ Error:', error);
    logs.push({ 
      timestamp: new Date().toISOString(), 
      message: `Error: ${error.message}` 
    });
    
    res.send(getRedirectHTML(null, error.message, logs));
  }
});

// ==================== GOOGLE AUTH — LEGACY ====================
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
app.post('/api/auth/google-mobile', async (req, res) => {
  try {
    const { code, codeVerifier, redirectUri } = req.body;

    if (!code || !codeVerifier || !redirectUri) {
      return res.status(400).json({ error: 'code, codeVerifier, and redirectUri are required' });
    }

    googleOAuthClient.redirectUri = redirectUri;
    const { tokens } = await googleOAuthClient.getToken({
      code,
      codeVerifier,
    });

    if (!tokens.access_token) {
      return res.status(400).json({ error: 'Failed to obtain access token from Google' });
    }

    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoRes.ok) {
      return res.status(400).json({ error: 'Failed to fetch Google user info' });
    }

    const googleUser = await userInfoRes.json();

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
      if (!user.googleId) {
        user.googleId = googleUser.sub;
        await user.save();
      }
    }

    if (!user.isActive) {
      return res.status(401).json({ error: 'Account has been deactivated' });
    }

    res.json({
      success: true,
      idToken: tokens.access_token,
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

// ==================== SESSION CHECK ENDPOINT ====================
app.get('/api/auth/session', authenticate, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || '';
    
    res.json({
      success: true,
      token: token,
      user: {
        id: req.user._id,
        email: req.user.email,
        role: req.user.role,
        profile: req.user.profile,
        verification: req.user.verification,
        ageVerified: req.user.ageVerified
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

// ==================== USER MANAGEMENT ====================
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
    console.log(`📍 Auth callback: http://localhost:${PORT}/api/auth/google-mobile/callback`);
  });
});
