// Validates that all required environment variables are present.
// Returns array of missing variable names. Empty array = all present.

var REQUIRED_ENV = [
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
