// routes/mfa.js
// =================================================================
// Admin MFA (TOTP / Google Authenticator) routes + helpers
// =================================================================
// Exports: { register }
//   register(app, deps)
//     - app:  Express app
//     - deps: { Admin, adminAuth, jwt, crypto }
//
// Wires:
//   POST /api/admin/mfa/setup         (adminAuth) -> QR + secret
//   POST /api/admin/mfa/verify        (adminAuth) -> enables MFA
//   POST /api/admin/mfa/disable       (adminAuth) -> disables MFA (requires code)
//   POST /api/admin/login/verify-mfa  (public)    -> mfaToken + code -> session JWT
//
// Also attached to `register` for use in server.js:
//   generateMfaChallengeToken(adminId)
//   verifyMfaChallengeToken(token)
//   encryptTotpSecret(plain) / decryptTotpSecret(enc)
//   verifyTotpCode(plain, code)
//
// Compatible with otplib v12 (authenticator object) AND v13+ (functional API)
// =================================================================

'use strict';

const ENC_PREFIX = 'mfa:v1';

// ---- otplib v12/v13 compatibility wrapper ----
function otplibGenerateSecret() {
  const otplib = require('otplib');
  // v13+ exports generateSecret as a top-level function
  if (typeof otplib.generateSecret === 'function') {
    return otplib.generateSecret();
  }
  // v12 exposes it on the `authenticator` object
  if (otplib.authenticator && typeof otplib.authenticator.generateSecret === 'function') {
    return otplib.authenticator.generateSecret();
  }
  throw new Error('[mfa] otplib generateSecret not found — check otplib version');
}

function otplibKeyUri(accountName, issuer, secret) {
  const otplib = require('otplib');
  // v13+ functional API
  if (typeof otplib.generateURI === 'function') {
    return otplib.generateURI({ secret, accountName, issuer });
  }
  if (typeof otplib.keyuri === 'function') {
    return otplib.keyuri(accountName, issuer, secret);
  }
  // v12 authenticator object
  if (otplib.authenticator && typeof otplib.authenticator.keyuri === 'function') {
    return otplib.authenticator.keyuri(accountName, issuer, secret);
  }
  throw new Error('[mfa] otplib keyuri/generateURI not found — check otplib version');
}

function otplibVerify(token, secret) {
  const otplib = require('otplib');
  // v13+ functional API
  if (typeof otplib.verify === 'function') {
    return otplib.verify({ token, secret });
  }
  // v12 authenticator object
  if (otplib.authenticator && typeof otplib.authenticator.verify === 'function') {
    return otplib.authenticator.verify({ token, secret });
  }
  throw new Error('[mfa] otplib verify not found — check otplib version');
}

