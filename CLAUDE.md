# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

TapCard is a productized digital business card platform designed for deployment to any customer. The backend is a generic, env-var-driven Express API (Cloud Run) paired with a Firebase-hosted frontend. All customer-specific configuration comes from environment variables and Firestore — no hardcoded constants.

**Target stack:** Node.js 20, Express, Firebase Admin SDK (Firestore + GCS), Google OAuth2 (PKCE flow), Cloud Run, Firebase Hosting.

## Commands

```bash
# Backend (from backend/)
npm start              # Start server on port 8080
npm test               # Run all Jest tests (--runInBand --forceExit)
npm run test:watch     # Watch mode

# Run a single test file
npx jest __tests__/validateEnv.test.js --verbose
```

## Architecture

### Single-file backend (`backend/index.js`)

Everything lives in one Express file. Key layers top-to-bottom:

1. **Env validation** — `validateEnv.js` checks 7 required vars at startup; process exits on failure.
2. **Firebase init** — `admin.initializeApp({ projectId: GCP_PROJECT_ID })`. Firestore + GCS bucket bound to constants.
3. **Staff map** — CSV loaded from Firestore `config/stafflist` at startup (falls back to local `stafflist.csv`). In-memory `staffMap` is the authoritative staff lookup for all requests.
4. **Auth middleware** — `requireAuth` verifies Google ID token via `google-auth-library`, enforces `ALLOWED_DOMAINS`. `requireAdmin` additionally checks Firestore `admins` collection. `requireRole(...roles)` enforces RBAC on top of admin check.
5. **Routes** — all in `index.js`, no router files.
6. **Admin dashboard** — entire HTML/CSS/JS served as a template literal from `GET /admin`. PKCE OAuth flow, role-based tab visibility.

### Role hierarchy
`superadmin` (env `SUPERADMIN_EMAIL`) > `system_admin` > `data_admin`. Superadmin is not stored in Firestore — checked by email string comparison.

### Firestore schema
| Collection/Doc | Contents |
|---|---|
| `profiles/{email}` | User profile (name, title, dept, phone, photo URL, theme) |
| `config/stafflist` | `{ csv: string, updatedAt: number }` |
| `config/themes` | `{ themes: ThemeObject[] }` |
| `config/app` | `{ name: string }` — overrides `APP_NAME` env var |
| `admins/{email}` | `{ role, addedBy, addedAt }` |
| `auditLog/{auto}` | Audit entries with 90-day TTL |

### Theme system
Themes are stored in `config/themes` and served publicly via `GET /api/config`. The vcard landing page fetches `/api/config` first, then builds its theme map dynamically — no hardcoded theme IDs in the frontend.

Theme CRUD lives at `/admin/themes` (system_admin+). Asset uploads go to GCS under `themes/<id>/<field>.<ext>`.

### Key design decisions
- `app` is exported (`module.exports = app`) and only listens when `require.main === module` — enables test `require()` without starting the server.
- Photo proxy at `/vcard/:email/photo` exists because Chrome rejects GCS URLs containing `@` in the path; the proxy rewrites `@` → `%40` or streams directly.
- Rate limiters are per-endpoint with `trust proxy: 1` for Cloud Run's load balancer.

## Testing

Tests use Jest + supertest. Firebase is mocked via `__tests__/helpers/mockFirebase.js` — `makeFirestoreMock(docData)` and `makeStorageMock()`. Each test file sets up its own `jest.mock('firebase-admin', ...)` before requiring the app.

`jest.setup.js` sets all required env vars so `validateEnv` passes on import.

Tests run `--runInBand` because the app module is cached by Node and mutations to mock state are shared across tests in the same file.

## Required environment variables

| Var | Purpose |
|---|---|
| `GOOGLE_CLIENT_SECRET` | OAuth2 Web Client secret (PKCE exchange) |
| `OAUTH_CLIENT_ID` | Google OAuth client ID |
| `ALLOWED_DOMAINS` | Comma-separated allowed email domains |
| `SUPERADMIN_EMAIL` | Hardcoded superadmin email |
| `GCP_PROJECT_ID` | GCP project for Firebase init |
| `PHOTO_BUCKET` | GCS bucket name for profile photos |
| `CORS_ORIGINS` | Comma-separated allowed CORS origins |

Optional: `APP_NAME` (default: `TapCard`), `PORT` (default: `8080`), `DEBUG` (`true`/`false`), `ADMIN_KEY`.

## Deployment

```dockerfile
# backend/Dockerfile — node:20-alpine, npm ci --omit=dev
```

`customer-template/firebase.json.template` has all Firebase Hosting rewrites. The `REGION` placeholder is replaced by a setup script during customer deployment.
