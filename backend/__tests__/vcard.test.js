const request = require('supertest');
const { makeFirestoreMock, makeStorageMock } = require('./helpers/mockFirebase');

const CSV = 'Email,Employee Name,Position Title,BusinessUnit,work_phone\nuser@acme.com,Jane Doe,Engineer,Tech,+601111111111\n';

const mockDb = makeFirestoreMock({
  'config/stafflist': { csv: CSV, updatedAt: Date.now() },
  'profiles/user@acme.com': { name: 'Jane Doe', title: 'Engineer', theme: 'main' },
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
          getPayload: function() { return { email: 'user@acme.com', hd: 'acme.com' }; },
        }),
      };
    }),
  };
});

const app = require('../index');
const { initStaffMap } = require('../index');

beforeAll(async function() { await initStaffMap(); });

describe('GET /vcard/:email', function() {
  test('200 returns public card for known staff', async function() {
    const res = await request(app).get('/vcard/user@acme.com');
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('user@acme.com');
    expect(res.body.name).toBe('Jane Doe');
    expect(res.body.theme).toBe('main');
  });

  test('404 for email not in staff map', async function() {
    const res = await request(app).get('/vcard/nobody@acme.com');
    expect(res.status).toBe(404);
  });

  test('400 for invalid email format', async function() {
    const res = await request(app).get('/vcard/notanemail');
    expect(res.status).toBe(400);
  });

  test('no auth required', async function() {
    const res = await request(app).get('/vcard/user@acme.com');
    expect(res.status).toBe(200);
  });
});

describe('GET /health', function() {
  test('200 returns ok without auth', async function() {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
