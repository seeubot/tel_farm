const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const User = require('../models/User');

// Get current user profile
router.get('/me', authenticate, async (req, res) => {
  try {
    res.json({
      success: true,
      user: {
        id: req.user._id,
        firebaseUid: req.user.firebaseUid,
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

// Update user profile
router.put('/profile', authenticate, async (req, res) => {
  try {
    const { name, teluguName, phone, location, role, labourerDetails, contractorDetails } = req.body;
    
    const updateData = {};
    if (name) updateData['profile.name'] = name;
    if (teluguName) updateData['profile.teluguName'] = teluguName;
    if (phone) updateData['profile.phone'] = phone;
    if (location) updateData['profile.location'] = location;
    if (role) updateData.role = role;
    if (labourerDetails) updateData.labourerDetails = labourerDetails;
    if (contractorDetails) updateData.contractorDetails = contractorDetails;
    
    updateData.updatedAt = Date.now();
    
    const user = await User.findByIdAndUpdate(
      req.user._id,
      updateData,
      { new: true }
    );
    
    res.json({ success: true, user });
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

module.exports = router;
