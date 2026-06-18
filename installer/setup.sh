#!/usr/bin/env bash
# TapCard — Guided Setup Wizard
# Usage: curl -fsSL https://raw.githubusercontent.com/mohdrezwan/tapcard-product/master/installer/setup.sh | bash
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

step()   { echo -e "\n${BOLD}${BLUE}[$1/10]${RESET} ${BOLD}$2${RESET}"; }
ok()     { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()   { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
fail()   { echo -e "  ${RED}✗${RESET} $1" >&2; exit 1; }
prompt() { echo -en "  ${BOLD}→${RESET} $1: "; }

open_browser() {
  local url="$1"
  if command -v open &>/dev/null; then open "$url"
  elif command -v xdg-open &>/dev/null; then xdg-open "$url"
  else echo "  Open manually: $url"; fi
}

INSTALLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAPCARD_DIR="$HOME/.tapcard"
mkdir -p "$TAPCARD_DIR"

# ─── [1/10] Prerequisites ─────────────────────────────────────────────────────
step 1 "Prerequisites check"

MISSING=()
for cmd in gcloud firebase terraform curl jq python3; do
  if command -v "$cmd" &>/dev/null; then
    ok "$cmd"
  else
    MISSING+=("$cmd")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo ""
  echo -e "  ${RED}Missing: ${MISSING[*]}${RESET}"
  echo "  Install instructions:"
  for t in "${MISSING[@]}"; do
    case "$t" in
      gcloud)    echo "    gcloud:    https://cloud.google.com/sdk/docs/install" ;;
      firebase)  echo "    firebase:  npm install -g firebase-tools" ;;
      terraform) echo "    terraform: https://developer.hashicorp.com/terraform/install" ;;
      curl)      echo "    curl:      brew install curl  (macOS) / apt install curl (Linux)" ;;
      jq)        echo "    jq:        brew install jq   (macOS) / apt install jq   (Linux)" ;;
      python3)   echo "    python3:   https://www.python.org/downloads/" ;;
    esac
  done
  echo ""
  read -rp "  Continue anyway? [y/N] " CONT
  [[ "$CONT" =~ ^[Yy]$ ]] || exit 1
fi

# ─── [2/10] GCP authentication ────────────────────────────────────────────────
step 2 "GCP authentication"

echo "  Opening browser for gcloud login..."
gcloud auth login --brief 2>/dev/null || gcloud auth login

echo "  Setting application-default credentials..."
gcloud auth application-default login --brief 2>/dev/null || \
  gcloud auth application-default login

echo ""
prompt "GCP project ID"
read -r PROJECT_ID
gcloud config set project "$PROJECT_ID" --quiet
ok "Project: $PROJECT_ID"

prompt "Region (default: asia-southeast1)"
read -r REGION
REGION="${REGION:-asia-southeast1}"
ok "Region: $REGION"

# ─── [3/10] Enable GCP APIs ───────────────────────────────────────────────────
step 3 "Enabling required GCP APIs"

echo "  This may take 1-2 minutes..."
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  firebase.googleapis.com \
  iam.googleapis.com \
  cloudresourcemanager.googleapis.com \
  iamcredentials.googleapis.com \
  --project "$PROJECT_ID" --quiet

ok "APIs enabled"

# ─── [4/10] Firebase project setup ────────────────────────────────────────────
step 4 "Firebase project setup"

echo "  Adding Firebase to GCP project ${PROJECT_ID}..."
if firebase projects:list 2>/dev/null | grep -q "$PROJECT_ID"; then
  ok "Firebase already initialized for ${PROJECT_ID}"
else
  firebase projects:addfirebase "$PROJECT_ID" --project "$PROJECT_ID" 2>/dev/null && \
    ok "Firebase added to ${PROJECT_ID}" || \
    warn "Firebase init may need manual setup at console.firebase.google.com"
fi

echo "  Enabling Firebase Hosting..."
firebase use "$PROJECT_ID" --add 2>/dev/null || firebase use "$PROJECT_ID" 2>/dev/null || true
ok "Firebase Hosting ready"

# ─── [5/10] OAuth credentials ─────────────────────────────────────────────────
step 5 "OAuth credentials"

