# Backend Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy the MPB backend into `backend/`, strip all hardcoded MPB values, add `/api/config` endpoint, add Firestore-backed theme CRUD, and add a Themes admin tab — resulting in a fully generic, env-var-driven backend.

**Architecture:** Single `index.js` Express server with all MPB constants replaced by required env vars validated at startup via an extracted `validateEnv()` helper. Themes stored in `config/themes` Firestore doc, served by `/api/config` (public). Admin dashboard gains a Themes tab for CRUD + asset upload.

**Tech Stack:** Node.js 20, Express, firebase-admin, google-auth-library, express-rate-limit, multer, csv-parse, cors, compression, Jest, supertest

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `backend/index.js` | Create (copy + modify) | Main server — all MPB constants removed |
| `backend/validateEnv.js` | Create | Extracted env validation helper (testable in isolation) |
| `backend/package.json` | Create | Deps + test script |
| `backend/Dockerfile` | Create | Production image |
| `backend/__tests__/validateEnv.test.js` | Create | Env var validation unit tests |
| `backend/__tests__/apiConfig.test.js` | Create | GET /api/config integration tests |
| `backend/__tests__/themes.test.js` | Create | Theme CRUD integration tests |
| `backend/__tests__/helpers/mockFirebase.js` | Create | Firestore/Storage mock factory |
| `customer-template/firebase.json.template` | Create | Rewrite-complete hosting template |

---

## Task 1: Scaffold backend/

**Files:**
- Create: `backend/package.json`
- Create: `backend/Dockerfile`
- Create: `backend/__tests__/helpers/mockFirebase.js`

- [ ] **Step 1.1: Create package.json**

```json
{
  "name": "tapcard-backend",
  "version": "1.0.0",
  "description": "TapCard API server",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "test": "jest --runInBand --forceExit",
    "test:watch": "jest --watch --runInBand"
  },
  "dependencies": {
    "compression": "^1.7.4",
    "cors": "^2.8.5",
    "csv-parse": "^5.5.3",
    "express": "^4.18.2",
    "express-rate-limit": "^7.1.5",
    "firebase-admin": "^12.0.0",
    "google-auth-library": "^9.4.1",
    "multer": "^1.4.5-lts.1"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^6.3.4"
  },
  "jest": {
    "testEnvironment": "node",
    "testMatch": ["**/__tests__/**/*.test.js"]
  }
}
```

Save to `backend/package.json`.

- [ ] **Step 1.2: Copy backend source**

```bash
cp ~/claude/project/tapcard/tapcard-backend/index.js ~/claude/tapcard-product/backend/index.js
cp ~/claude/project/tapcard/tapcard-backend/mpbstafflist.csv ~/claude/tapcard-product/backend/mpbstafflist.csv 2>/dev/null || true
```

- [ ] **Step 1.3: Create Dockerfile**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "index.js"]
```

Save to `backend/Dockerfile`.

- [ ] **Step 1.4: Create mockFirebase.js**

```javascript
// Shared Firestore + Storage mock factory used across test suites.

function makeFirestoreMock(docData) {
  const docs = Object.assign({}, docData || {});

  const docRef = function(path) {
    return {
      get: jest.fn(function() {
        return Promise.resolve({
          exists: path in docs,
          data: function() { return docs[path]; },
        });
      }),
      set: jest.fn(function(data) {
        docs[path] = data;
        return Promise.resolve();
      }),
      update: jest.fn(function(data) {
        docs[path] = Object.assign({}, docs[path] || {}, data);
        return Promise.resolve();
      }),
      delete: jest.fn(function() {
        delete docs[path];
        return Promise.resolve();
      }),
    };
  };

  return {
    collection: jest.fn(function() {
      return {
        doc: jest.fn(function(id) { return docRef(id); }),
        add: jest.fn(function(data) {
          const id = 'auto-' + Date.now();
          docs[id] = data;
          return Promise.resolve({ id: id });
        }),
        get: jest.fn(function() {
          return Promise.resolve({
            docs: Object.keys(docs).map(function(id) {
              return { id: id, data: function() { return docs[id]; }, exists: true };
            }),
          });
        }),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
      };
    }),
    doc: jest.fn(function(path) { return docRef(path); }),
    _docs: docs,
  };
}

function makeStorageMock() {
  const files = {};
  const mockFile = function(name) {
    return {
      save: jest.fn(function(buf, opts) {
        files[name] = { buf: buf, opts: opts };
        return Promise.resolve();
      }),
      makePublic: jest.fn(function() { return Promise.resolve(); }),
      publicUrl: function() { return 'https://storage.example.com/' + name; },
    };
  };

  return {
    bucket: jest.fn(function() {
      return { file: jest.fn(function(name) { return mockFile(name); }) };
    }),
    _files: files,
  };
}

module.exports = { makeFirestoreMock: makeFirestoreMock, makeStorageMock: makeStorageMock };
```

Save to `backend/__tests__/helpers/mockFirebase.js`.

- [ ] **Step 1.5: Create test dirs and install deps**

```bash
cd ~/claude/tapcard-product/backend
mkdir -p __tests__/helpers
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 1.6: Commit scaffold**

```bash
cd ~/claude/tapcard-product
git add backend/
git commit -m "feat(backend): scaffold with package.json, Dockerfile, and test helpers"
```

---

## Task 2: Extract validateEnv + replace all hardcoded MPB constants

