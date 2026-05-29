const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const Produce = require('../models/Produce');

// Get all produce listings
router.get('/', async (req, res) => {
  try {
    const { crop, search, organic } = req.query;
    let query = { isAvailable: true };
    
    if (crop && crop !== 'all') query.cropName = crop;
    if (search) {
      query.$or = [
        { cropName: { $regex: search, $options: 'i' } },
        { variety: { $regex: search, $options: 'i' } },
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

// Get single produce listing
router.get('/:id', async (req, res) => {
  try {
    const produce = await Produce.findById(req.params.id)
      .populate('farmerId', 'profile.name profile.profileImage profile.phone verification.isVerified ratings');
    if (!produce) return res.status(404).json({ error: 'Produce not found' });
    res.json({ success: true, produce });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create produce listing
router.post('/', authenticate, async (req, res) => {
  try {
    const produce = await Produce.create({ ...req.body, farmerId: req.user._id });
    res.status(201).json({ success: true, produce });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update produce listing
router.put('/:id', authenticate, async (req, res) => {
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

// Delete produce listing
router.delete('/:id', authenticate, async (req, res) => {
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

module.exports = router;
