const request = require('supertest');
const { makeFirestoreMock, makeStorageMock } = require('./helpers/mockFirebase');

const INITIAL_THEMES = [
  { id: 'main', name: 'ACME Corp', landingBg: '#003366', accent: '#0055AA', accentDark: '#003D7A', swatchColor: '#0055AA', corporateLayout: true },
];

const mockDb = makeFirestoreMock({
  'config/themes': { themes: INITIAL_THEMES.slice() },
  'admins/admin@acme.com': { role: 'system_admin', email: 'admin@acme.com' },
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
