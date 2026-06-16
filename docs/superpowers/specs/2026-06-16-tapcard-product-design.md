# TapCard Product — Design Spec

**Date:** 2026-06-16  
**Status:** Approved  
**Scope:** Package TapCard as a sellable product deployable on any customer's GCP infrastructure

---

## Context

TapCard is a production digital business card system running for Media Prima Berhad (MPB) at `~/claude/project/tapcard`. That codebase stays frozen and untouched. This new repo (`~/claude/tapcard-product`) is a clean productized fork — the sellable product. MPB may optionally migrate to it later, or never.

---

## Deployment Model

- **Customer-hosted on their own GCP project** — customer owns infrastructure, data, and OAuth credentials
- **You own the product** — publish versioned Docker images + frontend dist bundles
- **Customer receives updates** — one-command update script, no code access required

---

## Repository Structure

```
tapcard-product/
├── backend/                        # Express API server
│   ├── index.js
│   ├── Dockerfile
│   └── package.json
├── frontend/                       # Expo React Native Web PWA
│   ├── App.js
│   ├── public/
│   │   ├── sw.js
│   │   └── vcard.html
│   └── app.config.js
├── installer/                      # Customer-facing scripts
│   ├── setup.sh                    # Guided onboarding wizard
│   ├── update.sh                   # Version update script
│   ├── terraform/                  # IaC modules
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── outputs.tf
│   │   └── modules/
│   │       ├── cloudrun/
│   │       ├── storage/
│   │       ├── firestore/
│   │       └── iam/
│   └── seed/
│       └── default-themes.json     # Starter theme seeded on first install
└── .github/
    └── workflows/
        └── release.yml             # Publishes Docker image + frontend dist on git tag
```

Source: copy from `tapcard-backend/` → `backend/` and `tapcard/` → `frontend/`, then productize.

---

## Sub-Project 1: Backend Productization

### Goal
Remove all MPB-specific hardcoding. Every deployment-specific value becomes an environment variable.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth 2.0 client secret |
| `OAUTH_CLIENT_ID` | Yes | Google OAuth client ID (replaces hardcoded WEB_CLIENT_ID) |
| `ALLOWED_DOMAINS` | Yes | Comma-separated email domains: `"acme.com,sub.acme.com"` |
| `SUPERADMIN_EMAIL` | Yes | Email of first superadmin user |
| `GCP_PROJECT_ID` | Yes | Firestore project ID |
| `PHOTO_BUCKET` | Yes | GCS bucket name for profile photos |
| `CORS_ORIGINS` | Yes | Comma-separated allowed origins: `"https://cards.acme.com"` |
| `APP_NAME` | No | Displayed in admin UI (default: "TapCard") |
| `PORT` | No | Default 8080 |
| `DEBUG` | No | Set `"true"` for verbose logs |

### New: `/api/config` Endpoint

**Public, no auth.** Called by frontend before rendering anything.

```json
{
  "oauthClientId": "123456-abc.apps.googleusercontent.com",
  "appName": "ACME Digital Cards",
  "themes": [
    {
      "id": "main",
      "name": "ACME Corp",
      "landingBg": "#003366",
      "accent": "#0055AA",
      "accentDark": "#003D7A",
      "swatchColor": "#0055AA",
      "corporateLayout": true,
      "subsidiary": {
        "companyName": "ACME Corporation Sdn Bhd",
        "addressLines": ["Level 10, ACME Tower", "Kuala Lumpur 50480"],
        "website": "acme.com"
      }
    }
  ]
}
```

Reads from Firestore: `config/themes` (themes array) and `config/app` (appName).

### New Firestore Collections

```
config/themes   → { themes: [...] }        # Array of Theme objects
config/app      → { name: string }         # App display name
```

Existing collections unchanged: `profiles/{email}`, `admins/{email}`, `config/stafflist`, `auditLog/{id}`.

### New Admin Dashboard: Themes Tab

Added as a new tab in the inline HTML admin dashboard.

**Features:**
- List all themes with swatch preview
- Add new theme (form covering all Theme fields)
- Edit existing theme
- Upload theme assets to GCS under `themes/<id>/` (bg.png, card.png, logo PNGs)
- Delete theme (with confirmation)
- "Preview card" — renders a sample card in the dashboard

