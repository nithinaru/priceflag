#!/usr/bin/env bash
#
# Build a production-environment deployment without assigning any production
# domain. This is the artifact that can be verified and later promoted exactly.
# The script never runs `vercel promote` and never aliases a domain.

set -euo pipefail

PROJECT_ID="prj_RU8NlBDoR7t89BNqn5BagOpmpnmm"
TEAM_SCOPE="team_AqaBD6YaOf9DIJ7NzbytTZTW"

cd "$(dirname "$0")/.."

ENV_FILE=".env.production.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found. Copy .env.example and fill it with production values." >&2
  exit 1
fi

EXPLICIT_STAGE_CONFIRM="${PRICEFLAG_STAGE_CONFIRM:-}"
set -a
# shellcheck disable=SC1091
source "./$ENV_FILE"
set +a
if [[ -n "$EXPLICIT_STAGE_CONFIRM" ]]; then
  PRICEFLAG_STAGE_CONFIRM="$EXPLICIT_STAGE_CONFIRM"
fi

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "error: VERCEL_TOKEN is not set in $ENV_FILE." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: refusing to stage a production artifact from a dirty worktree." >&2
  exit 1
fi

REQUIRED_VARS=(
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_PUBLISHABLE_KEY
  SHOPIFY_API_KEY
  SHOPIFY_API_SECRET
  SHOPIFY_APP_HANDLE
  SHOPIFY_API_VERSION
  SHOPIFY_SCOPES
  APP_URL
  ENCRYPTION_KEY
  CRON_SECRET
  APP_ACCESS_SECRET
  AUTH_SESSION_SECRET
  ML_INGEST_SECRET
  RESEND_API_KEY
  RESEND_FROM
  PRICEFLAG_SHOP_ALLOWLIST
)

# Accept the pre-rename Supabase key name if the publishable key is unset.
if [[ -z "${SUPABASE_PUBLISHABLE_KEY:-}" && -n "${SUPABASE_ANON_KEY:-}" ]]; then
  SUPABASE_PUBLISHABLE_KEY="$SUPABASE_ANON_KEY"
fi

for name in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "error: required variable $name is empty in $ENV_FILE." >&2
    exit 1
  fi
done

case "$APP_URL" in
  https://dashboard.priceflag.org)
    ;;
  *)
    echo "error: production APP_URL must be https://dashboard.priceflag.org." >&2
    echo "       Never use a vercel.app hostname — priceflag-app.vercel.app is the project host, not the merchant-facing origin." >&2
    echo "       product.priceflag.org and signin.priceflag.org 308 onto the dashboard; they are not APP_URL." >&2
    exit 1
    ;;
esac
if [[ -n "${SHOPIFY_ADMIN_ACCESS_TOKEN:-}" || -n "${SHOPIFY_SHOP_DOMAIN:-}" ]]; then
  echo "error: production must use Partner OAuth, not static Shopify credentials." >&2
  exit 1
fi

if [[ -z "${SIGNIN_URL:-}" ]]; then
  SIGNIN_URL="${APP_URL}/signin"
fi

COMMIT="$(git rev-parse HEAD)"
EXPECTED_CONFIRM="STAGE_PRODUCTION_ARTIFACT:$COMMIT"
if [[ "${PRICEFLAG_STAGE_CONFIRM:-}" != "$EXPECTED_CONFIRM" ]]; then
  echo "error: explicit commit acknowledgement required." >&2
  echo "       export PRICEFLAG_STAGE_CONFIRM=$EXPECTED_CONFIRM" >&2
  exit 1
fi

mkdir -p .vercel
cat > .vercel/project.json <<JSON
{"projectId":"$PROJECT_ID","orgId":"$TEAM_SCOPE"}
JSON

VC=(npx --yes vercel@latest "--token=$VERCEL_TOKEN" "--scope=$TEAM_SCOPE")

push_var() {
  local name="$1" value="$2"
  "${VC[@]}" env rm "$name" production --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | "${VC[@]}" env add "$name" production >/dev/null
  echo "    $name -> production: set (${#value} chars)"
}

echo "==> Updating production variables without deploying"
for name in "${REQUIRED_VARS[@]}"; do
  push_var "$name" "${!name}"
done
push_var PRICEFLAG_MODE real
push_var SIGNIN_URL "$SIGNIN_URL"
for legacy_name in SHOPIFY_ADMIN_ACCESS_TOKEN SHOPIFY_SHOP_DOMAIN; do
  "${VC[@]}" env rm "$legacy_name" production --yes >/dev/null 2>&1 || true
  echo "    $legacy_name -> production: removed (OAuth only)"
done

echo "==> Building staged production artifact for $COMMIT"
# --skip-domain is the critical boundary: this uses production environment
# variables but does not send production traffic to the new deployment.
DEPLOY_OUTPUT="$("${VC[@]}" deploy --prod --skip-domain --yes 2>&1)"
DEPLOY_URL="$(printf '%s' "$DEPLOY_OUTPUT" | grep -oE 'https://[a-z0-9.-]+\.vercel\.app' | head -1)"
if [[ -z "$DEPLOY_URL" ]]; then
  echo "error: could not determine the staged deployment URL." >&2
  exit 1
fi

echo "    staged artifact: $DEPLOY_URL"
echo "    source commit:   $COMMIT"
echo
echo "No domain was assigned and no promotion occurred. Inspect, browser-test, and"
echo "scan logs for this exact URL. Only after every launch gate passes, an owner may"
echo "run: vercel promote $DEPLOY_URL"
