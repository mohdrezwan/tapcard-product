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