**Files:**
- Create: `backend/validateEnv.js`
- Modify: `backend/index.js`

- [ ] **Step 2.1: Create validateEnv.js**

```javascript
// Validates that all required environment variables are present.
// Returns array of missing variable names. Empty array = all present.

const REQUIRED_ENV = [
  'GOOGLE_CLIENT_SECRET',
  'OAUTH_CLIENT_ID',
  'ALLOWED_DOMAINS',
  'SUPERADMIN_EMAIL',
  'GCP_PROJECT_ID',
  'PHOTO_BUCKET',
  'CORS_ORIGINS',
];

function validateEnv(env) {
  return REQUIRED_ENV.filter(function(k) { return !env[k]; });
}

module.exports = { validateEnv: validateEnv, REQUIRED_ENV: REQUIRED_ENV };
```

Save to `backend/validateEnv.js`.

- [ ] **Step 2.2: Replace env var block at top of index.js**

Find and replace the existing constant declarations (everything from `const ADMIN_KEY` through the PHOTO_BUCKET and ALLOWED_ORIGINS lines) with:

```javascript
const { validateEnv } = require('./validateEnv');

const missing = validateEnv(process.env);
if (missing.length > 0) {
  console.error('FATAL: Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

const ADMIN_KEY = process.env.ADMIN_KEY || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const ALLOWED_DOMAINS = process.env.ALLOWED_DOMAINS.split(',').map(function(d) { return d.trim().toLowerCase(); });
const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL.toLowerCase().trim();
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const PHOTO_BUCKET = process.env.PHOTO_BUCKET;
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS.split(',').map(function(o) { return o.trim(); });
const APP_NAME = process.env.APP_NAME || 'TapCard';
const PORT = parseInt(process.env.PORT || '8080', 10);
const DEBUG = process.env.DEBUG === 'true';
```

- [ ] **Step 2.3: Fix firebase-admin init**

Find:
```javascript
admin.initializeApp({ projectId: 'mp-git-rezwan' });
```

Replace with:
```javascript
admin.initializeApp({ projectId: GCP_PROJECT_ID });
```

- [ ] **Step 2.4: Remove VALID_THEME_IDS and WEB_CLIENT_ID**

Find and delete the line:
```javascript
const VALID_THEME_IDS = new Set(['mpb', 'nstp', 'bigtree', 'omnia', 'ctn', 'mpa', 'rev']);
```

Find and delete the line containing:
```
const WEB_CLIENT_ID = '116309832828-
```

- [ ] **Step 2.5: Replace WEB_CLIENT_ID references in requireAuth**

In the `requireAuth` middleware, find `WEB_CLIENT_ID` and replace with `OAUTH_CLIENT_ID`.

- [ ] **Step 2.6: Remove VALID_THEME_IDS validation from profile update**

Find any validation that checks `VALID_THEME_IDS.has(theme)` and remove that guard (themes are now dynamic from Firestore).

- [ ] **Step 2.7: Export app for tests**

Find the server startup block at the bottom (the IIFE or `app.listen` call). Replace with:

```javascript
// Only listen when run directly — allows require() in tests
if (require.main === module) {
  (function() {
    initStaffMap().then(function() {
      const server = app.listen(PORT, function() {
        console.log('TapCard API listening on port ' + PORT);
      });
      process.on('SIGTERM', function() {
        server.close(function() { process.exit(0); });
      });
    });
  })();
}

module.exports = app;
```

- [ ] **Step 2.8: Fix admin UI placeholder text**

In the inline admin HTML template literal (search for `mediaprima.com.my` or `Admin`), replace the hardcoded domain reference in any email placeholder or page title with `${APP_NAME}`.

- [ ] **Step 2.9: Commit**

```bash
cd ~/claude/tapcard-product
git add backend/validateEnv.js backend/index.js
git commit -m "feat(backend): extract validateEnv + replace all MPB hardcoded constants with env vars"
```

---

## Task 3: validateEnv unit tests

**Files:**
- Create: `backend/__tests__/validateEnv.test.js`

- [ ] **Step 3.1: Write tests**

```javascript
const { validateEnv, REQUIRED_ENV } = require('../validateEnv');

describe('validateEnv', () => {
  const FULL_ENV = {
    GOOGLE_CLIENT_SECRET: 'test-secret',
    OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    ALLOWED_DOMAINS: 'acme.com,sub.acme.com',
    SUPERADMIN_EMAIL: 'admin@acme.com',
    GCP_PROJECT_ID: 'acme-tapcard',
    PHOTO_BUCKET: 'acme-photos',
    CORS_ORIGINS: 'https://cards.acme.com',
  };

  test('returns empty array when all vars present', () => {
    expect(validateEnv(FULL_ENV)).toEqual([]);
  });

  test('returns missing var name when one is absent', () => {
    const env = Object.assign({}, FULL_ENV);
    delete env.GOOGLE_CLIENT_SECRET;
    const missing = validateEnv(env);
    expect(missing).toContain('GOOGLE_CLIENT_SECRET');
    expect(missing).toHaveLength(1);
  });

  test('returns all missing vars when env is empty', () => {
    const missing = validateEnv({});
    expect(missing).toEqual(expect.arrayContaining(REQUIRED_ENV));
    expect(missing).toHaveLength(REQUIRED_ENV.length);
  });

  test('treats empty string as missing', () => {
    const env = Object.assign({}, FULL_ENV, { OAUTH_CLIENT_ID: '' });
    expect(validateEnv(env)).toContain('OAUTH_CLIENT_ID');
  });
});
```

