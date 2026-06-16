const express = require('express');
const cors = require('cors');
const compression = require('compression');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const multer = require('multer');
const admin = require('firebase-admin');
const { OAuth2Client } = require('google-auth-library');
const rateLimit = require('express-rate-limit');

// ─── Observability: structured logging with timestamps ──────────────────────────
const log = {
  info: (msg, meta = {}) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, meta),
  warn: (msg, meta = {}) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, meta),
  error: (msg, meta = {}) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, meta),
  debug: (msg, meta = {}) => process.env.DEBUG === 'true' && console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`, meta),
};

const app = express();
// Cloud Run sits behind Google's load balancer which sets X-Forwarded-For.
// Without trust proxy, express-rate-limit v7 throws a ValidationError on every request.
app.set('trust proxy', 1);
app.use(compression());
const PORT = process.env.PORT || 8080;
const ALLOWED_DOMAINS = new Set([
  'mediaprima.com.my',
  '8tv.com.my',
  'bh.com.my',
  'bharian.com.my',
  'bigtree.com.my',
  'hmetro.com.my',
  'mediaprima.audio',
  'nst.com.my',
  'nstp.com.my',
  'ntv7.com.my',
  'primeworks.com.my',
  'revmedia.my',
  'thevocket.com',
  'tv3.com.my',
  'tv9.com.my',
  'wowshop.com.my',
]);
const WEB_CLIENT_ID = '116309832828-fokuccsb80ejd27q83rpnpt8751mplk8.apps.googleusercontent.com';
const CSV_PATH = path.join(__dirname, 'mpbstafflist.csv');

// ─── Admin: superadmin + role-based access ───────────────────────────────────
const SUPERADMIN_EMAIL = 'rezwan@mediaprima.com.my';

const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
if (!GOOGLE_CLIENT_SECRET) {
  console.error('FATAL: GOOGLE_CLIENT_SECRET environment variable is not set.');
  process.exit(1);
}

// ─── Staff CSV ────────────────────────────────────────────────────────────────
let staffMap = {};
let lastUploadTime = null;

function loadStaffCSV(csvContent) {
  const records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
  const map = {};
  for (const row of records) {
    if (row.Email) map[row.Email.toLowerCase()] = row;
  }
  return map;
}

// Startup: try Firestore first (survives container restarts + scales across instances),
// fall back to bundled CSV file
async function initStaffMap() {
  try {
    const doc = await db.collection('config').doc('stafflist').get();
    if (doc.exists && doc.data().csv) {
      staffMap = loadStaffCSV(doc.data().csv);
      lastUploadTime = doc.data().updatedAt || null;
      console.log(`Loaded ${Object.keys(staffMap).length} staff records from Firestore`);
      return;
    }
  } catch (e) {
    console.warn('Firestore staff load failed, falling back to local CSV:', e.message);
  }
  try {
    const csv = fs.readFileSync(CSV_PATH, 'utf8');
    staffMap = loadStaffCSV(csv);
    console.log(`Loaded ${Object.keys(staffMap).length} staff records from local CSV`);
  } catch (e) {
    console.error('Failed to load staff CSV:', e.message);
  }
}

// ─── Firestore + Storage ──────────────────────────────────────────────────────
admin.initializeApp({ projectId: 'mp-git-rezwan' });
const db = admin.firestore();
const PHOTO_BUCKET = 'mp-git-rezwan-photos';
const bucket = admin.storage().bucket(PHOTO_BUCKET);
const VALID_THEME_IDS = new Set(['mpb', 'omnia', 'ctn', 'nstp', 'bigtree', 'mpa', 'rev']);

// Percent-encode '@' in GCS URL paths so browsers don't misparse the URL as
// containing userinfo (the "user@host" authority form). Without this Chrome's
// URL parser / CSP engine computes the wrong origin and blocks the img load.
function normaliseGCSUrl(url) {
  if (!url || !url.startsWith('https://storage.googleapis.com/')) return url;
  const qi = url.indexOf('?');
  const base = qi >= 0 ? url.slice(0, qi) : url;
  const query = qi >= 0 ? url.slice(qi) : '';
  return base.replace(/@/g, '%40') + query;
}

// ─── Google Auth ──────────────────────────────────────────────────────────────
const oauthClient = new OAuth2Client(WEB_CLIENT_ID);

// M-5: Proper token verification with aud check via google-auth-library
async function verifyGoogleToken(idToken) {
  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience: WEB_CLIENT_ID,
  });
  return ticket.getPayload();
}

// ─── H-2: CORS locked to Firebase Hosting origin only ────────────────────────
const ALLOWED_ORIGINS = [
  'https://bizcard.mediaprima.com.my',
  'https://mp-git-rezwan.web.app',
];
app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '5mb' }));

// ─── M-1: Rate limiting ───────────────────────────────────────────────────────
const authLimiter    = rateLimit({ windowMs: 15 * 60 * 1000, max: 20,  message: { error: 'Too many requests.' } });
const profileLimiter = rateLimit({ windowMs:  1 * 60 * 1000, max: 30,  message: { error: 'Too many requests.' } });
const adminLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, message: { error: 'Too many requests.' } });
const uploadLimiter  = rateLimit({ windowMs: 15 * 60 * 1000, max: 10,  message: { error: 'Too many requests.' } });
const vcardLimiter   = rateLimit({ windowMs:  1 * 60 * 1000, max: 60,  message: { error: 'Too many requests.' } });

// ─── C-1: Auth middleware — verifies Bearer token + checks email ownership ───
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Missing authorization token.' });
  try {
    const payload = await verifyGoogleToken(token);
    const email = (payload.email || '').toLowerCase();
    if (!ALLOWED_DOMAINS.has(email.split('@')[1])) {
      logAudit('WARN', 'AUTH_DENIED', email, 'Domain not in allowlist', req.ip);
      return res.status(403).json({ error: 'Access denied.' });
    }
    req.authenticatedEmail = email;
    next();
  } catch (err) {
    logAudit('WARN', 'TOKEN_INVALID', '', 'Invalid or expired token: ' + (err.message || ''), req.ip);
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ─── Admin role resolution ───────────────────────────────────────────────────
async function resolveAdminRole(email) {
  if (email === SUPERADMIN_EMAIL) return 'superadmin';
  try {
    const doc = await db.collection('admins').doc(email).get();
    if (doc.exists) return doc.data().role;
  } catch (err) {
    log.error('resolveAdminRole Firestore error', { email, error: err.message });
  }
  return null;
}

async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Missing authorization token.' });
  try {
    const payload = await verifyGoogleToken(token);
    const email = (payload.email || '').toLowerCase();
    if (!ALLOWED_DOMAINS.has(email.split('@')[1])) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    const role = await resolveAdminRole(email);
    if (!role) {
      return res.status(403).json({ error: 'You do not have admin access.' });
    }
    req.adminEmail = email;
    req.adminRole = role;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (req.adminRole === 'superadmin' || roles.includes(req.adminRole)) {
      return next();
    }
    res.status(403).json({ error: 'Insufficient permissions.' });
  };
}

// ─── Audit log helpers ────────────────────────────────────────────────────────
// Masks email to "re****@mediaprima.com.my" for privacy in audit entries
function maskEmail(email) {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at < 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return visible + '****@' + domain;
}

// Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4 → 1.2.3.4)
function normalizeIP(ip) {
  if (!ip) return '';
  return ip.replace(/^::ffff:/, '');
}

// Fire-and-forget — never throws, never delays a response
// level: 'INFO' | 'WARN' | 'ERROR'
const AUDIT_TTL_DAYS = 90;

function logAudit(level, action, email, message, ip) {
  const now = Date.now();
  db.collection('auditLog').add({
    ts: now,
    level,
    action,
    email: maskEmail(email),
    ip: normalizeIP(ip || ''),
    message: String(message || '').slice(0, 500),
    ttl: new Date(now + AUDIT_TTL_DAYS * 86400000),
  }).catch(() => {});
}

// ─── Metrics: simple in-memory counters for observability ────
const metrics = {
  requests: new Map(), // endpoint -> { total, success, error, latencySum, count }
  reset() {
    this.requests.clear();
  },
  record(endpoint, success, latencyMs) {
    const key = endpoint || 'unknown';
    const m = this.requests.get(key) || { total: 0, success: 0, error: 0, latencySum: 0, count: 0 };
    m.total++;
    m.count++;
    if (success) {
      m.success++;
      m.latencySum += latencyMs;
    } else {
      m.error++;
    }
    this.requests.set(key, m);
  },
  getSummary() {
    const summary = {};
    for (const [endpoint, m] of this.requests) {
      summary[endpoint] = {
        total: m.total,
        success: m.success,
        error: m.error,
        errorRate: m.total ? ((m.error / m.total) * 100).toFixed(2) : 0,
        avgLatency: m.count ? (m.latencySum / m.count).toFixed(2) : 0,
      };
    }
    return summary;
  },
};

// ─── M-4: vCard field sanitizer ───────────────────────────────────────────────
function sanitizeVCardField(str) {
  return (str || '').replace(/[\r\n]/g, ' ').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// ─── Health check — public: {status:'ok'} only; admin token: full detail ─────
app.get('/health', async (req, res) => {
  const auth = (req.headers.authorization || '').replace('Bearer ', '').trim();
  let isAdmin = false;
  if (auth) {
    try {
      const payload = await verifyGoogleToken(auth);
      const role = await resolveAdminRole((payload.email || '').toLowerCase());
      isAdmin = !!role;
    } catch (_) {}
  }
  if (!isAdmin) return res.json({ status: 'ok' });

  const startTime = Date.now();
  const [firestoreResult, storageResult] = await Promise.allSettled([
    db.collection('profiles').limit(1).get(),
    bucket.exists(),
  ]);
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    latency: Date.now() - startTime,
    checks: {
      api: 'ok',
      firestore: firestoreResult.status === 'fulfilled' ? 'ok' : 'error',
      storage: storageResult.status === 'fulfilled' && storageResult.value[0] ? 'ok' : 'error',
    },
    metrics: metrics.getSummary(),
  });
});

// PKCE token exchange — frontend sends code+verifier, backend holds client_secret
// Web Application OAuth clients require client_secret; it must never be in frontend code.
app.post('/auth/exchange', authLimiter, async (req, res) => {
  const { code, codeVerifier, redirectUri } = req.body;
  if (!code || !codeVerifier || !redirectUri) {
    return res.status(400).json({ error: 'Missing code, codeVerifier, or redirectUri.' });
  }
  const startTime = Date.now();
  try {
    const ac = new AbortController();
    const acTimer = setTimeout(() => ac.abort(), 8000);
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     WEB_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
        code_verifier: codeVerifier,
      }),
    });
    clearTimeout(acTimer);
    const data = await tokenRes.json();
    if (!tokenRes.ok) {
      logAudit('WARN', 'PKCE_EXCHANGE_FAILED', '', data.error_description || data.error, req.ip);
      return res.status(400).json({ error: data.error_description || 'Token exchange failed.' });
    }
    res.json({ idToken: data.id_token, accessToken: data.access_token || null });
    metrics.record('/auth/exchange', true, Date.now() - startTime);
  } catch (err) {
    logAudit('ERROR', 'PKCE_EXCHANGE_ERROR', '', err.message, req.ip);
    metrics.record('/auth/exchange', false, Date.now() - startTime);
    res.status(500).json({ error: 'Token exchange failed.' });
  }
});

// Auth — rate limited, validates token + aud + domain
app.post('/auth/google', authLimiter, async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'Missing idToken' });

  const startTime = Date.now();
  try {
    const payload = await verifyGoogleToken(idToken);
    const email = (payload.email || '').toLowerCase();

    if (!ALLOWED_DOMAINS.has(email.split('@')[1])) {
      logAudit('WARN', 'AUTH_DENIED', email, 'Domain not in allowlist', req.ip);
      return res.status(403).json({ error: 'Access denied. Please use your Media Prima email.' });
    }

    logAudit('INFO', 'AUTH_SUCCESS', email, 'Sign in', req.ip);

    const staff = staffMap[email] || {};
    res.json({
      Email: email,
      'Employee Name': sanitizeVCardField(staff['Employee Name'] || payload.name || ''),
      'Position Title': sanitizeVCardField(staff['Position Title'] || ''),
      BusinessUnit:     sanitizeVCardField(staff['BusinessUnit'] || ''),
      work_phone:       staff['work_phone'] || '',
      picture:          payload.picture || null,
    });
    metrics.record('/auth/google', true, Date.now() - startTime);
  } catch (err) {
    logAudit('ERROR', 'AUTH_ERROR', '', 'Token verification failed: ' + (err.message || ''), req.ip);
    metrics.record('/auth/google', false, Date.now() - startTime);
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
});

// Profile GET — rate limited, authenticated
app.get('/profile/:email', profileLimiter, requireAuth, async (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  // H-3: Users can only read their own profile
  if (req.authenticatedEmail !== email) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  const startTime = Date.now();
  try {
    const doc = await db.collection('profiles').doc(email).get();
    if (!doc.exists) return res.status(404).json({ error: 'Profile not found' });
    res.json(doc.data());
    metrics.record('/profile/:email', true, Date.now() - startTime);
  } catch (err) {
    logAudit('ERROR', 'PROFILE_READ_ERROR', email, err.message, req.ip);
    metrics.record('/profile/:email', false, Date.now() - startTime);
    res.status(500).json({ error: 'Failed to fetch profile.' });
  }
});

// Profile POST — rate limited, authenticated, ownership enforced
app.post('/profile/:email', profileLimiter, requireAuth, async (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  // C-1: Users can only write their own profile
  if (req.authenticatedEmail !== email) {
    return res.status(403).json({ error: 'You can only edit your own profile.' });
  }
  const { name, title, dept, phone, honorific, photo, theme } = req.body;
  if (name && typeof name === 'string' && name.length > 200) return res.status(400).json({ error: 'Name too long.' });
  if (title && typeof title === 'string' && title.length > 200) return res.status(400).json({ error: 'Title too long.' });
  if (photo && typeof photo === 'string') {
    const validPhoto = /^data:image\/(jpeg|png|webp);base64,/.test(photo) ||
      photo.startsWith('https://storage.googleapis.com/' + PHOTO_BUCKET + '/');
    if (!validPhoto) return res.status(400).json({ error: 'Invalid photo format.' });
    if (photo.length > 300000) return res.status(400).json({ error: 'Photo data too large.' });
  }
  if (theme !== undefined && !VALID_THEME_IDS.has(theme)) return res.status(400).json({ error: 'Invalid theme.' });
  const profile = { name, title, dept, phone, honorific, photo, email, updatedAt: Date.now() };
  if (theme !== undefined) profile.theme = theme;
  try {
    await db.collection('profiles').doc(email).set(profile, { merge: true });
    logAudit('INFO', 'PROFILE_SAVE', email, 'Profile updated', req.ip);
    res.json({ status: 'ok', profile });
  } catch (err) {
    logAudit('ERROR', 'PROFILE_SAVE_ERROR', email, err.message, req.ip);
    res.status(500).json({ error: 'Failed to save profile.' });
  }
});

// ─── Public vCard lookup — no auth, used by share-landing page ───────────────
app.get('/vcard/:email', vcardLimiter, async (req, res) => {
  const email = decodeURIComponent(req.params.email || '').toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email.' });
  }
  const staff = staffMap[email];
  if (!staff) return res.status(404).json({ error: 'Not found.' });

  let edited = {};
  try {
    const doc = await db.collection('profiles').doc(email).get();
    if (doc.exists) edited = doc.data() || {};
  } catch (_) {}

  const data = {
    email,
    name:  sanitizeVCardField(edited.name  || staff['Employee Name']  || ''),
    title: sanitizeVCardField(edited.title || staff['Position Title'] || ''),
    dept:  sanitizeVCardField(edited.dept  || staff['BusinessUnit']   || ''),
    phone: edited.phone || staff['work_phone'] || '',
    photo: normaliseGCSUrl(edited.photo || null),
    theme: VALID_THEME_IDS.has(edited.theme) ? edited.theme : 'mpb',
  };
  res.set('Cache-Control', 'no-store');
  res.json(data);
});

// ─── Public vCard photo proxy — serves photo bytes directly so vcard.html ────
// doesn't need to load a raw GCS URL (which Chrome blocks when @ appears in path)
app.get('/vcard/:email/photo', vcardLimiter, async (req, res) => {
  const email = decodeURIComponent(req.params.email || '').toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).end();
  }
  try {
    const doc = await db.collection('profiles').doc(email).get();
    if (!doc.exists) return res.status(404).end();
    const photoVal = (doc.data() || {}).photo;
    if (!photoVal) return res.status(404).end();

    // base64 data URI — decode and serve directly
    if (photoVal.startsWith('data:')) {
      const m = photoVal.match(/^data:(image\/[a-z]+);base64,(.+)$/);
      if (!m) return res.status(404).end();
      const buf = Buffer.from(m[2], 'base64');
      res.setHeader('Content-Type', m[1]);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(buf);
    }

    // GCS URL — stream proxy server-side (no CORS or @ issues)
    if (!photoVal.startsWith('https://storage.googleapis.com/')) return res.status(404).end();
    const ac = new AbortController();
    const acTimer = setTimeout(() => ac.abort(), 8000);
    const upstream = await fetch(photoVal, { signal: ac.signal });
    clearTimeout(acTimer);
    if (!upstream.ok) return res.status(404).end();
    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    res.status(500).end();
  }
});

// ─── Photo upload — stores to GCS, returns public URL ────────────────────────
app.post('/profile/:email/photo', profileLimiter, requireAuth, async (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  if (req.authenticatedEmail !== email) return res.status(403).json({ error: 'Access denied.' });

  const { photoBase64 } = req.body;
  if (!photoBase64 || typeof photoBase64 !== 'string') {
    return res.status(400).json({ error: 'Missing photoBase64.' });
  }

  const match = photoBase64.match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid image format. JPEG, PNG or WebP only.' });

  const mimeType = match[1];
  const ext = match[2] === 'png' ? 'png' : match[2] === 'webp' ? 'webp' : 'jpg';
  const buffer = Buffer.from(match[3], 'base64');

  if (buffer.length > 1_048_576) return res.status(400).json({ error: 'Photo exceeds 1 MB limit.' });

  const gcsPath = 'profiles/' + email + '/photo.' + ext;
  const file = bucket.file(gcsPath);

  try {
    const now = Date.now();
    await file.save(buffer, {
      contentType: mimeType,
      // Short cache on the GCS object itself — cache-busting is handled via ?v= on the URL
      metadata: { cacheControl: 'public, max-age=86400' },
    });
    // Make the object publicly readable so the storage.googleapis.com URL works in browsers.
    // If the bucket uses Uniform Bucket-Level Access, makePublic() is a no-op (IAM controls
    // access); run: gsutil iam ch allUsers:objectViewer gs://mp-git-rezwan-photos
    await file.makePublic().catch(() => {});
    // Append ?v=<timestamp> so browsers always fetch the new photo even if the path is identical
    const photoUrl = 'https://storage.googleapis.com/' + PHOTO_BUCKET + '/' + gcsPath + '?v=' + now;
    await db.collection('profiles').doc(email).set({ photo: photoUrl }, { merge: true });
    logAudit('INFO', 'PHOTO_UPLOAD_SUCCESS', email, ext + ' photo uploaded (' + Math.round(buffer.length / 1024) + 'KB)', req.ip);
    res.json({ url: photoUrl });
  } catch (err) {
    logAudit('ERROR', 'PHOTO_UPLOAD_ERROR', email, err.message, req.ip);
    console.error('Photo upload failed:', err.message);
    res.status(500).json({ error: 'Failed to upload photo.' });
  } finally {
    metrics.record('/profile/:email/photo', true);
  }
});

// ─── Image proxy — avoids PWA cross-origin image blocking ────────────────────
app.get('/proxy-image', profileLimiter, requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Invalid or missing url parameter.' });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL.' }); }
  if (parsed.protocol !== 'https:') return res.status(400).json({ error: 'HTTPS required.' });
  const isGoogleUser = parsed.hostname.endsWith('.googleusercontent.com');
  const isGCS = parsed.hostname === 'storage.googleapis.com' &&
    parsed.pathname.startsWith('/mp-git-rezwan-photos/');
  if (!isGoogleUser && !isGCS) {
    return res.status(400).json({ error: 'Invalid or missing url parameter.' });
  }
  const startTime = Date.now();
  try {
    const ac = new AbortController();
    const acTimer = setTimeout(() => ac.abort(), 8000);
    const upstream = await fetch(url, { signal: ac.signal });
    clearTimeout(acTimer);
    if (!upstream.ok) return res.status(502).json({ error: 'Upstream fetch failed.' });
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const base64 = 'data:' + contentType + ';base64,' + buffer.toString('base64');
    res.json({ base64 });
    metrics.record('/proxy-image', true, Date.now() - startTime);
  } catch (err) {
    metrics.record('/proxy-image', false, Date.now() - startTime);
    res.status(502).json({ error: 'Failed to proxy image.' });
  }
});

// ─── Admin: stats API ─────────────────────────────────────────────────────────
// Returns health checks + usage metrics. All checks run in parallel.
app.get('/admin/stats', adminLimiter, requireAdmin, requireRole('system_admin'), async (req, res) => {
  const [firestoreCheck, storageCheck, profileCountResult, photoCountResult] =
    await Promise.allSettled([
      // Firestore: lightweight read to verify connectivity
      db.collection('profiles').limit(1).get().then(() => 'ok'),

      // Storage: verify bucket exists
      bucket.exists().then(([exists]) => (exists ? 'ok' : 'error')),

      // Profile count — prefer count() aggregation (Admin SDK v6.5+), fall back to select
      (async () => {
        try {
          const snap = await db.collection('profiles').count().get();
          return snap.data().count;
        } catch (_) {
          const snap = await db.collection('profiles').select([]).get();
          return snap.size;
        }
      })(),

      // Photo count — list GCS files under profiles/ prefix, cap at 500 for speed
      Promise.race([
        bucket.getFiles({ prefix: 'profiles/', maxResults: 500 }).then(([files]) =>
          files.filter(f => /\.(jpg|jpeg|png|webp)$/.test(f.name)).length,
        ),
        new Promise(resolve => setTimeout(() => resolve(null), 6000)),
      ]),
    ]);

  res.json({
    staffCount:   Object.keys(staffMap).length,
    lastUploadTime,
    profileCount: profileCountResult.status === 'fulfilled' ? profileCountResult.value : null,
    photoCount:   photoCountResult.status  === 'fulfilled' ? photoCountResult.value  : null,
    health: {
      api:       'ok',
      firestore: firestoreCheck.status === 'fulfilled' ? firestoreCheck.value : 'error',
      storage:   storageCheck.status   === 'fulfilled' ? storageCheck.value   : 'error',
    },
  });
});

// ─── Admin: audit log API ─────────────────────────────────────────────────────
// Returns last N entries ordered by timestamp desc. Client-side level filtering.
app.get('/admin/audit', adminLimiter, requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  try {
    const snap = await db.collection('auditLog')
      .orderBy('ts', 'desc')
      .limit(limit)
      .get();
    let entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (req.adminRole === 'data_admin') {
      entries = entries.filter(e => e.action === 'CSV_UPLOAD' || e.action === 'CSV_PARSE_ERROR');
    }
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit log.' });
  }
});

// ─── Admin: CSV upload ────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/admin/upload', uploadLimiter, requireAdmin, upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const csvContent = req.file.buffer.toString('utf8');
    const REQUIRED_COLUMNS = ['Email', 'Employee Name', 'Position Title', 'BusinessUnit'];
    const records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });
    if (!records.length) return res.status(400).json({ error: 'CSV is empty.' });
    const headers = Object.keys(records[0]);
    const missing = REQUIRED_COLUMNS.filter(c => !headers.includes(c));
    if (missing.length) return res.status(400).json({ error: 'Missing required columns: ' + missing.join(', ') });
    for (const row of records) {
      for (const key of Object.keys(row)) {
        if (typeof row[key] === 'string' && /^[=+\-@]/.test(row[key])) {
          row[key] = row[key].slice(1);
        }
      }
    }
    const newMap = {};
    for (const row of records) {
      if (row.Email) newMap[row.Email.toLowerCase()] = row;
    }
    const count = Object.keys(newMap).length;
    const now = Date.now();
    await db.collection('config').doc('stafflist').set({ csv: csvContent, updatedAt: now });
    staffMap = newMap;
    lastUploadTime = now;
    const uploadedAt = new Date(now).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour12: true });
    logAudit('INFO', 'CSV_UPLOAD', req.adminEmail, count + ' records loaded', req.ip);
    console.log('Staff list refreshed: ' + count + ' records at ' + uploadedAt);
    res.json({ status: 'ok', count, uploadedAt });
  } catch (err) {
    logAudit('ERROR', 'CSV_PARSE_ERROR', req.adminEmail, err.message, req.ip);
    res.status(400).json({ error: 'Failed to parse CSV: ' + err.message });
  }
});

// ─── Admin: verify token + return role ───────────────────────────────────────
app.post('/admin/verify', adminLimiter, requireAdmin, (req, res) => {
  res.json({ email: req.adminEmail, role: req.adminRole });
});

// ─── Admin: manage admin users ──────────────────────────────────────────────
app.get('/admin/admins', adminLimiter, requireAdmin, requireRole('system_admin'), async (req, res) => {
  try {
    const snap = await db.collection('admins').get();
    const admins = [{ email: SUPERADMIN_EMAIL, role: 'superadmin', addedBy: 'system', addedAt: null }];
    snap.forEach(doc => admins.push({ email: doc.id, ...doc.data() }));
    res.json(admins);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch admin list.' });
  }
});

app.post('/admin/admins', adminLimiter, requireAdmin, express.json(), async (req, res) => {
  const { action, email, role } = req.body;
  const targetEmail = (email || '').toLowerCase().trim();

  if (action === 'add') {
    if (!targetEmail || !ALLOWED_DOMAINS.has(targetEmail.split('@')[1])) {
      return res.status(400).json({ error: 'Invalid or non-MPB email.' });
    }
    if (targetEmail === SUPERADMIN_EMAIL) {
      return res.status(400).json({ error: 'Cannot modify superadmin.' });
    }
    if (role === 'system_admin' && req.adminRole !== 'superadmin') {
      return res.status(403).json({ error: 'Only superadmin can add system admins.' });
    }
    if (role === 'data_admin' && !['superadmin', 'system_admin'].includes(req.adminRole)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    if (!['system_admin', 'data_admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    await db.collection('admins').doc(targetEmail).set({
      role,
      addedBy: req.adminEmail,
      addedAt: Date.now(),
    });
    logAudit('INFO', 'ADMIN_ADD', req.adminEmail, `Added ${role}: ${targetEmail}`, req.ip);
    return res.json({ status: 'ok' });
  }

  if (action === 'remove') {
    if (targetEmail === SUPERADMIN_EMAIL) {
      return res.status(400).json({ error: 'Cannot remove superadmin.' });
    }
    const doc = await db.collection('admins').doc(targetEmail).get();
    if (!doc.exists) return res.status(404).json({ error: 'Admin not found.' });
    const targetRole = doc.data().role;
    if (targetRole === 'system_admin' && req.adminRole !== 'superadmin') {
      return res.status(403).json({ error: 'Only superadmin can remove system admins.' });
    }
    if (targetRole === 'data_admin' && !['superadmin', 'system_admin'].includes(req.adminRole)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    await db.collection('admins').doc(targetEmail).delete();
    logAudit('INFO', 'ADMIN_REMOVE', req.adminEmail, `Removed ${targetRole}: ${targetEmail}`, req.ip);
    return res.json({ status: 'ok' });
  }

  res.status(400).json({ error: 'Invalid action.' });
});

// ─── Admin: dashboard HTML ────────────────────────────────────────────────────
app.get('/admin', adminLimiter, (req, res) => {
  const initData = JSON.stringify({
    staffCount: Object.keys(staffMap).length,
    lastUploadTime,
    clientId: WEB_CLIENT_ID,
  });

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TapCard Admin — Media Prima</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F2EDE6;min-height:100vh;color:#1A1A1A}

    /* Login screen */
    .login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh}
    .login-card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center}
    .login-card h1{font-size:18px;margin-bottom:6px}
    .login-card p{color:#888;font-size:13px;margin-bottom:24px}
    .login-err{color:#991B1B;background:#FEE2E2;padding:10px 14px;border-radius:10px;font-size:13px;margin-bottom:16px;display:none}
    .g-btn{display:inline-flex;align-items:center;gap:10px;padding:12px 28px;background:#fff;border:1.5px solid #E5DDD0;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;color:#1A1A1A;transition:all .15s}
    .g-btn:hover{border-color:#B09050;box-shadow:0 2px 8px rgba(0,0,0,.08)}
    .g-btn svg{width:18px;height:18px}

    /* Header */
    .hdr{background:#E8231A;height:52px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
    .hdr-left{display:flex;align-items:center;gap:10px}
    .hdr-logo{background:#fff;border-radius:4px;padding:3px 7px;font-weight:800;font-size:12px;color:#E8231A}
    .hdr-title{color:#fff;font-weight:700;font-size:14px;letter-spacing:.2px}
    .hdr-right{display:flex;align-items:center;gap:12px}
    .hdr-email{color:rgba(255,255,255,.85);font-size:11px}
    .hdr-role{background:rgba(255,255,255,.18);color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:.3px;text-transform:uppercase}
    .hdr-signout{background:rgba(255,255,255,.15);color:#fff;border:none;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer}
    .hdr-signout:hover{background:rgba(255,255,255,.25)}

    /* Layout */
    .main{max-width:1000px;margin:0 auto;padding:28px 20px 56px}

    /* Page title */
    .pg-title{font-size:22px;font-weight:800;margin-bottom:2px}
    .pg-sub{font-size:13px;color:#888;margin-bottom:24px}

    /* Section label */
    .sec-label{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#aaa;margin-bottom:10px}

    /* Health row */
    .health-row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px}
    .hc{background:#fff;border-radius:12px;padding:14px 18px;box-shadow:0 2px 8px rgba(0,0,0,.05);display:flex;align-items:center;justify-content:space-between}
    .hc-name{font-size:13px;font-weight:600;color:#555}
    .hc-sub{font-size:11px;color:#bbb;margin-top:1px}
    .badge{display:inline-block;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px}
    .badge.ok{background:#D1FAE5;color:#065F46}
    .badge.error{background:#FEE2E2;color:#991B1B}
    .badge.checking{background:#F3F4F6;color:#9CA3AF}

    /* Stats row */
    .stats-row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:28px}
    .sc{background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.05)}
    .sc-label{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#aaa;margin-bottom:8px}
    .sc-value{font-size:34px;font-weight:800;color:#B09050;line-height:1}
    .sc-note{font-size:11px;color:#bbb;margin-top:5px}

    /* Tabs */
    .tab-bar{display:flex;gap:4px;border-bottom:2px solid #E5DDD0;margin-bottom:24px}
    .tab-btn{padding:9px 20px;font-size:13px;font-weight:700;color:#aaa;background:none;border:none;cursor:pointer;border-radius:8px 8px 0 0;transition:color .15s;letter-spacing:.2px}
    .tab-btn.active{color:#B09050;border-bottom:2px solid #B09050;margin-bottom:-2px}
    .tab-btn:hover:not(.active){color:#555;background:rgba(0,0,0,.03)}

    /* Upload tab */
    .upload-card{background:#fff;border-radius:14px;padding:28px;box-shadow:0 2px 8px rgba(0,0,0,.05);max-width:540px}
    .upload-card h2{font-size:16px;font-weight:700;margin-bottom:4px}
    .upload-card p{font-size:13px;color:#888;margin-bottom:20px;line-height:1.6}
    .status-row{background:#F2EDE6;border-radius:10px;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;gap:16px}
    .status-block .sl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#aaa;margin-bottom:3px}
    .status-block .sv{font-size:13px;font-weight:700;color:#555}
    label.fl{display:block;font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
    input[type=file]{display:block;width:100%;padding:12px;border:2px dashed #D5CAB8;border-radius:10px;font-size:13px;color:#666;background:#fafaf8;cursor:pointer;margin-bottom:16px}
    input[type=file]:hover{border-color:#B09050}
    .btn-primary{display:block;width:100%;padding:14px;background:#B09050;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:background .2s}
    .btn-primary:hover{background:#8C7040}
    .btn-primary:disabled{background:#ccc;cursor:not-allowed}
    .flash{margin-top:14px;padding:12px 16px;border-radius:10px;font-size:13px;display:none}
    .flash.success{background:#D1FAE5;color:#065F46;display:block}
    .flash.error{background:#FEE2E2;color:#991B1B;display:block}

    /* Audit tab */
    .audit-ctrl{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px}
    .chips{display:flex;gap:6px;flex-wrap:wrap}
    .chip{padding:5px 13px;border-radius:20px;font-size:11px;font-weight:700;cursor:pointer;border:1.5px solid #E5DDD0;background:#fff;color:#888;transition:all .15s;letter-spacing:.2px}
    .chip.a-all.active{background:#1A1A1A;color:#fff;border-color:#1A1A1A}
    .chip.a-error{border-color:#FCA5A5;color:#B91C1C}
    .chip.a-error.active{background:#EF4444;border-color:#EF4444;color:#fff}
    .chip.a-warn{border-color:#FCD34D;color:#92400E}
    .chip.a-warn.active{background:#F59E0B;border-color:#F59E0B;color:#fff}
    .chip.a-info{border-color:#93C5FD;color:#1D4ED8}
    .chip.a-info.active{background:#3B82F6;border-color:#3B82F6;color:#fff}
    .refresh-row{display:flex;align-items:center;gap:10px}
    .refresh-btn{padding:6px 14px;background:#fff;border:1.5px solid #E5DDD0;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;color:#555;transition:all .15s}
    .refresh-btn:hover{border-color:#B09050;color:#B09050}
    .auto-lbl{font-size:11px;color:#ccc}
    .tbl-wrap{background:#fff;border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,.05);overflow:hidden}
    .atbl{width:100%;border-collapse:collapse;font-size:13px}
    .atbl thead{background:#F9F7F5}
    .atbl th{padding:11px 14px;text-align:left;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#aaa;border-bottom:1px solid #EDE8E0;white-space:nowrap}
    .atbl td{padding:10px 14px;border-bottom:1px solid #F5F0EA;vertical-align:middle}
    .atbl tbody tr:last-child td{border-bottom:none}
    .atbl tbody tr:hover{background:#FAFAF8}
    .lvl{display:inline-block;padding:2px 7px;border-radius:20px;font-size:10px;font-weight:800;letter-spacing:.04em}
    .lvl.ERROR{background:#FEE2E2;color:#991B1B}
    .lvl.WARN{background:#FEF3C7;color:#92400E}
    .lvl.INFO{background:#DBEAFE;color:#1E40AF}
    .act-code{font-family:'SF Mono','Fira Code',monospace;font-size:11px;color:#555;white-space:nowrap}
    .time-cell{font-size:11px;color:#aaa;white-space:nowrap;cursor:default}
    .email-cell{font-size:11px;color:#777;font-family:monospace}
    .ip-cell{font-size:11px;color:#bbb;font-family:monospace}
    .msg-cell{font-size:12px;color:#888;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:default}
    .tbl-empty{text-align:center;padding:40px;color:#ccc;font-size:14px}

    /* Admin management tab */
    .admin-card{background:#fff;border-radius:14px;padding:28px;box-shadow:0 2px 8px rgba(0,0,0,.05);max-width:640px}
    .admin-card h2{font-size:16px;font-weight:700;margin-bottom:16px}
    .add-row{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}
    .add-row input{flex:1;min-width:200px;padding:10px 14px;border:1.5px solid #E5DDD0;border-radius:10px;font-size:13px;outline:none}
    .add-row input:focus{border-color:#B09050}
    .add-row select{padding:10px 14px;border:1.5px solid #E5DDD0;border-radius:10px;font-size:13px;outline:none;background:#fff;min-width:140px}
    .add-row button{padding:10px 20px;background:#B09050;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer}
    .add-row button:hover{background:#8C7040}
    .rm-btn{background:#FEE2E2;color:#991B1B;border:none;padding:4px 12px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer}
    .rm-btn:hover{background:#FECACA}
    .role-badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:.04em}
    .role-badge.superadmin{background:#DBEAFE;color:#1E40AF}
    .role-badge.system_admin{background:#D1FAE5;color:#065F46}
    .role-badge.data_admin{background:#FEF3C7;color:#92400E}

    /* Responsive */
    @media(max-width:640px){
      .health-row,.stats-row{grid-template-columns:1fr 1fr}
      .atbl th:nth-child(5),.atbl td:nth-child(5){display:none}
      .atbl th:nth-child(6),.atbl td:nth-child(6){display:none}
    }
    @media(max-width:420px){
      .health-row,.stats-row{grid-template-columns:1fr}
    }
  </style>
</head>
<body>

<!-- ── Login Screen ──────────────────────────────────────────────────────── -->
<div id="login-screen" class="login-wrap">
  <div class="login-card">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px;justify-content:center">
      <div style="background:#E8231A;border-radius:4px;padding:3px 7px;color:#fff;font-weight:800;font-size:13px">media prima</div>
      <span style="font-weight:700;font-size:14px">TapCard Admin</span>
    </div>
    <h1>Admin Access</h1>
    <p>Sign in with your Media Prima Google account to access the dashboard.</p>
    <div class="login-err" id="login-err"></div>
    <button class="g-btn" id="g-signin" onclick="startGoogleLogin()">
      <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
      Sign in with Google
    </button>
  </div>
</div>

<!-- ── Dashboard (hidden until auth) ─────────────────────────────────────── -->
<div id="dashboard" style="display:none">
<header class="hdr">
  <div class="hdr-left">
    <div class="hdr-logo">media prima</div>
    <span class="hdr-title">TapCard Admin</span>
  </div>
  <div class="hdr-right">
    <span class="hdr-email" id="hdr-email"></span>
    <span class="hdr-role" id="hdr-role"></span>
    <button class="hdr-signout" onclick="signOut()">Sign Out</button>
  </div>
</header>

<div class="main">
  <div class="pg-title">Dashboard</div>
  <div class="pg-sub">Digital Business Card &mdash; Media Prima Group</div>

  <!-- Service Health (system_admin+ only) ─────────────────────────────────── -->
  <div data-min-role="system_admin">
  <div class="sec-label">Service Health</div>
  <div class="sec-label">Service Health</div>
  <div class="health-row">
    <div class="hc">
      <div>
        <div class="hc-name">API Server</div>
        <div class="hc-sub">Cloud Run</div>
      </div>
      <span class="badge ok" id="h-api">OK</span>
    </div>
    <div class="hc">
      <div>
        <div class="hc-name">Firestore</div>
        <div class="hc-sub">Database</div>
      </div>
      <span class="badge checking" id="h-firestore">Checking&hellip;</span>
    </div>
    <div class="hc">
      <div>
        <div class="hc-name">Cloud Storage</div>
        <div class="hc-sub">Photos bucket</div>
      </div>
      <span class="badge checking" id="h-storage">Checking&hellip;</span>
    </div>
  </div>

  <!-- Usage Metrics (system_admin+ only) ──────────────────────────────────── -->
  <div class="sec-label">Usage</div>
  <div class="stats-row">
    <div class="sc">
      <div class="sc-label">Staff Records</div>
      <div class="sc-value" id="s-staff">&mdash;</div>
      <div class="sc-note">Authorised staff CSV</div>
    </div>
    <div class="sc">
      <div class="sc-label">Registered Users</div>
      <div class="sc-value" id="s-profiles">&mdash;</div>
      <div class="sc-note">Cards in Firestore</div>
    </div>
    <div class="sc">
      <div class="sc-label">Profile Photos</div>
      <div class="sc-value" id="s-photos">&mdash;</div>
      <div class="sc-note">In Cloud Storage</div>
    </div>
  </div>
  </div>

  <!-- Tabs ───────────────────────────────────────────────────────────────── -->
  <div class="tab-bar">
    <button class="tab-btn active" id="tbtn-staff" onclick="showTab('staff')">Staff List</button>
    <button class="tab-btn" id="tbtn-audit" onclick="showTab('audit')">Audit Log</button>
    <button class="tab-btn" id="tbtn-admins" onclick="showTab('admins')" data-min-role="system_admin" style="display:none">Admin Users</button>
  </div>

  <!-- Staff List Tab ─────────────────────────────────────────────────────── -->
  <div id="tab-staff">
    <div class="upload-card">
      <h2>Refresh Staff List</h2>
      <p>Upload a new <strong>mpbstafflist.csv</strong> to update the authorised staff directory. All Cloud Run instances pick up the new list immediately via Firestore.</p>
      <div class="status-row">
        <div class="status-block">
          <div class="sl">Records loaded</div>
          <div class="sv" id="ul-count">&mdash;</div>
        </div>
        <div class="status-block" style="text-align:right">
          <div class="sl">Last updated</div>
          <div class="sv" id="ul-ts">&mdash;</div>
        </div>
      </div>
      <label class="fl" for="csvfile">CSV File</label>
      <input type="file" id="csvfile" accept=".csv">
      <button class="btn-primary" id="upload-btn" onclick="uploadCSV()">Upload &amp; Refresh</button>
      <div class="flash" id="upload-msg"></div>
    </div>
  </div>

  <!-- Audit Log Tab ──────────────────────────────────────────────────────── -->
  <div id="tab-audit" hidden>
    <div class="audit-ctrl">
      <div class="chips">
        <button class="chip a-all active"  id="chip-ALL"   onclick="setFilter('ALL')">All</button>
        <button class="chip a-error"       id="chip-ERROR" onclick="setFilter('ERROR')">Error</button>
        <button class="chip a-warn"        id="chip-WARN"  onclick="setFilter('WARN')">Warn</button>
        <button class="chip a-info"        id="chip-INFO"  onclick="setFilter('INFO')">Info</button>
      </div>
      <div class="refresh-row">
        <button class="refresh-btn" onclick="loadAudit()">&#x21bb; Refresh</button>
        <span class="auto-lbl" id="next-refresh">Auto-refresh in 30s</span>
      </div>
    </div>
    <div class="tbl-wrap">
      <table class="atbl">
        <thead>
          <tr>
            <th>Time</th>
            <th>Level</th>
            <th>Action</th>
            <th>Email</th>
            <th>IP</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody id="audit-body">
          <tr><td colspan="6" class="tbl-empty">Loading&hellip;</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Admin Users Tab (system_admin+ only) ───────────────────────────────── -->
  <div id="tab-admins" hidden data-min-role="system_admin">
    <div class="admin-card">
      <h2>Manage Admin Users</h2>
      <div class="add-row" id="add-admin-row">
        <input type="email" id="new-admin-email" placeholder="email@mediaprima.com.my">
        <select id="new-admin-role"><option value="data_admin">Data Admin</option><option value="system_admin">System Admin</option></select>
        <button onclick="addAdmin()">Add Admin</button>
      </div>
      <div class="flash" id="admin-msg"></div>
      <div class="tbl-wrap">
        <table class="atbl">
          <thead><tr><th>Email</th><th>Role</th><th>Added By</th><th></th></tr></thead>
          <tbody id="admin-body"><tr><td colspan="4" class="tbl-empty">Loading&hellip;</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>
</div>

<script>
  var INIT = ${initData};
  var adminToken = null;
  var adminRole = null;
  var adminEmail = null;
  var auditFilter = 'ALL';
  var auditData = [];
  var countdown = 30;

  // ── PKCE helpers ────────────────────────────────────────────────────────────
  function generateCodeVerifier() {
    var arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode.apply(null, arr)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  }
  async function generateCodeChallenge(verifier) {
    var enc = new TextEncoder().encode(verifier);
    var hash = await crypto.subtle.digest('SHA-256', enc);
    return btoa(String.fromCharCode.apply(null, new Uint8Array(hash))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  }

  // ── Auth helpers ──────────────────────────────────────────────────────────
  function authHeaders() {
    return { 'Authorization': 'Bearer ' + adminToken, 'Content-Type': 'application/json' };
  }
  function authHeadersNoBody() {
    return { 'Authorization': 'Bearer ' + adminToken };
  }

  // ── Google Login ──────────────────────────────────────────────────────────
  async function startGoogleLogin() {
    var verifier = generateCodeVerifier();
    var challenge = await generateCodeChallenge(verifier);
    localStorage.setItem('tapcard_admin_cv', verifier);
    var redirectUri = location.origin + '/admin';
    var url = 'https://accounts.google.com/o/oauth2/v2/auth'
      + '?client_id=' + encodeURIComponent(INIT.clientId)
      + '&redirect_uri=' + encodeURIComponent(redirectUri)
      + '&response_type=code'
      + '&scope=' + encodeURIComponent('openid email profile')
      + '&code_challenge=' + encodeURIComponent(challenge)
      + '&code_challenge_method=S256'
      + '&prompt=select_account';
    location.href = url;
  }

  async function handleAuthCallback(code) {
    var verifier = localStorage.getItem('tapcard_admin_cv');
    if (!verifier) { showLoginError('Missing code verifier. Please try again.'); return; }
    localStorage.removeItem('tapcard_admin_cv');
    try {
      var r = await fetch('/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, codeVerifier: verifier, redirectUri: location.origin + '/admin' })
      });
      var data = await r.json();
      if (!r.ok) { showLoginError(data.error || 'Token exchange failed.'); return; }
      adminToken = data.idToken;
      var vr = await fetch('/admin/verify', { method: 'POST', headers: authHeadersNoBody() });
      var vd = await vr.json();
      if (!vr.ok) { showLoginError(vd.error || 'Access denied.'); adminToken = null; return; }
      adminEmail = vd.email;
      adminRole = vd.role;
      localStorage.setItem('tapcard_admin_token', adminToken);
      localStorage.setItem('tapcard_admin_email', adminEmail);
      localStorage.setItem('tapcard_admin_role', adminRole);
      history.replaceState(null, '', '/admin');
      showDashboard();
    } catch(e) { showLoginError('Network error. Please try again.'); }
  }

  async function tryRestoredSession() {
    var token = localStorage.getItem('tapcard_admin_token');
    if (!token) return false;
    try {
      var r = await fetch('/admin/verify', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
      if (!r.ok) { clearSession(); return false; }
      var d = await r.json();
      adminToken = token;
      adminEmail = d.email;
      adminRole = d.role;
      localStorage.setItem('tapcard_admin_role', adminRole);
      return true;
    } catch(e) { clearSession(); return false; }
  }

  function clearSession() {
    adminToken = null; adminEmail = null; adminRole = null;
    localStorage.removeItem('tapcard_admin_token');
    localStorage.removeItem('tapcard_admin_email');
    localStorage.removeItem('tapcard_admin_role');
  }

  function signOut() {
    clearSession();
    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('login-screen').style.display = '';
  }

  function showLoginError(msg) {
    var el = document.getElementById('login-err');
    el.textContent = msg;
    el.style.display = 'block';
  }

  // ── Role-based visibility ─────────────────────────────────────────────────
  var ROLE_RANK = { superadmin: 3, system_admin: 2, data_admin: 1 };
  function applyRoleVisibility() {
    var rank = ROLE_RANK[adminRole] || 0;
    document.querySelectorAll('[data-min-role]').forEach(function(el) {
      var req = ROLE_RANK[el.getAttribute('data-min-role')] || 0;
      el.style.display = rank >= req ? '' : 'none';
    });
    var roleSelect = document.getElementById('new-admin-role');
    if (roleSelect && adminRole !== 'superadmin') {
      var sysOpt = roleSelect.querySelector('option[value=system_admin]');
      if (sysOpt) sysOpt.disabled = true;
    }
  }

  // ── Show dashboard ────────────────────────────────────────────────────────
  function showDashboard() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('dashboard').style.display = '';
    document.getElementById('hdr-email').textContent = adminEmail;
    document.getElementById('hdr-role').textContent = adminRole.replace('_', ' ');
    applyRoleVisibility();
    setCount('s-staff', INIT.staffCount);
    setCount('ul-count', INIT.staffCount);
    setTS('ul-ts', INIT.lastUploadTime);
    if (ROLE_RANK[adminRole] >= 2) fetchStats();
    loadAudit();
    if (ROLE_RANK[adminRole] >= 2) loadAdmins();
    startCountdown();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function setCount(id, n) {
    var el = document.getElementById(id);
    if (el) el.textContent = (n != null && n !== '') ? n.toLocaleString() : '\\u2014';
  }
  function setTS(id, ts) {
    var el = document.getElementById(id);
    if (!el) return;
    if (!ts) { el.textContent = 'Never'; return; }
    el.textContent = new Date(ts).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour12: true });
  }
  function setBadge(id, status) {
    var el = document.getElementById(id);
    if (!el) return;
    el.className = 'badge ' + (status === 'ok' ? 'ok' : 'error');
    el.textContent = status === 'ok' ? 'OK' : 'ERROR';
  }
  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function relativeTime(ts) {
    if (!ts) return '\\u2014';
    var d = Date.now() - ts;
    if (d < 60000)     return Math.floor(d / 1000) + 's ago';
    if (d < 3600000)   return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000)  return Math.floor(d / 3600000) + 'h ago';
    return Math.floor(d / 86400000) + 'd ago';
  }
  function showFlash(el, type, text) {
    el.className = 'flash ' + type;
    el.textContent = text;
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────
  function showTab(tab) {
    ['staff','audit','admins'].forEach(function(t) {
      var panel = document.getElementById('tab-' + t);
      var btn = document.getElementById('tbtn-' + t);
      if (panel) panel.hidden = (t !== tab);
      if (btn) btn.className = 'tab-btn' + (t === tab ? ' active' : '');
    });
    if (tab === 'admins') loadAdmins();
  }

  // ── Stats + Health ─────────────────────────────────────────────────────────
  function fetchStats() {
    fetch('/admin/stats', { headers: authHeadersNoBody() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d) return;
        setBadge('h-firestore', d.health.firestore);
        setBadge('h-storage',   d.health.storage);
        setCount('s-staff',    d.staffCount);
        setCount('s-profiles', d.profileCount);
        setCount('s-photos',   d.photoCount);
        setCount('ul-count',   d.staffCount);
        setTS('ul-ts', d.lastUploadTime);
      })
      .catch(function() {});
  }

  // ── CSV Upload ─────────────────────────────────────────────────────────────
  function uploadCSV() {
    var file = document.getElementById('csvfile').files[0];
    var msg = document.getElementById('upload-msg');
    var btn = document.getElementById('upload-btn');
    if (!file) { showFlash(msg, 'error', 'Please select a CSV file.'); return; }
    msg.className = 'flash'; msg.textContent = '';
    btn.disabled = true; btn.textContent = 'Uploading\\u2026';
    var fd = new FormData(); fd.append('csv', file);
    fetch('/admin/upload', { method: 'POST', headers: authHeadersNoBody(), body: fd })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
      .then(function(result) {
        if (result.ok) {
          showFlash(msg, 'success', 'Staff list updated \\u2014 ' + result.d.count.toLocaleString() + ' records loaded.');
          setCount('ul-count', result.d.count);
          setCount('s-staff',  result.d.count);
          document.getElementById('ul-ts').textContent = result.d.uploadedAt;
          loadAudit();
        } else {
          showFlash(msg, 'error', result.d.error || 'Upload failed.');
        }
      })
      .catch(function() { showFlash(msg, 'error', 'Network error. Please try again.'); })
      .finally(function() { btn.disabled = false; btn.textContent = 'Upload & Refresh'; });
  }

  // ── Audit Log ──────────────────────────────────────────────────────────────
  function setFilter(level) {
    auditFilter = level;
    ['ALL','ERROR','WARN','INFO'].forEach(function(l) {
      var chip = document.getElementById('chip-' + l);
      if (!chip) return;
      chip.className = 'chip a-' + l.toLowerCase() + (l === level ? ' active' : '');
    });
    renderAudit();
  }

  function loadAudit() {
    document.getElementById('audit-body').innerHTML = '<tr><td colspan="6" class="tbl-empty">Loading\\u2026</td></tr>';
    fetch('/admin/audit?limit=200', { headers: authHeadersNoBody() })
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(data) { auditData = data; renderAudit(); })
      .catch(function() {
        document.getElementById('audit-body').innerHTML = '<tr><td colspan="6" class="tbl-empty">Failed to load audit log.</td></tr>';
      });
  }

  function renderAudit() {
    var filtered = auditFilter === 'ALL' ? auditData : auditData.filter(function(e) { return e.level === auditFilter; });
    if (!filtered.length) {
      document.getElementById('audit-body').innerHTML = '<tr><td colspan="6" class="tbl-empty">No entries found.</td></tr>';
      return;
    }
    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      var e = filtered[i];
      var fullTime = e.ts ? new Date(e.ts).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour12: true }) : '';
      html += '<tr>';
      html += '<td class="time-cell" title="' + escHtml(fullTime) + '">' + relativeTime(e.ts) + '</td>';
      html += '<td><span class="lvl ' + escHtml(e.level || '') + '">' + escHtml(e.level || '') + '</span></td>';
      html += '<td class="act-code">' + escHtml(e.action || '\\u2014') + '</td>';
      html += '<td class="email-cell">' + escHtml(e.email || '\\u2014') + '</td>';
      html += '<td class="ip-cell">' + escHtml(e.ip || '\\u2014') + '</td>';
      html += '<td class="msg-cell" title="' + escHtml(e.message || '') + '">' + escHtml(e.message || '\\u2014') + '</td>';
      html += '</tr>';
    }
    document.getElementById('audit-body').innerHTML = html;
  }

  // ── Admin Management ──────────────────────────────────────────────────────
  function loadAdmins() {
    var body = document.getElementById('admin-body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="4" class="tbl-empty">Loading\\u2026</td></tr>';
    fetch('/admin/admins', { headers: authHeadersNoBody() })
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(admins) {
        if (!admins.length) { body.innerHTML = '<tr><td colspan="4" class="tbl-empty">No admins found.</td></tr>'; return; }
        var html = '';
        for (var i = 0; i < admins.length; i++) {
          var a = admins[i];
          html += '<tr>';
          html += '<td class="email-cell">' + escHtml(a.email) + '</td>';
          html += '<td><span class="role-badge ' + escHtml(a.role) + '">' + escHtml(a.role.replace('_',' ')) + '</span></td>';
          html += '<td style="font-size:12px;color:#888">' + escHtml(a.addedBy || '\\u2014') + '</td>';
          html += '<td>';
          if (a.role !== 'superadmin') {
            var canRemove = (adminRole === 'superadmin') || (adminRole === 'system_admin' && a.role === 'data_admin');
            if (canRemove) html += '<button class="rm-btn" onclick="removeAdmin(\\'' + escHtml(a.email) + '\\')">Remove</button>';
          }
          html += '</td></tr>';
        }
        body.innerHTML = html;
      })
      .catch(function() { body.innerHTML = '<tr><td colspan="4" class="tbl-empty">Failed to load admins.</td></tr>'; });
  }

  function addAdmin() {
    var email = document.getElementById('new-admin-email').value.trim();
    var role = document.getElementById('new-admin-role').value;
    var msg = document.getElementById('admin-msg');
    if (!email) { showFlash(msg, 'error', 'Enter an email address.'); return; }
    fetch('/admin/admins', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'add', email: email, role: role }) })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
      .then(function(res) {
        if (res.ok) { showFlash(msg, 'success', 'Admin added.'); document.getElementById('new-admin-email').value = ''; loadAdmins(); }
        else showFlash(msg, 'error', res.d.error || 'Failed.');
      })
      .catch(function() { showFlash(msg, 'error', 'Network error.'); });
  }

  function removeAdmin(email) {
    if (!confirm('Remove admin access for ' + email + '?')) return;
    var msg = document.getElementById('admin-msg');
    fetch('/admin/admins', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'remove', email: email }) })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
      .then(function(res) {
        if (res.ok) { showFlash(msg, 'success', 'Admin removed.'); loadAdmins(); }
        else showFlash(msg, 'error', res.d.error || 'Failed.');
      })
      .catch(function() { showFlash(msg, 'error', 'Network error.'); });
  }

  // ── Auto-refresh ───────────────────────────────────────────────────────────
  function startCountdown() {
    setInterval(function() {
      countdown--;
      if (countdown <= 0) {
        countdown = 30;
        if (ROLE_RANK[adminRole] >= 2) fetchStats();
        if (!document.getElementById('tab-audit').hidden) loadAudit();
      }
      var el = document.getElementById('next-refresh');
      if (el) el.textContent = 'Auto-refresh in ' + countdown + 's';
    }, 1000);
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  (async function() {
    var params = new URLSearchParams(location.search);
    var code = params.get('code');
    if (code) {
      await handleAuthCallback(code);
    } else if (await tryRestoredSession()) {
      showDashboard();
    }
  })();
</script>
</body>
</html>`);
});

// ─── Start ────────────────────────────────────────────────────────────────────
(async () => {
  await initStaffMap();
  const server = app.listen(PORT, () => {
    console.log('TapCard API running on port ' + PORT);
  });

  // Reset metrics hourly to prevent unbounded latencySum accumulation
  setInterval(() => metrics.reset(), 60 * 60 * 1000).unref();

  process.on('SIGTERM', () => {
    console.log('SIGTERM received, draining connections…');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
    // Force exit after 9s if keep-alive connections stall drain
    setTimeout(() => process.exit(1), 9000).unref();
  });
})();
