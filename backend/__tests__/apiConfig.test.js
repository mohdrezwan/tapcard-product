const request = require('supertest');
const { makeFirestoreMock } = require('./helpers/mockFirebase');

const THEMES = [{ id: 'main', name: 'ACME Corp', landingBg: '#003366', accent: '#0055AA', accentDark: '#003D7A', swatchColor: '#0055AA', corporateLayout: true }];

const mockDb = makeFirestoreMock({
  'config/themes': { themes: THEMES },
  'config/app': { name: 'ACME Digital Cards' },
});

jest.mock('firebase-admin', function() {
  return {
    initializeApp: jest.fn(),
    firestore: jest.fn(function() { return mockDb; }),
    storage: jest.fn(function() { return { bucket: jest.fn(function() { return { exists: jest.fn().mockResolvedValue([true]), getFiles: jest.fn().mockResolvedValue([[]]) }; }) }; }),
    credential: { applicationDefault: jest.fn() },
  };
});

const app = require('../index');

describe('GET /api/config', function() {
  test('returns 200 with themes, oauthClientId, appName', async function() {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.oauthClientId).toBe('test-client-id.apps.googleusercontent.com');
    expect(res.body.appName).toBe('ACME Digital Cards');
    expect(Array.isArray(res.body.themes)).toBe(true);
    expect(res.body.themes[0].id).toBe('main');
  });

  test('returns empty themes array when Firestore has no themes doc', async function() {
    const saved = mockDb._docs['config/themes'];
    delete mockDb._docs['config/themes'];
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.themes)).toBe(true);
    mockDb._docs['config/themes'] = saved;
  });

  test('no auth required — no 401 or 403', async function() {
    const res = await request(app).get('/api/config');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
