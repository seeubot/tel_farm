// models/AffiliateClick.js
// =================================================================
// AffiliateClick model — one record per affiliate-link click.
// Used for two purposes:
//   1. Analytics (which items get clicked, from which platform)
//   2. Commission tracking (estimated revenue = clicks × rate × AOV)
//
// userId is nullable — anonymous clicks (e.g., logged-out users)
// are still recorded so we don't miss revenue data.
// =================================================================
//
// Exports: { createModel }
//   createModel(mongoose) -> Model
//
// Fields:
//   itemId        AffiliateItem _id (required, indexed)
//   userId        User _id (nullable, indexed) — null for anonymous
//   platform      Snapshot of item's platform at click time
//                 (denormalized so historical clicks stay accurate
//                  even if the item is later edited)
//   ipAddress     Optional, for fraud / duplicate-click detection
//   deviceInfo    Free-form (e.g., "Android 14 / AgriAgent 1.0.6")
//   userAgent     Raw User-Agent header (optional)
//   clickedAt     Timestamp (default: now)
// =================================================================

'use strict';

function createModel(mongoose) {
  if (!mongoose) throw new Error('[AffiliateClick] mongoose not provided');

  const affiliateClickSchema = new mongoose.Schema(
    {
      itemId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AffiliateItem',
        required: true,
        index: true,
      },
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        index: true,
      },

      platform: { type: String, trim: true },
      ipAddress: { type: String, trim: true },
      deviceInfo: { type: String, trim: true },
      userAgent: { type: String, trim: true },

      clickedAt: { type: Date, default: Date.now, index: true },
    },
    {
      // No timestamps: true — we only need clickedAt (single field, set explicitly)
      // Avoids storing redundant createdAt/updatedAt on high-volume collection
      versionKey: false,
    }
  );

  // Index for the admin stats query: aggregate by itemId over a date range
  affiliateClickSchema.index({ itemId: 1, clickedAt: -1 });

  // Index for the per-user rate-limit check:
  //   "did this user click this item in the last hour?"
  affiliateClickSchema.index({ userId: 1, itemId: 1, clickedAt: -1 });

  // TTL — auto-delete click records older than 1 year (keeps collection small).
  // Change `expireAfterSeconds` if your finance/audit requirements need longer retention.
  // 365 days = 60 * 60 * 24 * 365 = 31536000 seconds.
  affiliateClickSchema.index({ clickedAt: 1 }, { expireAfterSeconds: 31536000 });

  return mongoose.models.AffiliateClick ||
    mongoose.model('AffiliateClick', affiliateClickSchema);
}

module.exports = { createModel };
