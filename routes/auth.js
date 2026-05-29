const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const User = require('../models/User');

// Get current user
router.get('/me', authenticate, async (req, res) => {
  try {
    res.json({
      success: true,
      user: {
        id: req.user._id,
        email: req.user.email,
        role: req.user.role,
        profile: req.user.profile,
        verification: req.user.verification,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user role
router.put('/role', authenticate, async (req, res) => {
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

// Update user profile
router.put('/profile', authenticate, async (req, res) => {
  try {
    const { name, teluguName, phone, location } = req.body;
    if (name) req.user.profile.name = name;
    if (teluguName) req.user.profile.teluguName = teluguName;
    if (phone) req.user.profile.phone = phone;
    if (location) req.user.profile.location = location;
    req.user.updatedAt = Date.now();
    await req.user.save();
    res.json({ success: true, user: req.user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
