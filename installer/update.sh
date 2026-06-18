#!/usr/bin/env bash
# TapCard — Version Update Script
# Usage: curl -fsSL https://install.tapcard.dev/update.sh | bash
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1" >&2; exit 1; }

INSTALLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAPCARD_DIR="$HOME/.tapcard"

# ─── Locate install state ─────────────────────────────────────────────────────
shopt -s nullglob
STATE_FILES=("$TAPCARD_DIR"/*.json)
shopt -u nullglob

if [ ${#STATE_FILES[@]} -eq 0 ]; then
  fail "No TapCard install found. Run setup.sh first."
fi

if [ ${#STATE_FILES[@]} -gt 1 ]; then
  echo "Multiple installs found:"
  for f in "${STATE_FILES[@]}"; do echo "  $(basename "$f" .json)"; done
  echo -en "  Enter project ID: "
  read -r PROJECT_ID
  STATE_FILE="$TAPCARD_DIR/${PROJECT_ID}.json"
  [ -f "$STATE_FILE" ] || fail "State file not found: $STATE_FILE"
else
  STATE_FILE="${STATE_FILES[0]}"
  PROJECT_ID=$(jq -r .projectId "$STATE_FILE")
fi

REGION=$(jq -r .region "$STATE_FILE")
INSTALLED_VERSION=$(jq -r .version "$STATE_FILE")

echo -e "\n${BOLD}TapCard Update${RESET}"
echo -e "  Project:   $PROJECT_ID"
echo -e "  Installed: $INSTALLED_VERSION"
echo ""

# ─── Check latest version ─────────────────────────────────────────────────────
LATEST=$(curl -fsSL \
  "https://api.github.com/repos/tapcard-dev/tapcard-product/releases/latest" \
  | jq -r .tag_name 2>/dev/null || echo "")

if [ -z "$LATEST" ]; then
  warn "Could not fetch latest version from GitHub."
  echo -en "  Target version (e.g. v1.2.0): "
  read -r LATEST
fi

if [ "$INSTALLED_VERSION" = "$LATEST" ]; then
  echo -e "  ${GREEN}Already on latest ($LATEST). Nothing to do.${RESET}"
  exit 0
fi

echo -e "  ${YELLOW}${INSTALLED_VERSION}${RESET} → ${GREEN}${LATEST}${RESET} available."
echo -en "  Update? [Y/n] "
read -r CONFIRM
[[ "$CONFIRM" =~ ^[Nn]$ ]] && exit 0

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# ─── Update backend ───────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Updating backend...${RESET}"

gcloud run deploy tapcard-api \
  --image "tapcard/backend:${LATEST}" \
  --region "$REGION" \
  --platform managed \
  --project "$PROJECT_ID" \
  --quiet

ok "Backend → $LATEST"

# ─── Update frontend ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Updating frontend...${RESET}"

DIST_ZIP="dist-${LATEST}.zip"
curl -fsSL -o "${WORK_DIR}/${DIST_ZIP}" \
  "https://github.com/tapcard-dev/tapcard-product/releases/download/${LATEST}/${DIST_ZIP}"
unzip -q "${WORK_DIR}/${DIST_ZIP}" -d "$WORK_DIR/dist"

sed "s|REGION|${REGION}|g" \
  "${INSTALLER_DIR}/../customer-template/firebase.json.template" \
  > "${WORK_DIR}/firebase.json"

(cd "$WORK_DIR" && firebase deploy --only hosting \
  --project "$PROJECT_ID" --public dist)

ok "Frontend → $LATEST"

# ─── Run migration scripts (if bundled in dist) ───────────────────────────────
MIGRATIONS_DIR="${WORK_DIR}/dist/migrations"
if [ -d "$MIGRATIONS_DIR" ]; then
  echo ""
  echo -e "${BOLD}Running migrations...${RESET}"
  for script in $(ls "$MIGRATIONS_DIR"/*.sh 2>/dev/null | sort); do
    SCRIPT_VER=$(basename "$script" .sh | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
    # Run only migrations newer than installed version
    if [ -n "$SCRIPT_VER" ] && \
       python3 -c "import sys; a,b='${INSTALLED_VERSION}'.lstrip('v'),'${SCRIPT_VER}'.lstrip('v'); sys.exit(0 if tuple(map(int,a.split('.'))) < tuple(map(int,b.split('.'))) else 1)" 2>/dev/null; then
      echo "  Running $(basename "$script")..."
      bash "$script" "$PROJECT_ID" "$REGION"
      ok "$(basename "$script")"
    fi
  done
fi

# ─── Update state file ────────────────────────────────────────────────────────
jq --arg v "$LATEST" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.version = $v | .updatedAt = $t' "$STATE_FILE" \
  > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"

echo ""
echo -e "${GREEN}${BOLD}✓ Updated: ${INSTALLED_VERSION} → ${LATEST}${RESET}"
echo ""
