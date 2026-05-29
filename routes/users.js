const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const User = require('../models/User');

// Get user by ID
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-firebaseUid');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get dashboard stats
router.get('/:id/stats', authenticate, async (req, res) => {
  try {
    const equipmentCount = await Equipment.countDocuments({ ownerId: req.params.id });
    const produceCount = await Produce.countDocuments({ farmerId: req.params.id });
    
    res.json({
      success: true,
      stats: {
        equipmentListed: equipmentCount,
        produceListed: produceCount,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