// ---- main register ----
function register(app, deps) {
  const { Admin, adminAuth, jwt, crypto } = deps || {};

  if (!app) throw new Error('[mfa] missing dep: app');
  if (!Admin) throw new Error('[mfa] missing dep: Admin');
  if (!adminAuth) throw new Error('[mfa] missing dep: adminAuth');
  if (!jwt) throw new Error('[mfa] missing dep: jwt');
  if (!crypto) throw new Error('[mfa] missing dep: crypto');

  const JWT_SECRET = process.env.JWT_SECRET || 'agriagent-secret-key';

  // ---------- Encryption ----------
  function getMfaEncryptionKey() {
    const base = (process.env.JWT_SECRET || 'agriagent-secret-key') + ':' + ENC_PREFIX;
    return crypto.createHash('sha256').update(base).digest();
  }

  function encryptTotpSecret(plainSecret) {
    const key = getMfaEncryptionKey();
    const iv = crypto.randomBytes(12); // AES-GCM nonce
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(plainSecret), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return (
      iv.toString('base64') +
      ':' + authTag.toString('base64') +
      ':' + encrypted.toString('base64')
    );
  }

  function decryptTotpSecret(encrypted) {
    if (!encrypted || typeof encrypted !== 'string') return null;
    const parts = encrypted.split(':');
    if (parts.length !== 3) return null;
    try {
      const iv = Buffer.from(parts[0], 'base64');
      const authTag = Buffer.from(parts[1], 'base64');
      const ciphertext = Buffer.from(parts[2], 'base64');
      const key = getMfaEncryptionKey();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted.toString('utf8');
    } catch (e) {
      console.error('[mfa] decrypt failed:', e.message);
      return null;
    }
  }

  // ---------- TOTP ----------
  function generateTotpSecret() {
    return otplibGenerateSecret();
  }

  async function generateMfaQrDataUri(secret, accountName, issuer) {
    const QRCode = require('qrcode');
    const otpauth = otplibKeyUri(accountName, issuer || 'AgriAgent Admin', secret);
    return QRCode.toDataURL(otpauth);
  }

  function verifyTotpCode(plainSecret, code) {
    if (!plainSecret || !code) return false;
    const trimmed = String(code).trim();
    if (!/^\d{6}$/.test(trimmed)) return false;
    try {
      return otplibVerify(trimmed, plainSecret);
    } catch (e) {
      console.error('[mfa] verify failed:', e.message);
      return false;
    }
  }

  // ---------- Challenge token ----------
  function generateMfaChallengeToken(adminId) {
    return jwt.sign(
      { adminId: String(adminId), type: 'admin_mfa_challenge' },
      JWT_SECRET,
      { expiresIn: '5m' }
    );
  }

  function verifyMfaChallengeToken(token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.type !== 'admin_mfa_challenge') return null;
      return decoded;
    } catch (e) {
      return null;
    }
  }

  // ==================== ROUTES ====================

  // ---- 1. Begin setup: generate secret + QR ----
  app.post('/api/admin/mfa/setup', adminAuth, async (req, res) => {
    try {
      if (req.admin.mfaEnabled) {
        return res.status(400).json({ error: 'MFA already enabled. Disable it first to re-enroll.' });
      }

      const secret = generateTotpSecret();
      const qrDataUri = await generateMfaQrDataUri(secret, req.admin.username);

      // Store encrypted secret but keep mfaEnabled=false until first code is verified
      req.admin.mfaSecret = encryptTotpSecret(secret);
      await req.admin.save();

      res.json({
        success: true,
        secret,
        qrDataUri,
        issuer: 'AgriAgent Admin',
        account: req.admin.username,
      });
    } catch (error) {
      console.error('[mfa] setup error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ---- 2. Verify setup: confirm first code, enable MFA ----
  app.post('/api/admin/mfa/verify', adminAuth, async (req, res) => {
    try {
      const { code } = req.body;
      if (!code) return res.status(400).json({ error: 'MFA code required' });
      if (req.admin.mfaEnabled) return res.status(400).json({ error: 'MFA already enabled' });
      if (!req.admin.mfaSecret) return res.status(400).json({ error: 'Call /api/admin/mfa/setup first' });

      const plainSecret = decryptTotpSecret(req.admin.mfaSecret);
      if (!plainSecret) return res.status(500).json({ error: 'Could not read MFA secret' });

      if (!verifyTotpCode(plainSecret, code)) {
        return res.status(401).json({ error: 'Invalid code' });
      }

      req.admin.mfaEnabled = true;
      req.admin.mfaEnabledAt = new Date();
      await req.admin.save();

      res.json({ success: true, message: 'MFA enabled. You will be asked for a code on next login.' });
    } catch (error) {
      console.error('[mfa] verify error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ---- 3. Disable MFA (requires a valid current code) ----
  app.post('/api/admin/mfa/disable', adminAuth, async (req, res) => {
    try {
      const { code } = req.body;
      if (!code) return res.status(400).json({ error: 'Current MFA code required to disable' });
      if (!req.admin.mfaEnabled) return res.status(400).json({ error: 'MFA is not enabled' });

      const plainSecret = decryptTotpSecret(req.admin.mfaSecret);
      if (!plainSecret) return res.status(500).json({ error: 'Could not read MFA secret' });

      if (!verifyTotpCode(plainSecret, code)) {
        return res.status(401).json({ error: 'Invalid code' });
      }

      req.admin.mfaEnabled = false;
      req.admin.mfaSecret = undefined;
      req.admin.mfaEnabledAt = undefined;
      await req.admin.save();

      res.json({ success: true, message: 'MFA disabled' });
    } catch (error) {
      console.error('[mfa] disable error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ---- 4. Step 2 of login: verify MFA code, issue session ----
  app.post('/api/admin/login/verify-mfa', async (req, res) => {
    try {
      const { mfaToken, code } = req.body;
      if (!mfaToken || !code) return res.status(400).json({ error: 'mfaToken and code required' });

      const decoded = verifyMfaChallengeToken(mfaToken);
      if (!decoded) return res.status(401).json({ error: 'MFA session expired. Please log in again.' });

      const adminUser = await Admin.findById(decoded.adminId);
      if (!adminUser || !adminUser.isActive) return res.status(401).json({ error: 'Admin account disabled' });
      if (!adminUser.mfaEnabled) return res.status(400).json({ error: 'MFA is not enabled for this account' });

      const plainSecret = decryptTotpSecret(adminUser.mfaSecret);
      if (!plainSecret) return res.status(500).json({ error: 'Could not read MFA secret' });

      if (!verifyTotpCode(plainSecret, code)) {
        return res.status(401).json({ error: 'Invalid code' });
      }

      adminUser.lastLogin = new Date();
      await adminUser.save();

      const token = jwt.sign(
        { adminId: adminUser._id, role: adminUser.role, type: 'admin' },
        JWT_SECRET,
        { expiresIn: '12h' }
      );

      res.json({
        success: true,
        token,
        admin: {
          id: adminUser._id,
          username: adminUser.username,
          email: adminUser.email,
          role: adminUser.role,
        },
      });
    } catch (error) {
      console.error('[mfa] verify-mfa error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ---------- Expose helpers on register() for server.js login handler ----------
  register.generateMfaChallengeToken = generateMfaChallengeToken;
  register.verifyMfaChallengeToken = verifyMfaChallengeToken;
  register.encryptTotpSecret = encryptTotpSecret;
  register.decryptTotpSecret = decryptTotpSecret;
  register.verifyTotpCode = verifyTotpCode;
}

module.exports = { register };
