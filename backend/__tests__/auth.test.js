const request = require('supertest');
const { makeFirestoreMock, makeStorageMock } = require('./helpers/mockFirebase');

const CSV = 'Email,Employee Name,Position Title,BusinessUnit,work_phone\nuser@acme.com,Jane Doe,Engineer,Tech,+601111111111\n';

const mockDb = makeFirestoreMock({
  'config/stafflist': { csv: CSV, updatedAt: Date.now() },
});

const mockStorage = makeStorageMock();

let mockEmail = 'user@acme.com';

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
        verifyIdToken: jest.fn().mockImplementation(function() {
          return Promise.resolve({
            getPayload: function() { return { email: mockEmail, hd: mockEmail.split('@')[1], name: 'Jane Doe', picture: null }; },
          });
        }),
      };
    }),
  };
});

const app = require('../index');

describe('POST /auth/google', function() {
  test('400 if idToken missing', async function() {
    const res = await request(app).post('/auth/google').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing idToken/);
  });

  test('200 with user data for valid domain', async function() {
    mockEmail = 'user@acme.com';
    const res = await request(app).post('/auth/google').send({ idToken: 'mock-token' });
    expect(res.status).toBe(200);
    expect(res.body.Email).toBe('user@acme.com');
    expect(res.body['Employee Name']).toBe('Jane Doe');
  });

  test('403 if domain not in allowlist', async function() {
    mockEmail = 'outsider@other.com';
    const res = await request(app).post('/auth/google').send({ idToken: 'mock-token' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not authorised/);
  });
});

describe('POST /auth/exchange', function() {
  test('400 if fields missing', async function() {
    const res = await request(app).post('/auth/exchange').send({ code: 'x' });
    expect(res.status).toBe(400);
  });
});