echo ""
echo "  Opening Google Cloud Console to create OAuth credentials..."
echo ""
echo "  Follow these steps in the browser:"
echo "  1. Click 'Create Credentials' → 'OAuth Client ID'"
echo "  2. Application type: Web application"
echo "  3. Name: TapCard"
echo "  4. Authorised JavaScript origins:"
echo "       https://${PROJECT_ID}.web.app"
echo "       https://${PROJECT_ID}.firebaseapp.com"
echo "  5. Authorised redirect URIs: same as above"
echo "  6. Click Create — copy the Client ID and Client Secret"
echo ""
read -rp "  Press Enter to open browser..." _
open_browser "https://console.cloud.google.com/apis/credentials/oauthclient?project=${PROJECT_ID}"
echo ""

prompt "OAuth Client ID"
read -r OAUTH_CLIENT_ID

prompt "OAuth Client Secret"
read -rsp "" OAUTH_CLIENT_SECRET
echo ""
ok "OAuth credentials saved"

# ─── [6/10] Company configuration ────────────────────────────────────────────
step 6 "Company configuration"

prompt "Allowed email domains (comma-separated, e.g. acme.com,sub.acme.com)"
read -r ALLOWED_DOMAINS

prompt "Superadmin email"
read -r SUPERADMIN_EMAIL

prompt "App name (shown in admin UI, default: TapCard)"
read -r APP_NAME
APP_NAME="${APP_NAME:-TapCard}"

SUGGESTED_BUCKET="${PROJECT_ID}-tapcard-photos"
prompt "GCS photo bucket name (default: ${SUGGESTED_BUCKET})"
read -r PHOTO_BUCKET
PHOTO_BUCKET="${PHOTO_BUCKET:-$SUGGESTED_BUCKET}"

prompt "Custom domain (e.g. cards.acme.com, leave blank to skip)"
read -r CUSTOM_DOMAIN

CORS_ORIGINS="https://${PROJECT_ID}.web.app,https://${PROJECT_ID}.firebaseapp.com"
if [ -n "$CUSTOM_DOMAIN" ]; then
  CORS_ORIGINS="https://${CUSTOM_DOMAIN},${CORS_ORIGINS}"
fi

ok "Configuration saved"

# ─── [7/10] Infrastructure provisioning ──────────────────────────────────────
step 7 "Infrastructure provisioning"

cd "$INSTALLER_DIR/terraform"
terraform init -input=false -upgrade -reconfigure 2>/dev/null || terraform init -input=false -upgrade

terraform apply -input=false -auto-approve \
  -var="project_id=${PROJECT_ID}" \
  -var="region=${REGION}" \
  -var="bucket_name=${PHOTO_BUCKET}" \
  -var="service_account_id=tapcard-api-sa"

ok "Cloud Run, GCS bucket, Firestore, IAM provisioned"
cd "$INSTALLER_DIR"

# ─── [8/10] Backend deployment ────────────────────────────────────────────────
step 8 "Backend deployment"

TAPCARD_VERSION="${TAPCARD_VERSION:-latest}"
echo "  Deploying mohdrezwan/tapcard-backend:${TAPCARD_VERSION}..."

gcloud run deploy tapcard-api \
  --image "mohdrezwan/tapcard-backend:${TAPCARD_VERSION}" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --service-account "tapcard-api-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  --set-env-vars "\
GOOGLE_CLIENT_SECRET=${OAUTH_CLIENT_SECRET},\
OAUTH_CLIENT_ID=${OAUTH_CLIENT_ID},\
ALLOWED_DOMAINS=${ALLOWED_DOMAINS},\
SUPERADMIN_EMAIL=${SUPERADMIN_EMAIL},\
GCP_PROJECT_ID=${PROJECT_ID},\
PHOTO_BUCKET=${PHOTO_BUCKET},\
CORS_ORIGINS=${CORS_ORIGINS},\
APP_NAME=${APP_NAME}" \
  --quiet

BACKEND_URL=$(gcloud run services describe tapcard-api --region "$REGION" \
  --format 'value(status.url)' --project "$PROJECT_ID")
ok "Backend: $BACKEND_URL"