**Access:** `system_admin` and `superadmin` only (same as stats tab).

### Changes to Existing Code

| Location | Change |
|----------|--------|
| `ALLOWED_DOMAINS` | Read from `process.env.ALLOWED_DOMAINS.split(',')` |
| `SUPERADMIN_EMAIL` | Read from `process.env.SUPERADMIN_EMAIL` |
| `admin.initializeApp(...)` | Use `process.env.GCP_PROJECT_ID` |
| `PHOTO_BUCKET` | Read from `process.env.PHOTO_BUCKET` |
| CORS origins array | Read from `process.env.CORS_ORIGINS.split(',')` |
| `WEB_CLIENT_ID` (hardcoded) | Read from `process.env.OAUTH_CLIENT_ID` |
| `vcard.html` hardcoded URL | Change `API` variable to `''` (relative) — Firebase rewrites handle it |
| Admin UI email placeholder | Use `APP_NAME` env var |

---

## Sub-Project 2: Frontend Theme System

### Goal
Remove `THEMES` array from `App.js`. Themes fetched at runtime from `/api/config`. Frontend build is 100% generic — same `dist/` works for every customer deployment.

### Config Fetch Flow

```
App mount
├── fetch('/api/config')
│   ├── success → set { themes, oauthClientId, appName } in state → render LoginScreen
│   └── failure → use fallback theme → render LoginScreen with error banner
└── (no PKCE check until LoginScreen renders)
```

Fallback theme (hardcoded minimal, only used if `/api/config` fails):
```javascript
const FALLBACK_THEME = {
  id: 'default', name: 'Default',
  landingBg: '#1a1a2e', accent: '#4a90d9', accentDark: '#357abd',
  swatchColor: '#4a90d9', corporateLayout: false,
};
```

### Changes to `App.js`

| Change | Detail |
|--------|--------|
| Remove `THEMES` constant | Replaced by state: `const [themes, setThemes] = useState([FALLBACK_THEME])` |
| Remove `WEB_CLIENT_ID` constant | Read from config fetch: `const [clientId, setClientId] = useState(null)` |
| Add `useEffect` on mount | Fetches `/api/config`, populates state |
| PKCE flow | Uses `clientId` from state instead of hardcoded constant; login button disabled until clientId loads |
| Theme picker | Unchanged — still renders from `themes` array (now from state) |

### `app.config.js` Simplified

```javascript
export default {
  expo: {
    extra: {
      BASE_URL: process.env.BASE_URL || '',  // empty = same origin via Firebase rewrites
    },
  },
};
```

`WEB_CLIENT_ID` removed — fetched at runtime from `/api/config`.

---

## Sub-Project 3: Installer Scripts

### `setup.sh` — Guided Onboarding Wizard

Single command for customer:
```bash
curl -fsSL https://install.tapcard.dev/setup.sh | bash
```

Wizard steps:
```
[1/8] Prerequisites check
      → Checks: gcloud, firebase CLI, terraform, curl, jq
      → Missing tools: offers to install or prints install instructions

[2/8] GCP authentication
      → gcloud auth login (opens browser)
      → gcloud auth application-default login

[3/8] OAuth credentials
      → Prints step-by-step: create OAuth 2.0 Web Client in GCP Console
      → Prompts: Enter Client ID / Client Secret

[4/8] Company configuration
      → Allowed email domains (comma-separated)
      → Superadmin email
      → App name
      → GCS bucket name (suggested: <project-id>-tapcard-photos)
      → Custom domain (optional; can be added later)

[5/8] Infrastructure provisioning
      → terraform init + terraform apply
      → Provisions: Cloud Run service, GCS bucket (public), Firestore, IAM bindings

[6/8] Backend deployment
      → docker pull tapcard/backend:<version>
      → gcloud run deploy with generated env vars

[7/8] Frontend deployment
      → Downloads dist-<version>.zip from GitHub Releases
      → Generates firebase.json from template (injects backend URL)
      → firebase deploy --only hosting

[8/8] Seed initial data
      → Writes config/themes from seed/default-themes.json to Firestore
      → Writes config/app (appName) to Firestore
      → Saves install state to ~/.tapcard/<project-id>.json

✓ Setup complete.
  Admin panel: https://<your-domain>/admin
  Sign in with: <superadmin-email>
  Next step: customize your themes in the admin dashboard.
```