Save to `backend/__tests__/validateEnv.test.js`.

- [ ] **Step 3.2: Run tests — expect PASS**

```bash
cd ~/claude/tapcard-product/backend
npx jest __tests__/validateEnv.test.js --verbose
```

Expected: all 4 tests PASS.

- [ ] **Step 3.3: Commit**

```bash
cd ~/claude/tapcard-product
git add backend/__tests__/validateEnv.test.js
git commit -m "test(backend): validateEnv unit tests"
```

---

## Task 4: GET /api/config endpoint

**Files:**
- Modify: `backend/index.js` (add route + Firestore reads)
- Create: `backend/__tests__/apiConfig.test.js`

- [ ] **Step 4.1: Write failing test first**

```javascript
// Tests for GET /api/config — public endpoint serving themes + oauth config.

const request = require('supertest');
const { makeFirestoreMock } = require('./helpers/mockFirebase');

const THEMES = [{ id: 'main', name: 'ACME Corp', landingBg: '#003366', accent: '#0055AA', accentDark: '#003D7A', swatchColor: '#0055AA', corporateLayout: true }];

const mockDb = makeFirestoreMock({
  'themes': { themes: THEMES },
  'app': { name: 'ACME Digital Cards' },
});

jest.mock('firebase-admin', function() {
  return {
    initializeApp: jest.fn(),
    firestore: jest.fn(function() { return mockDb; }),
    storage: jest.fn(function() { return { bucket: jest.fn(function() { return {}; }) }; }),
    credential: { applicationDefault: jest.fn() },
  };
});

process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.OAUTH_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.ALLOWED_DOMAINS = 'acme.com';
process.env.SUPERADMIN_EMAIL = 'admin@acme.com';
process.env.GCP_PROJECT_ID = 'acme-tapcard';
process.env.PHOTO_BUCKET = 'acme-photos';
process.env.CORS_ORIGINS = 'https://cards.acme.com';
process.env.APP_NAME = 'ACME Digital Cards';

const app = require('../index');

describe('GET /api/config', function() {
  test('returns 200 with themes, oauthClientId, appName', async function() {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.oauthClientId).toBe('test-client.apps.googleusercontent.com');
    expect(res.body.appName).toBe('ACME Digital Cards');
    expect(Array.isArray(res.body.themes)).toBe(true);
    expect(res.body.themes[0].id).toBe('main');
  });

  test('returns empty themes array when Firestore has no themes doc', async function() {
    const saved = mockDb._docs['themes'];
    delete mockDb._docs['themes'];
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.themes)).toBe(true);
    mockDb._docs['themes'] = saved;
  });

  test('no auth required — no 401 or 403', async function() {
    const res = await request(app).get('/api/config');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
```

Save to `backend/__tests__/apiConfig.test.js`.

- [ ] **Step 4.2: Run test — expect FAIL**

```bash
cd ~/claude/tapcard-product/backend
npx jest __tests__/apiConfig.test.js --verbose
```

Expected: FAIL — `/api/config` route not found (404).

- [ ] **Step 4.3: Add /api/config route to index.js**

Add after the health endpoint (`GET /health`):

```javascript
// ── Public config endpoint ────────────────────────────────────────────────────
app.get('/api/config', async function(req, res) {
  try {
    const db = admin.firestore();
    const [themesSnap, appSnap] = await Promise.all([
      db.collection('config').doc('themes').get(),
      db.collection('config').doc('app').get(),
    ]);

    const themes = (themesSnap.exists && themesSnap.data().themes) || [];
    const appName = (appSnap.exists && appSnap.data().name) || APP_NAME;

    res.json({ oauthClientId: OAUTH_CLIENT_ID, appName: appName, themes: themes });
  } catch (err) {
    console.error('GET /api/config error:', err.message);
    res.json({ oauthClientId: OAUTH_CLIENT_ID, appName: APP_NAME, themes: [] });
  }
});
```

- [ ] **Step 4.4: Run test — expect PASS**

```bash
cd ~/claude/tapcard-product/backend
npx jest __tests__/apiConfig.test.js --verbose
```

Expected: all 3 tests PASS.

- [ ] **Step 4.5: Commit**

```bash
cd ~/claude/tapcard-product
git add backend/index.js backend/__tests__/apiConfig.test.js
git commit -m "feat(backend): add GET /api/config endpoint with Firestore themes"
```

---

## Task 5: Theme CRUD routes

**Files:**
- Modify: `backend/index.js` (add 5 theme routes + helpers)
- Create: `backend/__tests__/themes.test.js`

Theme object shape (write to Firestore `config/themes → { themes: [...] }`):
```javascript
{
  id: string,           // slug: "main", "subsidiary-a"
  name: string,         // display name
  landingBg: string,    // hex: "#003366"
  accent: string,       // hex
  accentDark: string,   // hex
  swatchColor: string,  // hex
  corporateLayout: boolean,
  subsidiary: {         // optional
    companyName: string,
    addressLines: string[],
    website: string,
  }
}
```

- [ ] **Step 5.1: Write failing tests**

