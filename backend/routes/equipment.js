const express = require('express');
const router = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const Equipment = require('../models/Equipment');

// Get all equipment (with filters)
router.get('/', async (req, res) => {
  try {
    const { category, search, lat, lng, radius = 10 } = req.query;
    
    let query = { 'availability.isAvailable': true };
    
    if (category && category !== 'all') {
      query.category = category;
    }
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { teluguName: { $regex: search, $options: 'i' } },
      ];
    }
    
    // Location-based search
    if (lat && lng) {
      query.location = {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [parseFloat(lng), parseFloat(lat)],
          },
          $maxDistance: parseFloat(radius) * 1000, // Convert km to meters
        },
      };
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

// Get single equipment
router.get('/:id', async (req, res) => {
  try {
    const equipment = await Equipment.findById(req.params.id)
      .populate('ownerId', 'profile.name profile.profileImage profile.phone verification.isVerified ratings');
    
    if (!equipment) {
      return res.status(404).json({ error: 'Equipment not found' });
    }
    
    res.json({ success: true, equipment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create equipment listing
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      name,
      teluguName,
      category,
      description,
      pricing,
      location,
      features,
      images,
    } = req.body;
    
    const equipment = await Equipment.create({
      ownerId: req.user._id,
      name,
      teluguName,
      category,
      description,
      pricing,
      location,
      features,
      images,
      isVerified: req.user.verification.isVerified,
    });
    
    res.status(201).json({ success: true, equipment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update equipment
router.put('/:id', authenticate, async (req, res) => {
  try {
    const equipment = await Equipment.findById(req.params.id);
    
    if (!equipment) {
      return res.status(404).json({ error: 'Equipment not found' });
    }
    
    if (equipment.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    Object.assign(equipment, req.body);
    equipment.updatedAt = Date.now();
    await equipment.save();
    
    res.json({ success: true, equipment });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete equipment
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const equipment = await Equipment.findById(req.params.id);
    
    if (!equipment) {
      return res.status(404).json({ error: 'Equipment not found' });
    }
    
    if (equipment.ownerId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    await equipment.deleteOne();
    
    res.json({ success: true, message: 'Equipment deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
