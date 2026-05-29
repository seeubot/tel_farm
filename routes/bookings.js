const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const Booking = require('../models/Booking');

// Get user's bookings
router.get('/', authenticate, async (req, res) => {
  try {
    const bookings = await Booking.find({
      $or: [{ renterId: req.user._id }, { ownerId: req.user._id }]
    }).sort('-createdAt');
    res.json({ success: true, bookings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create booking
router.post('/', authenticate, async (req, res) => {
  try {
    const booking = await Booking.create({ ...req.body, renterId: req.user._id });
    res.status(201).json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update booking status
router.put('/:id', authenticate, async (req, res) => {
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

module.exports = router;