```javascript
const request = require('supertest');
const { makeFirestoreMock, makeStorageMock } = require('./helpers/mockFirebase');

const INITIAL_THEMES = [
  { id: 'main', name: 'ACME Corp', landingBg: '#003366', accent: '#0055AA', accentDark: '#003D7A', swatchColor: '#0055AA', corporateLayout: true },
];

const mockDb = makeFirestoreMock({
  'themes': { themes: INITIAL_THEMES.slice() },
  'app': { name: 'ACME Digital Cards' },
  'admin@acme.com': { role: 'system_admin', email: 'admin@acme.com' },
});

const mockStorage = makeStorageMock();

jest.mock('firebase-admin', function() {
  return {
    initializeApp: jest.fn(),
    firestore: jest.fn(function() { return mockDb; }),
    storage: jest.fn(function() { return mockStorage; }),
    credential: { applicationDefault: jest.fn() },
  };
});

jest.mock('google-auth-library', function() {
  return {
    OAuth2Client: jest.fn().mockImplementation(function() {
      return {
        verifyIdToken: jest.fn().mockResolvedValue({
          getPayload: function() { return { email: 'admin@acme.com', hd: 'acme.com' }; },
        }),
      };
    }),
  };
});

process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.OAUTH_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.ALLOWED_DOMAINS = 'acme.com';
process.env.SUPERADMIN_EMAIL = 'admin@acme.com';
process.env.GCP_PROJECT_ID = 'acme-tapcard';
process.env.PHOTO_BUCKET = 'acme-photos';
process.env.CORS_ORIGINS = 'https://cards.acme.com';

const app = require('../index');

const AUTH = { Authorization: 'Bearer mock-token' };

const NEW_THEME = {
  id: 'subsidiary-b',
  name: 'Subsidiary B',
  landingBg: '#1a1a2e',
  accent: '#4a90d9',
  accentDark: '#357abd',
  swatchColor: '#4a90d9',
  corporateLayout: false,
};

describe('GET /admin/themes', function() {
  test('returns themes array', async function() {
    const res = await request(app).get('/admin/themes').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.themes)).toBe(true);
    expect(res.body.themes[0].id).toBe('main');
  });

  test('401 without auth', async function() {
    const res = await request(app).get('/admin/themes');
    expect(res.status).toBe(401);
  });
});

describe('POST /admin/themes', function() {
  test('adds new theme', async function() {
    const res = await request(app).post('/admin/themes').set(AUTH).send(NEW_THEME);
    expect(res.status).toBe(201);
    expect(res.body.theme.id).toBe('subsidiary-b');
    const list = await request(app).get('/admin/themes').set(AUTH);
    expect(list.body.themes.length).toBe(2);
  });

  test('400 if id missing', async function() {
    const res = await request(app).post('/admin/themes').set(AUTH).send({ name: 'No ID' });
    expect(res.status).toBe(400);
  });

  test('409 if id already exists', async function() {
    const res = await request(app).post('/admin/themes').set(AUTH).send({ id: 'main', name: 'Duplicate' });
    expect(res.status).toBe(409);
  });
});

describe('PUT /admin/themes/:id', function() {
  test('updates existing theme', async function() {
    const updated = Object.assign({}, INITIAL_THEMES[0], { name: 'ACME Corp Updated' });
    const res = await request(app).put('/admin/themes/main').set(AUTH).send(updated);
    expect(res.status).toBe(200);
    expect(res.body.theme.name).toBe('ACME Corp Updated');
  });

  test('404 if theme not found', async function() {
    const res = await request(app).put('/admin/themes/nonexistent').set(AUTH).send({ id: 'nonexistent', name: 'Ghost' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /admin/themes/:id', function() {
  test('removes theme from array', async function() {
    const res = await request(app).delete('/admin/themes/subsidiary-b').set(AUTH);
    expect(res.status).toBe(200);
    const list = await request(app).get('/admin/themes').set(AUTH);
    const found = list.body.themes.find(function(t) { return t.id === 'subsidiary-b'; });
    expect(found).toBeUndefined();
  });

  test('404 if theme not found', async function() {
    const res = await request(app).delete('/admin/themes/nonexistent').set(AUTH);
    expect(res.status).toBe(404);
  });
});
```

Save to `backend/__tests__/themes.test.js`.

- [ ] **Step 5.2: Run tests — expect FAIL**

```bash
cd ~/claude/tapcard-product/backend
npx jest __tests__/themes.test.js --verbose
```

Expected: FAIL — routes 404.

- [ ] **Step 5.3: Add requireAdminRole helper to index.js**

Add near the `requireAdminKey` middleware:

```javascript
function requireAdminRole(roles) {
  return function(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (roles.indexOf(req.user.adminRole) === -1) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}
```

- [ ] **Step 5.4: Add theme CRUD routes to index.js**

Add after the `/api/config` route:

```javascript
// ── Theme helpers ─────────────────────────────────────────────────────────────

async function loadThemes() {
  const db = admin.firestore();
  const snap = await db.collection('config').doc('themes').get();
  return (snap.exists && snap.data().themes) || [];
}

async function saveThemes(themes) {
  const db = admin.firestore();
  await db.collection('config').doc('themes').set({ themes: themes });
}

// ── Theme CRUD routes (system_admin + superadmin only) ────────────────────────

app.get('/admin/themes', requireAuth, requireAdminRole(['system_admin', 'superadmin']), async function(req, res) {
  try {
    res.json({ themes: await loadThemes() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/themes', requireAuth, requireAdminRole(['system_admin', 'superadmin']), async function(req, res) {
  try {
    const theme = req.body;
    if (!theme.id) return res.status(400).json({ error: 'theme.id required' });
    const themes = await loadThemes();
    if (themes.find(function(t) { return t.id === theme.id; })) {
      return res.status(409).json({ error: 'Theme id already exists' });
    }
    themes.push(theme);
    await saveThemes(themes);
    res.status(201).json({ theme: theme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/admin/themes/:id', requireAuth, requireAdminRole(['system_admin', 'superadmin']), async function(req, res) {
  try {
    const id = req.params.id;
    const themes = await loadThemes();
    const idx = themes.findIndex(function(t) { return t.id === id; });
    if (idx === -1) return res.status(404).json({ error: 'Theme not found' });
    themes[idx] = Object.assign({}, themes[idx], req.body, { id: id });
    await saveThemes(themes);
    res.json({ theme: themes[idx] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/themes/:id', requireAuth, requireAdminRole(['system_admin', 'superadmin']), async function(req, res) {
  try {
    const id = req.params.id;
    const themes = await loadThemes();
    const idx = themes.findIndex(function(t) { return t.id === id; });
    if (idx === -1) return res.status(404).json({ error: 'Theme not found' });
    themes.splice(idx, 1);
    await saveThemes(themes);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Asset upload: GCS under themes/<id>/<field>.(png|jpg)
app.post(
  '/admin/themes/:id/assets',
  requireAuth,
  requireAdminRole(['system_admin', 'superadmin']),
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('file'),
  async function(req, res) {
    try {
      const id = req.params.id;
      const field = req.body.field || 'bg';
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const ext = req.file.originalname.split('.').pop().toLowerCase();
      const filename = 'themes/' + id + '/' + field + '.' + ext;
      const fileRef = admin.storage().bucket(PHOTO_BUCKET).file(filename);
      await fileRef.save(req.file.buffer, { metadata: { contentType: req.file.mimetype } });
      await fileRef.makePublic();
      const url = 'https://storage.googleapis.com/' + PHOTO_BUCKET + '/' + filename;
      res.json({ url: url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);
```

- [ ] **Step 5.5: Run tests — expect PASS**

```bash
cd ~/claude/tapcard-product/backend
npx jest __tests__/themes.test.js --verbose
```

Expected: all tests PASS.

- [ ] **Step 5.6: Commit**

```bash
cd ~/claude/tapcard-product
git add backend/index.js backend/__tests__/themes.test.js
git commit -m "feat(backend): theme CRUD routes + asset upload"
```

---

## Task 6: Themes admin tab in dashboard HTML

**Files:**
- Modify: `backend/index.js` (admin HTML section, ~line 752–1418)

The admin dashboard is a large inline HTML template literal. This task inserts a Themes tab.

**Safety note:** All DOM manipulation in the tab JS uses `createElement`/`textContent`/`appendChild` for user-supplied data (theme names, IDs). Static structural HTML uses template literals only for layout — no user data interpolated into HTML strings.

- [ ] **Step 6.1: Add Themes tab button**

In the admin HTML, find the tab buttons bar (look for `Stats`, `Audit`, `Staff` buttons). Add after the last tab button:

```html
<button class="tab-btn" data-tab="themes" onclick="showTab('themes')">Themes</button>
```

- [ ] **Step 6.2: Add themes tab panel**

Find where tab panels are defined (divs with `id="tab-stats"` etc.). Add:

```html
<div id="tab-themes" class="tab-panel" style="display:none">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
    <h2 style="margin:0;font-size:18px">Themes</h2>
    <button onclick="openThemeModal(null)" style="background:#4CAF50;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer">+ Add Theme</button>
  </div>
  <div id="themes-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px"></div>

  <div id="theme-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;align-items:center;justify-content:center">
    <div style="background:#1e1e2e;border-radius:12px;padding:24px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto">
      <h3 id="modal-title" style="margin:0 0 16px">Add Theme</h3>
      <form id="theme-form">
        <input type="hidden" id="tf-original-id" />
        <label>ID (slug)<input id="tf-id" required placeholder="main" style="display:block;width:100%;margin:4px 0 12px;padding:8px;background:#2a2a3e;border:1px solid #444;color:#fff;border-radius:6px" /></label>
        <label>Display Name<input id="tf-name" required placeholder="ACME Corp" style="display:block;width:100%;margin:4px 0 12px;padding:8px;background:#2a2a3e;border:1px solid #444;color:#fff;border-radius:6px" /></label>
        <label>Landing Background<input id="tf-landingBg" type="color" value="#1a1a2e" style="display:block;margin:4px 0 12px;height:36px;width:80px;cursor:pointer" /></label>
        <label>Accent Color<input id="tf-accent" type="color" value="#4a90d9" style="display:block;margin:4px 0 12px;height:36px;width:80px;cursor:pointer" /></label>
        <label>Accent Dark<input id="tf-accentDark" type="color" value="#357abd" style="display:block;margin:4px 0 12px;height:36px;width:80px;cursor:pointer" /></label>
        <label>Swatch Color<input id="tf-swatchColor" type="color" value="#4a90d9" style="display:block;margin:4px 0 12px;height:36px;width:80px;cursor:pointer" /></label>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <input id="tf-corporateLayout" type="checkbox" /> Corporate layout (white card)
        </label>
        <details style="margin-bottom:12px">
          <summary style="cursor:pointer;color:#aaa">Subsidiary info (optional)</summary>
          <div style="padding:12px 0 0">
            <label>Company Name<input id="tf-sub-company" style="display:block;width:100%;margin:4px 0 12px;padding:8px;background:#2a2a3e;border:1px solid #444;color:#fff;border-radius:6px" /></label>
            <label>Address lines (one per line)<textarea id="tf-sub-address" rows="2" style="display:block;width:100%;margin:4px 0 12px;padding:8px;background:#2a2a3e;border:1px solid #444;color:#fff;border-radius:6px;resize:vertical"></textarea></label>
            <label>Website<input id="tf-sub-website" style="display:block;width:100%;margin:4px 0 12px;padding:8px;background:#2a2a3e;border:1px solid #444;color:#fff;border-radius:6px" /></label>
          </div>
        </details>
        <details id="asset-upload-details" style="margin-bottom:16px;display:none">
          <summary style="cursor:pointer;color:#aaa">Upload assets</summary>
          <div id="asset-upload-panel" style="padding:12px 0 0"></div>
        </details>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button type="button" onclick="closeThemeModal()" style="padding:8px 16px;background:#444;color:#fff;border:none;border-radius:6px;cursor:pointer">Cancel</button>
          <button type="submit" style="padding:8px 16px;background:#4CAF50;color:#fff;border:none;border-radius:6px;cursor:pointer">Save</button>
        </div>
      </form>
      <div id="delete-btn-wrap" style="margin-top:12px;display:none">
        <button id="delete-theme-btn" style="width:100%;padding:8px 16px;background:#e53935;color:#fff;border:none;border-radius:6px;cursor:pointer">Delete Theme</button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 6.3: Add Themes tab JavaScript**

In the `<script>` section of the admin HTML, add:

```javascript
var _themes = [];

