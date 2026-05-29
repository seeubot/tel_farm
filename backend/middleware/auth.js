const { verifyFirebaseToken } = require('../config/firebase');
const User = require('../models/User');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const idToken = authHeader.split(' ')[1];
    const decodedToken = await verifyFirebaseToken(idToken);

    if (!decodedToken) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Find or create user
    let user = await User.findOne({ firebaseUid: decodedToken.uid });
    
    if (!user) {
      // Create new user from Firebase data
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
    req.firebaseUser = decodedToken;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  };
};

module.exports = { authenticate, requireRole };