# ─── [9/10] Frontend deployment ───────────────────────────────────────────────
step 9 "Frontend deployment"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

if [ "$TAPCARD_VERSION" = "latest" ]; then
  TAPCARD_VERSION=$(curl -fsSL \
    "https://api.github.com/repos/mohdrezwan/tapcard-product/releases/latest" \
    | jq -r .tag_name)
fi

DIST_ZIP="dist-${TAPCARD_VERSION}.zip"
DIST_URL="https://github.com/mohdrezwan/tapcard-product/releases/download/${TAPCARD_VERSION}/${DIST_ZIP}"

echo "  Downloading dist-${TAPCARD_VERSION}.zip..."
curl -fsSL -o "${WORK_DIR}/${DIST_ZIP}" "$DIST_URL"
unzip -q "${WORK_DIR}/${DIST_ZIP}" -d "$WORK_DIR/dist"

sed "s|REGION|${REGION}|g" \
  "${INSTALLER_DIR}/../customer-template/firebase.json.template" \
  > "${WORK_DIR}/firebase.json"

(cd "$WORK_DIR" && firebase deploy --only hosting \
  --project "$PROJECT_ID" --public dist/frontend/dist)

HOSTING_URL="https://${PROJECT_ID}.web.app"
[ -n "$CUSTOM_DOMAIN" ] && HOSTING_URL="https://${CUSTOM_DOMAIN}"
ok "Frontend: $HOSTING_URL"

# ─── [10/10] Seed initial data ────────────────────────────────────────────────
step 10 "Seed initial data"

FS_BASE="https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents"
SEED_FILE="${INSTALLER_DIR}/seed/default-themes.json"

python3 - <<SEED
import json, urllib.request, urllib.error, subprocess

token = subprocess.check_output(['gcloud', 'auth', 'print-access-token']).decode().strip()
base = '${FS_BASE}'

def to_fs(val):
    if isinstance(val, bool):          return {'booleanValue': val}
    if isinstance(val, (int, float)):  return {'doubleValue': float(val)}
    if isinstance(val, str):           return {'stringValue': val}
    if val is None:                    return {'nullValue': None}
    if isinstance(val, list):          return {'arrayValue': {'values': [to_fs(v) for v in val]}}
    if isinstance(val, dict):          return {'mapValue': {'fields': {k: to_fs(v) for k, v in val.items()}}}

def patch(path, doc):
    data = json.dumps(doc).encode()
    req = urllib.request.Request(f'{base}/{path}', data=data, method='PATCH')
    req.add_header('Authorization', f'Bearer {token}')
    req.add_header('Content-Type', 'application/json')
    urllib.request.urlopen(req)

with open('${SEED_FILE}') as f:
    themes = json.load(f)

patch('config/themes', {'fields': {'themes': to_fs(themes)}})
print('  config/themes seeded')

patch('config/app', {'fields': {'name': {'stringValue': '${APP_NAME}'}}})
print('  config/app seeded')
SEED

ok "Firestore seeded"

# ─── Save install state ────────────────────────────────────────────────────────
STATE_FILE="${TAPCARD_DIR}/${PROJECT_ID}.json"
cat > "$STATE_FILE" <<JSON
{
  "projectId": "${PROJECT_ID}",
  "region": "${REGION}",
  "bucket": "${PHOTO_BUCKET}",
  "corsOrigins": "${CORS_ORIGINS}",
  "version": "${TAPCARD_VERSION}",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
ok "State saved: $STATE_FILE"

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✓ TapCard setup complete!${RESET}"
echo ""
echo -e "  Admin panel:  ${BOLD}${HOSTING_URL}/admin${RESET}"
echo -e "  Sign in with: ${BOLD}${SUPERADMIN_EMAIL}${RESET}"
echo ""
echo "  Next steps:"
echo "  1. Sign in as superadmin and upload your staff CSV"
echo "  2. Customise themes in the admin dashboard"
if [ -n "$CUSTOM_DOMAIN" ]; then
  echo "  3. Point ${CUSTOM_DOMAIN} DNS to Firebase Hosting:"
  echo "     Firebase Console → Hosting → Add custom domain"
fi
echo ""