async function loadThemesTab() {
  try {
    var data = await apiFetch('/admin/themes');
    _themes = data.themes || [];
    renderThemesGrid();
  } catch(e) { console.error('loadThemesTab', e); }
}

function renderThemesGrid() {
  var grid = document.getElementById('themes-grid');
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  _themes.forEach(function(t) {
    var card = document.createElement('div');
    card.style.cssText = 'background:#1e1e2e;border-radius:10px;padding:16px;cursor:pointer;border:2px solid transparent';
    card.addEventListener('click', function() { openThemeModal(t); });

    var swatch = document.createElement('div');
    swatch.style.cssText = 'width:40px;height:40px;border-radius:50%;margin-bottom:10px';
    swatch.style.background = t.swatchColor || t.accent || '#888';

    var nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-weight:600;margin-bottom:4px';
    nameEl.textContent = t.name;

    var idEl = document.createElement('div');
    idEl.style.cssText = 'font-size:12px;color:#888';
    idEl.textContent = t.id;

    card.appendChild(swatch);
    card.appendChild(nameEl);
    card.appendChild(idEl);
    grid.appendChild(card);
  });
}

function openThemeModal(theme) {
  var isEdit = !!theme;
  document.getElementById('modal-title').textContent = isEdit ? 'Edit Theme' : 'Add Theme';
  document.getElementById('tf-original-id').value = isEdit ? theme.id : '';
  document.getElementById('tf-id').value = isEdit ? theme.id : '';
  document.getElementById('tf-id').disabled = isEdit;
  document.getElementById('tf-name').value = isEdit ? (theme.name || '') : '';
  document.getElementById('tf-landingBg').value = isEdit ? (theme.landingBg || '#1a1a2e') : '#1a1a2e';
  document.getElementById('tf-accent').value = isEdit ? (theme.accent || '#4a90d9') : '#4a90d9';
  document.getElementById('tf-accentDark').value = isEdit ? (theme.accentDark || '#357abd') : '#357abd';
  document.getElementById('tf-swatchColor').value = isEdit ? (theme.swatchColor || '#4a90d9') : '#4a90d9';
  document.getElementById('tf-corporateLayout').checked = isEdit ? !!theme.corporateLayout : false;
  var sub = (isEdit && theme.subsidiary) || {};
  document.getElementById('tf-sub-company').value = sub.companyName || '';
  document.getElementById('tf-sub-address').value = (sub.addressLines || []).join('\n');
  document.getElementById('tf-sub-website').value = sub.website || '';

  document.getElementById('delete-btn-wrap').style.display = isEdit ? 'block' : 'none';
  document.getElementById('asset-upload-details').style.display = isEdit ? 'block' : 'none';
  if (isEdit) {
    document.getElementById('delete-theme-btn').onclick = function() { confirmDeleteTheme(theme.id); };
    renderAssetPanel(theme.id);
  }
  document.getElementById('theme-modal').style.display = 'flex';
}

function renderAssetPanel(themeId) {
  var panel = document.getElementById('asset-upload-panel');
  while (panel.firstChild) panel.removeChild(panel.firstChild);
  ['bg', 'card', 'logo'].forEach(function(field) {
    var label = document.createElement('label');
    label.style.cssText = 'display:block;margin-bottom:10px;font-size:13px';
    label.textContent = field + ' image';

    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.cssText = 'display:block;margin-top:4px';
    input.addEventListener('change', function() {
      if (input.files[0]) uploadAsset(themeId, field, input.files[0]);
    });

    label.appendChild(input);
    panel.appendChild(label);
  });
}