State file `~/.tapcard/<project-id>.json`:
```json
{
  "projectId": "acme-tapcard",
  "region": "asia-southeast1",
  "bucket": "acme-tapcard-photos",
  "corsOrigins": "https://cards.acme.com",
  "version": "v1.0.0",
  "installedAt": "2026-06-16T10:00:00Z"
}
```

### `update.sh` — Version Update

```bash
curl -fsSL https://install.tapcard.dev/update.sh | bash
```

Flow:
```
→ Reads ~/.tapcard/<project-id>.json (prompts for project ID if multiple installs)
→ Checks latest version from GitHub Releases API
→ Shows: "v1.0.0 installed → v1.2.0 available. Update? [Y/n]"
→ Pulls tapcard/backend:v1.2.0
→ gcloud run deploy (zero-downtime revision swap)
→ Downloads dist-v1.2.0.zip → firebase deploy --only hosting
→ Runs migration scripts if any (bundled in dist zip as migrations/*.sh; executed in version order)
→ Updates ~/.tapcard/<project-id>.json version field
✓ Updated: v1.0.0 → v1.2.0
```

### Terraform Modules

```
terraform/
├── main.tf              # Calls modules, wires outputs
├── variables.tf         # project_id, region, bucket_name, etc.
├── outputs.tf           # backend_url, hosting_url
└── modules/
    ├── cloudrun/        # Cloud Run service + IAM invoker (allUsers public)
    ├── storage/         # GCS bucket, public ACL, CORS policy
    ├── firestore/       # Firestore database (native mode)
    └── iam/             # Service account for Cloud Run with Firestore + GCS roles
```

---

## Sub-Project 4: CI/CD Pipeline

### Release Trigger

Git tag matching `v*.*.*` on `main` branch triggers `release.yml`.

### GitHub Actions: `release.yml`

```yaml
on:
  push:
    tags: ['v*.*.*']

jobs:
  build-backend:
    # docker build backend/ → push to Docker Hub
    # tags: tapcard/backend:<version>, tapcard/backend:latest

  build-frontend:
    # cd frontend && npx expo export --platform web
    # zip dist/ → dist-<version>.zip
    # Upload as GitHub Release asset

  create-release:
    # gh release create <tag> with changelog + assets
    # Assets: dist-<version>.zip, setup.sh, update.sh
```

Docker Hub repo: `tapcard/backend` — requires a Docker Hub account named `tapcard` (or substitute your org name; update installer scripts to match).  
GitHub Releases: frontend dist + installer scripts (customers always get latest scripts via curl URL, which redirects to latest release asset).  
`install.tapcard.dev` — placeholder domain; a simple redirect/CDN pointing to the GitHub Release asset URLs.

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Generic frontend build | Fetching `oauthClientId` + themes at runtime means one `dist/` for all customers — no per-customer rebuild |
| Config in Firestore (not env vars) | Themes editable via admin dashboard without redeploy |
| State in `~/.tapcard/` | Update script needs project context; avoids re-asking config questions |
| Relative `BASE_URL` default | Firebase rewrites `/api/**` → Cloud Run, so frontend needs no backend URL |
| Separate repo, no MPB touch | Product evolves independently; MPB production unaffected |

---

## What Is NOT In Scope

- AWS support (GCP only for v1)
- Multi-tenant (one GCP project = one customer)
- White-labelling the installer scripts themselves
- Billing / licence enforcement
- Mobile app (PWA only)

---

## Implementation Order

1. **Backend productization** — env vars, `/api/config`, Firestore theme CRUD, Themes admin tab
2. **Frontend theme system** — remove THEMES array, fetch config on mount
3. **Installer scripts** — setup.sh, update.sh, Terraform modules
4. **CI/CD pipeline** — Docker Hub publishing, GitHub Releases

Each sub-project is independently testable. Backend and frontend changes (1+2) can be developed and tested against a local GCP project before the installer (3) is built.
