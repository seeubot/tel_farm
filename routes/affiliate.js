// routes/affiliate.js
// =================================================================
// Affiliate Commission routes
// =================================================================
// Exports: { register }
//   register(app, deps)
//     - app:  Express app
//     - deps: { adminAuth, authenticate, AffiliateItem, AffiliateClick, User }
//
// Wires:
//   PUBLIC:
//     GET  /api/affiliate/items              -> list active items (paginated)
//     GET  /api/affiliate/items/:id          -> single item detail
//     POST /api/affiliate/items/:id/click    -> track click, return redirect URL
//
//   ADMIN (adminAuth):
//     POST   /api/admin/affiliate/items       -> create item
//     PUT    /api/admin/affiliate/items/:id   -> update item
//     DELETE /api/admin/affiliate/items/:id   -> soft delete
//     GET    /api/admin/affiliate/stats       -> click counts + est. revenue
// =================================================================
//
// Play Store policy notes:
//  * Click tracking records userId only if the request is authenticated.
//    Anonymous clicks are allowed (userId = null).
//  * We do NOT store PII beyond IP + User-Agent for fraud checks.
//  * No financial transaction happens in-app — the affiliate link opens
//    an external browser for the user to complete the purchase on the
//    affiliate platform. This keeps us outside Play Billing scope.
// =================================================================

'use strict';