async function uploadAsset(themeId, field, file) {
  var fd = new FormData();
  fd.append('file', file);
  fd.append('field', field);
  try {
    var res = await fetch('/admin/themes/' + encodeURIComponent(themeId) + '/assets', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + _token },
      body: fd,
    });
    var data = await res.json();
    if (res.ok) showToast('Uploaded: ' + data.url);
    else showToast('Upload failed: ' + (data.error || res.status), true);
  } catch(e) { showToast('Upload error: ' + e.message, true); }
}

function closeThemeModal() {
  document.getElementById('theme-modal').style.display = 'none';
}

function confirmDeleteTheme(id) {
  if (!confirm('Delete theme "' + id + '"? Cannot be undone.')) return;
  apiFetch('/admin/themes/' + encodeURIComponent(id), { method: 'DELETE' })
    .then(function() { closeThemeModal(); loadThemesTab(); })
    .catch(function(e) { showToast('Delete failed: ' + e.message, true); });
}

document.getElementById('theme-form').addEventListener('submit', async function(e) {
  e.preventDefault();
  var originalId = document.getElementById('tf-original-id').value;
  var isEdit = !!originalId;
  var addressRaw = document.getElementById('tf-sub-address').value.trim();
  var addressLines = addressRaw ? addressRaw.split('\n').map(function(l) { return l.trim(); }).filter(Boolean) : [];
  var subCompany = document.getElementById('tf-sub-company').value.trim();

  var theme = {
    id: document.getElementById('tf-id').value.trim(),
    name: document.getElementById('tf-name').value.trim(),
    landingBg: document.getElementById('tf-landingBg').value,
    accent: document.getElementById('tf-accent').value,
    accentDark: document.getElementById('tf-accentDark').value,
    swatchColor: document.getElementById('tf-swatchColor').value,
    corporateLayout: document.getElementById('tf-corporateLayout').checked,
  };
  if (subCompany) {
    theme.subsidiary = { companyName: subCompany, addressLines: addressLines, website: document.getElementById('tf-sub-website').value.trim() };
  }

  try {
    if (isEdit) {
      await apiFetch('/admin/themes/' + encodeURIComponent(originalId), { method: 'PUT', body: JSON.stringify(theme) });
    } else {
      await apiFetch('/admin/themes', { method: 'POST', body: JSON.stringify(theme) });
    }
    closeThemeModal();
    loadThemesTab();
  } catch(e) { showToast('Save failed: ' + e.message, true); }
});

// Lazy-load themes when tab is first activated
(function() {
  var loaded = false;
  var orig = window.showTab;
  window.showTab = function(tab) {
    orig(tab);
    if (tab === 'themes' && !loaded) { loaded = true; loadThemesTab(); }
  };
})();
```

- [ ] **Step 6.4: Verify structural integrity**

```bash
node -e "
const src = require('fs').readFileSync('backend/index.js', 'utf8');
console.log('tab-themes panel:', src.includes('id=\"tab-themes\"'));
console.log('theme-form:', src.includes('id=\"theme-form\"'));
console.log('themes-grid:', src.includes('id=\"themes-grid\"'));
console.log('renderThemesGrid fn:', src.includes('function renderThemesGrid'));
console.log('textContent used for names:', src.includes('nameEl.textContent = t.name'));
" 2>&1
```

Expected: all `true`.

- [ ] **Step 6.5: Commit**

```bash
cd ~/claude/tapcard-product
git add backend/index.js
git commit -m "feat(backend): themes admin tab with CRUD UI and asset upload"
```

---

## Task 7: Fix vcard.html and create firebase.json.template

**Files:**
- Create: `frontend/public/vcard.html` (copy + modify)
- Create: `customer-template/firebase.json.template`

- [ ] **Step 7.1: Copy vcard.html from MPB source**

```bash
mkdir -p ~/claude/tapcard-product/frontend/public
cp ~/claude/project/tapcard/tapcard/public/vcard.html ~/claude/tapcard-product/frontend/public/vcard.html
```

- [ ] **Step 7.2: Fix hardcoded API URL**

In `frontend/public/vcard.html`, find:
```javascript
var API = 'https://tapcard-api-116309832828.asia-southeast1.run.app';
```

Replace with:
```javascript
var API = '';
```

- [ ] **Step 7.3: Replace hardcoded THEME_MAP with config-driven approach**

Find the entire `var THEME_MAP = { ... }` block and `applyTheme` function. Replace with:

```javascript
var _themeMap = {};

function applyTheme(themeId) {
  var td = _themeMap[themeId] || { bg: '#0A0A0A', bgImage: '', accent: '#888888', company: '' };
  document.body.style.background = td.bgImage
    ? td.bg + " url('" + td.bgImage + "') center center / cover no-repeat fixed"
    : td.bg;
  document.getElementById('theme-color-meta').setAttribute('content', td.accent);
  var s = document.createElement('style');
  s.textContent = '.avatar-initials{background:' + td.accent + '}button{background:' + td.accent + '}';
  document.head.appendChild(s);
  return td;
}
```

- [ ] **Step 7.4: Wrap contact fetch in loadContact() and call after config**

Find the block starting with:
```javascript
var email = new URLSearchParams(location.search).get('e');
```

Wrap everything from that line to the end of the IIFE in a `loadContact` function:

```javascript
function loadContact() {
  var email = new URLSearchParams(location.search).get('e');
  if (!email) {
    content.innerHTML = '<p class="err">No contact specified.</p>';
    return;
  }
  email = email.toLowerCase().trim();

  fetch(API + '/vcard/' + encodeURIComponent(email), { cache: 'no-store' })
    .then(function(r) {
      if (!r.ok) throw new Error(r.status === 404 ? 'Contact not found.' : 'Failed to load contact.');
      return r.json();
    })
    .then(function(p) {
      // ... rest of existing render logic unchanged ...
    })
    .catch(function(e) {
      content.innerHTML = '<p class="err">' + escapeHtml(e.message || 'Unable to load contact.') + '</p>';
    });
}

