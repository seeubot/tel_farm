// models/AffiliateItem.js
// =================================================================
// AffiliateItem model — admin-curated products from affiliate
// platforms (Amazon, Flipkart, etc.) that the user app displays
// with a "Buy" button. Clicking routes through /api/affiliate/items/:id/click
// so we can track clicks and estimate commission.
// =================================================================
//
// Exports: { createModel }
//   createModel(mongoose)
//     -> returns the Mongoose Model (registered once per process)
//
// Fields:
//   title           Product title (required)
//   teluguTitle     Optional Telugu translation
//   description     Short description
//   platform        'amazon' | 'flipkart' | 'meesho' | 'other'
//   category        Free-form category string (Electronics, Fashion, ...)
//   imageUrl        Product image
//   productUrl      Affiliate URL (the actual redirect)
//   downloadUrl     Optional APK/app download URL (for "app install" offers)
//   commissionRate  Percent (e.g., 5.5 for 5.5%)
//   isActive        Soft-delete flag (default true)
//   displayOrder    Sort order (default 0 — higher first)
//   createdBy       Admin _id who created this
//   createdAt
//   updatedAt
// =================================================================

'use strict';

function createModel(mongoose) {
  if (!mongoose) throw new Error('[AffiliateItem] mongoose not provided');

  const affiliateItemSchema = new mongoose.Schema(
    {
      title: { type: String, required: true, trim: true },
      teluguTitle: { type: String, trim: true },
      description: { type: String, trim: true },

      platform: {
        type: String,
        enum: ['amazon', 'flipkart', 'meesho', 'other'],
        default: 'other',
        index: true,
      },
      category: { type: String, trim: true, index: true },

      imageUrl: { type: String, trim: true },
      productUrl: { type: String, required: true, trim: true },
      downloadUrl: { type: String, trim: true },

      commissionRate: { type: Number, default: 0, min: 0, max: 100 },

      isActive: { type: Boolean, default: true, index: true },
      displayOrder: { type: Number, default: 0, index: true },

      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    },
    { timestamps: true }
  );

  // Compound index for the common public query:
  //   find({ isActive: true }).sort({ displayOrder: -1, createdAt: -1 })
  affiliateItemSchema.index({ isActive: 1, displayOrder: -1, createdAt: -1 });

  // Prevent "OverwriteModelError" if this file is required multiple times in dev
  return mongoose.models.AffiliateItem ||
    mongoose.model('AffiliateItem', affiliateItemSchema);
}

module.exports = { createModel };