function register(app, deps) {
  const {
    adminAuth,
    authenticate,
    AffiliateItem,
    AffiliateClick,
    User,               // optional, used to enrich admin stats
  } = deps || {};

  if (!app) throw new Error('[affiliate] missing dep: app');
  if (!adminAuth) throw new Error('[affiliate] missing dep: adminAuth');
  if (!authenticate) throw new Error('[affiliate] missing dep: authenticate');
  if (!AffiliateItem) throw new Error('[affiliate] missing dep: AffiliateItem');
  if (!AffiliateClick) throw new Error('[affiliate] missing dep: AffiliateClick');

  // Small helper: safe integer parse for pagination params
  function toPositiveInt(v, fallback, max) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    if (max && n > max) return max;
    return n;
  }

  // ==================== PUBLIC ROUTES ====================

  // ---- GET /api/affiliate/items ----
  // Filters: platform, category, search, page, limit
  app.get('/api/affiliate/items', async (req, res) => {
    try {
      const { platform, category, search } = req.query;
      const page = toPositiveInt(req.query.page, 1, 10000);
      const limit = toPositiveInt(req.query.limit, 20, 100);
      const skip = (page - 1) * limit;

      const query = { isActive: true };
      if (platform && platform !== 'all') query.platform = platform;
      if (category && category !== 'all') query.category = category;
      if (search) {
        query.$or = [
          { title: { $regex: String(search), $options: 'i' } },
          { teluguTitle: { $regex: String(search), $options: 'i' } },
          { description: { $regex: String(search), $options: 'i' } },
        ];
      }

      const [total, items] = await Promise.all([
        AffiliateItem.countDocuments(query),
        AffiliateItem.find(query)
          .sort({ displayOrder: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .select('-createdBy -updatedAt')
          .lean(),
      ]);

      res.json({
        success: true,
        items,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error('[affiliate] list error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ---- GET /api/affiliate/items/:id ----
  app.get('/api/affiliate/items/:id', async (req, res) => {
    try {
      const item = await AffiliateItem.findById(req.params.id)
        .select('-createdBy -updatedAt')
        .lean();
      if (!item || !item.isActive) {
        return res.status(404).json({ error: 'Item not found' });
      }
      res.json({ success: true, item });
    } catch (error) {
      if (error.name === 'CastError') return res.status(400).json({ error: 'Invalid item ID' });
      console.error('[affiliate] detail error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ---- POST /api/affiliate/items/:id/click ----
  // Records a click and returns the affiliate redirect URL.
  // Auth is optional — anonymous users can click, but if authenticated,
  // we attach userId so the admin stats can track unique users.
  //
  // Rate-limiting: reject if same userId+itemId in last 60 seconds,
  // to prevent double-click spam from inflating revenue estimates.
  const CLICK_RATE_LIMIT_SECONDS = 60;
  app.post('/api/affiliate/items/:id/click', async (req, res) => {
    try {
      const item = await AffiliateItem.findById(req.params.id).lean();
      if (!item || !item.isActive) {
        return res.status(404).json({ error: 'Item not found' });
      }

      // Optional auth: try to identify the user
      let userId = null;
      const authHeader = req.headers.authorization || '';
      if (authHeader.startsWith('Bearer ')) {
        try {
          // Call authenticate-like logic manually — we don't want to fail the
          // whole request if the token is bad (anonymous clicks should work).
          // Since server.js already has `authenticate`, we could call it,
          // but it writes to req.user and returns 401 on bad token.
          // For clicks, we only want to *try* to get the user.
          const token = authHeader.split(' ')[1];
          const jwt = require('jsonwebtoken');
          const JWT_SECRET = process.env.JWT_SECRET || 'agriagent-secret-key';
          const decoded = jwt.verify(token, JWT_SECRET);
          if (decoded.userId) userId = decoded.userId;
        } catch (e) {
          // bad token → anonymous click, ignore
        }
      }

      // Duplicate-click guard (only for authenticated users)
      if (userId) {
        const cutoff = new Date(Date.now() - CLICK_RATE_LIMIT_SECONDS * 1000);
        const recent = await AffiliateClick.findOne({
          userId,
          itemId: item._id,
          clickedAt: { $gte: cutoff },
        }).lean();
        if (recent) {
          // Don't record a duplicate, but still return the URL
          return res.json({ success: true, redirectUrl: item.productUrl, duplicate: true });
        }
      }

      // Record the click
      try {
        await AffiliateClick.create({
          itemId: item._id,
          userId: userId || null,
          platform: item.platform,
          ipAddress: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim(),
          deviceInfo: req.headers['x-device-info'] || null,
          userAgent: (req.headers['user-agent'] || '').substring(0, 500),
          clickedAt: new Date(),
        });
      } catch (logErr) {
        // Logging should never block the redirect
        console.error('[affiliate] click log failed:', logErr.message);
      }

      res.json({ success: true, redirectUrl: item.productUrl });
    } catch (error) {
      if (error.name === 'CastError') return res.status(400).json({ error: 'Invalid item ID' });
      console.error('[affiliate] click error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== ADMIN ROUTES ====================

  // ---- POST /api/admin/affiliate/items ----
  app.post('/api/admin/affiliate/items', adminAuth, async (req, res) => {
    try {
      const {
        title, teluguTitle, description,
        platform, category,
        imageUrl, productUrl, downloadUrl,
        commissionRate, isActive, displayOrder,
      } = req.body;

      if (!title || !productUrl) {
        return res.status(400).json({ error: 'title and productUrl are required' });
      }

      // Reject javascript: / data: URLs in productUrl (defense against XSS
      // if a compromised admin account tries to inject a malicious redirect)
      if (!/^https?:\/\//i.test(productUrl)) {
        return res.status(400).json({ error: 'productUrl must be http(s)' });
      }

      const item = await AffiliateItem.create({
        title,
        teluguTitle,
        description,
        platform: platform || 'other',
        category,
        imageUrl,
        productUrl,
        downloadUrl,
        commissionRate: typeof commissionRate === 'number' ? commissionRate : 0,
        isActive: typeof isActive === 'boolean' ? isActive : true,
        displayOrder: typeof displayOrder === 'number' ? displayOrder : 0,
        createdBy: req.admin._id,
      });

      res.status(201).json({ success: true, item });
    } catch (error) {
      console.error('[affiliate] admin create error:', error.message);
      res.status(400).json({ error: error.message });
    }
  });

  // ---- PUT /api/admin/affiliate/items/:id ----
  app.put('/api/admin/affiliate/items/:id', adminAuth, async (req, res) => {
    try {
      const item = await AffiliateItem.findById(req.params.id);
      if (!item) return res.status(404).json({ error: 'Item not found' });

      // If productUrl is being updated, validate it the same way
      if (req.body.productUrl && !/^https?:\/\//i.test(req.body.productUrl)) {
        return res.status(400).json({ error: 'productUrl must be http(s)' });
      }

      const allowed = [
        'title', 'teluguTitle', 'description',
        'platform', 'category',
        'imageUrl', 'productUrl', 'downloadUrl',
        'commissionRate', 'isActive', 'displayOrder',
      ];
      for (const key of allowed) {
        if (req.body[key] !== undefined) item[key] = req.body[key];
      }
      await item.save();

      res.json({ success: true, item });
    } catch (error) {
      if (error.name === 'CastError') return res.status(400).json({ error: 'Invalid item ID' });
      console.error('[affiliate] admin update error:', error.message);
      res.status(400).json({ error: error.message });
    }
  });

  // ---- DELETE /api/admin/affiliate/items/:id ----
  // Soft delete only — historical clicks stay valid for stats.
  app.delete('/api/admin/affiliate/items/:id', adminAuth, async (req, res) => {
    try {
      const item = await AffiliateItem.findById(req.params.id);
      if (!item) return res.status(404).json({ error: 'Item not found' });
      item.isActive = false;
      await item.save();
      res.json({ success: true, message: 'Item removed from listing' });
    } catch (error) {
      if (error.name === 'CastError') return res.status(400).json({ error: 'Invalid item ID' });
      console.error('[affiliate] admin delete error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ---- GET /api/admin/affiliate/stats ----
  // Returns per-item click counts and estimated revenue (clicks × commissionRate).
  // Optional query: ?days=30 (default 30, max 365)
  app.get('/api/admin/affiliate/stats', adminAuth, async (req, res) => {
    try {
      const days = toPositiveInt(req.query.days, 30, 365);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Aggregate clicks grouped by itemId
      const grouped = await AffiliateClick.aggregate([
        { $match: { clickedAt: { $gte: since } } },
        {
          $group: {
            _id: '$itemId',
            clicks: { $sum: 1 },
            uniqueUsers: { $addToSet: '$userId' },
          },
        },
        { $sort: { clicks: -1 } },
        { $limit: 100 },
      ]);

      // Enrich with item details
      const itemIds = grouped.map(g => g._id);
      const items = await AffiliateItem.find({ _id: { $in: itemIds } })
        .select('title platform commissionRate isActive')
        .lean();
      const itemMap = new Map(items.map(i => [String(i._id), i]));

      const rows = grouped.map(g => {
        const it = itemMap.get(String(g._id)) || {};
        const clicks = g.clicks;
        const rate = it.commissionRate || 0;
        // Estimated revenue = clicks × commissionRate%
        // NOTE: this is *rough* — actual commission depends on conversion
        // rate and cart value on the affiliate platform. Use it as a proxy.
        const estimatedRevenue = Math.round(clicks * rate * 100) / 100;
        return {
          itemId: g._id,
          title: it.title || '(deleted item)',
          platform: it.platform || null,
          commissionRate: rate,
          isActive: it.isActive !== false,
          clicks,
          uniqueUsers: g.uniqueUsers.filter(Boolean).length,
          estimatedRevenue,
        };
      });

      // Total metrics
      const totalClicks = rows.reduce((s, r) => s + r.clicks, 0);
      const totalEstimatedRevenue = Math.round(
        rows.reduce((s, r) => s + r.estimatedRevenue, 0) * 100
      ) / 100;

      res.json({
        success: true,
        window: { days, since: since.toISOString() },
        totals: { clicks: totalClicks, estimatedRevenue: totalEstimatedRevenue },
        perItem: rows,
      });
    } catch (error) {
      console.error('[affiliate] stats error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Silence unused var warning in some linters
  void User;
}

module.exports = { register };