// Load config first, then contact
fetch('/api/config', { cache: 'no-store' })
  .then(function(r) { return r.json(); })
  .then(function(cfg) {
    (cfg.themes || []).forEach(function(t) {
      _themeMap[t.id] = {
        bg: t.landingBg || '#0A0A0A',
        bgImage: t.bgImage || '',
        accent: t.accent || '#888888',
        company: (t.subsidiary && t.subsidiary.companyName) || t.name || '',
      };
    });
  })
  .catch(function() {})
  .then(loadContact);
```

Remove the original direct contact fetch call (it's now inside `loadContact`).

- [ ] **Step 7.5: Create firebase.json.template**

```bash
mkdir -p ~/claude/tapcard-product/customer-template
```

Save the following to `customer-template/firebase.json.template`:

```json
{
  "hosting": {
    "public": "dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      { "source": "/api/**",      "run": { "serviceId": "tapcard-api", "region": "REGION" } },
      { "source": "/vcard/**",    "run": { "serviceId": "tapcard-api", "region": "REGION" } },
      { "source": "/profile/**",  "run": { "serviceId": "tapcard-api", "region": "REGION" } },
      { "source": "/auth/**",     "run": { "serviceId": "tapcard-api", "region": "REGION" } },
      { "source": "/admin/**",    "run": { "serviceId": "tapcard-api", "region": "REGION" } },
      { "source": "/proxy-image", "run": { "serviceId": "tapcard-api", "region": "REGION" } },
      { "source": "/health",      "run": { "serviceId": "tapcard-api", "region": "REGION" } },
      { "source": "**",           "destination": "/index.html" }
    ],
    "headers": [
      {
        "source": "**",
        "headers": [
          {
            "key": "Content-Security-Policy",
            "value": "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://storage.googleapis.com; connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com; frame-src https://accounts.google.com; font-src 'self' data:"
          },
          { "key": "X-Frame-Options", "value": "DENY" },
          { "key": "X-Content-Type-Options", "value": "nosniff" },
          { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
        ]
      }
    ]
  }
}
```

Note: `setup.sh` replaces `REGION` with the customer's GCP region during install.

- [ ] **Step 7.6: Commit**

```bash
cd ~/claude/tapcard-product
git add frontend/public/vcard.html customer-template/firebase.json.template
git commit -m "feat(frontend): fix vcard.html for generic deployment; add firebase.json.template"
```

---

## Task 8: Full verification

- [ ] **Step 8.1: Run full test suite**

```bash
cd ~/claude/tapcard-product/backend
npx jest --verbose --forceExit 2>&1 | tail -40
```

Expected: all tests PASS, 0 failures.

- [ ] **Step 8.2: Grep for remaining MPB hardcoding in backend**

```bash
grep -n "mp-git-rezwan\|mediaprima\.com\.my\|bizcard\.mediaprima\|116309832828\|tapcard-api-116309832828\|rezwan@" \
  ~/claude/tapcard-product/backend/index.js
```

Expected: no output.

- [ ] **Step 8.3: Grep vcard.html for hardcoded API URL**

```bash
grep -n "run\.app\|116309832828" ~/claude/tapcard-product/frontend/public/vcard.html
```

Expected: no output.

- [ ] **Step 8.4: Verify REQUIRED_ENV block and module.exports present**

```bash
grep -n "REQUIRED_ENV\|module\.exports" ~/claude/tapcard-product/backend/index.js | head -8
```

Expected: lines showing `validateEnv` require, and `module.exports = app`.

- [ ] **Step 8.5: Final commit**

```bash
cd ~/claude/tapcard-product
git add -A
git diff --cached --stat
git commit -m "feat: sub-project 1 complete — fully productized backend" --allow-empty
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| All MPB env vars replaced | Task 2 |
| Startup exit on missing vars | Task 2 + 3 |
| GET /api/config (public) | Task 4 |
| Themes from Firestore config/themes | Task 4 |
| config/app → appName | Task 4 |
| Theme CRUD (GET/POST/PUT/DELETE) | Task 5 |
| Asset upload to GCS themes/<id>/ | Task 5 |
| Themes admin tab | Task 6 |
| system_admin + superadmin access only | Task 5 |
| vcard.html API = '' (relative) | Task 7 |
| Dynamic THEME_MAP from /api/config | Task 7 |
| firebase.json.template with all rewrites | Task 7 |
| VALID_THEME_IDS removed | Task 2 |
| Admin HTML APP_NAME placeholder | Task 2 |

All requirements covered. `loadThemes()`/`saveThemes()` defined once in Task 5, referenced by routes. `requireAdminRole` defined before first use. `validateEnv` extracted to own file, tested independently without subprocess spawning.
