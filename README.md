# TapCard

Self-hosted digital business card platform. Deploy to your own GCP project in minutes — no SaaS fees, no vendor lock-in.

Each staff member gets a branded vCard page with QR code, shareable link, and downloadable contact. Admins manage staff, themes, and roles through a built-in dashboard.

---

## Features

- **vCard pages** — dynamic themes, QR code, photo, contact download
- **Google SSO** — PKCE OAuth, domain-restricted (your company only)
- **Admin dashboard** — staff CSV upload, theme CRUD, role management, audit log
- **Theme engine** — unlimited themes stored in Firestore, fully customizable via UI
- **Role hierarchy** — `superadmin` → `system_admin` → `data_admin`
- **One-command install** — guided 8-step wizard provisions all GCP infrastructure
- **One-command update** — pulls latest Docker image + frontend dist automatically
- **Self-contained** — Cloud Run (backend) + Firebase Hosting (frontend), no external services

---

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/mohdrezwan/tapcard-product/master/installer/setup.sh | bash
```

**Prerequisites:** `gcloud`, `firebase-tools`, `terraform`, `curl`, `jq`, `python3`

The wizard will:
1. Check prerequisites
2. Authenticate with GCP
3. Collect your OAuth credentials and configuration
4. Provision infrastructure via Terraform (Cloud Run, Firestore, GCS, IAM)
5. Deploy the backend Docker image
6. Deploy the frontend PWA to Firebase Hosting
7. Seed default themes and app config

Total time: ~10 minutes.

---

## Update

```bash
curl -fsSL https://raw.githubusercontent.com/mohdrezwan/tapcard-product/master/installer/update.sh | bash
```

Reads your saved install state, checks for a newer GitHub release, updates backend (Cloud Run) and frontend (Firebase Hosting) in one step.

---

## Architecture

```
Firebase Hosting (PWA)  ──→  Cloud Run (Express API)
                                    │
                              Firestore (profiles, themes, config)
                              GCS (profile photos, theme assets)
                              Google OAuth2 (staff auth)
```

| Component | Technology |
|-----------|-----------|
| Backend | Node.js 20, Express |
| Frontend | Expo (React Native Web) PWA |
| Auth | Google OAuth2 PKCE |
| Database | Firestore |
| Storage | Google Cloud Storage |
| Infra | Terraform + Cloud Run + Firebase Hosting |
| CI/CD | GitHub Actions → Docker Hub |

---

## Configuration

All customer-specific config is supplied via environment variables — no code changes required.

| Variable | Required | Description |
|----------|----------|-------------|
| `OAUTH_CLIENT_ID` | ✓ | Google OAuth 2.0 Web Client ID |
| `GOOGLE_CLIENT_SECRET` | ✓ | OAuth client secret |
| `ALLOWED_DOMAINS` | ✓ | Comma-separated allowed email domains |
| `SUPERADMIN_EMAIL` | ✓ | Superadmin email (not stored in Firestore) |
| `GCP_PROJECT_ID` | ✓ | GCP project ID |
| `PHOTO_BUCKET` | ✓ | GCS bucket name for profile photos |
| `CORS_ORIGINS` | ✓ | Comma-separated allowed CORS origins |
| `APP_NAME` | — | App display name (default: `TapCard`) |
| `PORT` | — | Server port (default: `8080`) |

See `backend/.env.example` for a template.

---

## Local Development

```bash
cd backend
npm install
cp .env.example .env   # fill in your values
npm start              # http://localhost:8080

npm test               # run all tests
```

---

## Deploying a New Version

Tag a release — CI builds the Docker image and zips the frontend dist automatically:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

GitHub Actions will:
- Build and push `mohdrezwan/tapcard-backend:<version>` to Docker Hub
- Export the Expo web build and attach `dist-<version>.zip` to the GitHub release
- Attach `setup.sh` and `update.sh` as release assets

---

## License

MIT
