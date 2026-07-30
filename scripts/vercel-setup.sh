#!/usr/bin/env bash
#
# Link the repo to the existing Vercel project, push env vars, deploy a preview.
#
#   bash scripts/vercel-setup.sh              # link + env + preview deploy
#   bash scripts/vercel-setup.sh --prod       # ...and promote to production (B7)
#
# Reads every value from .env.local and passes them to the Vercel CLI on stdin, so
# no secret is ever written to a file in the repo, printed, or committed. Values
# are shown only as "set (N chars)".
#
# Safety: this script never touches vercel.json. The evaluator cron stays out of
# vercel.json until B5 is written and verified, because that cron writes real
# prices to a real store with a real token — nothing should be able to mutate the
# store unattended.

set -euo pipefail

PROJECT_NAME="priceflag"
TEAM_SCOPE="nithin-arus-projects"
TARGET_DOMAIN="priceflagv1.vercel.app"

cd "$(dirname "$0")/.."

if [[ ! -f .env.local ]]; then
  echo "error: .env.local not found. Copy .env.example and fill it in." >&2
  exit 1
fi

# Load without echoing. `set -a` exports everything defined in the file.
set -a
# shellcheck disable=SC1091
source ./.env.local
set +a

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "error: VERCEL_TOKEN is not set in .env.local." >&2
  echo "       Create one at https://vercel.com/account/tokens (scope: $TEAM_SCOPE)." >&2
  exit 1
fi

VC=(npx --yes vercel@latest "--token=$VERCEL_TOKEN" "--scope=$TEAM_SCOPE")

echo "==> Linking to the existing '$PROJECT_NAME' project (never creating a second one)"
"${VC[@]}" link --yes --project "$PROJECT_NAME"

# Every var the app reads at runtime. PRICEFLAG_MODE is forced to `real` on Vercel
# — the demo adapter writes to the local filesystem, which is read-only there.
VARS=(
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  SHOPIFY_API_KEY
  SHOPIFY_API_SECRET
  SHOPIFY_ADMIN_ACCESS_TOKEN
  SHOPIFY_SHOP_DOMAIN
  SHOPIFY_API_VERSION
  SHOPIFY_SCOPES
  ENCRYPTION_KEY
  CRON_SECRET
  RESEND_API_KEY
  RESEND_FROM
)

push_var() {
  local name="$1" env_target="$2" value="$3"
  # Remove any existing value first; `env add` refuses to overwrite.
  "${VC[@]}" env rm "$name" "$env_target" --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | "${VC[@]}" env add "$name" "$env_target" >/dev/null
  echo "    $name -> $env_target: set (${#value} chars)"
}

for target in preview production; do
  echo "==> Pushing env vars ($target)"
  for name in "${VARS[@]}"; do
    value="${!name:-}"
    if [[ -z "$value" ]]; then
      echo "    $name -> $target: SKIPPED (empty in .env.local)"
      continue
    fi
    push_var "$name" "$target" "$value"
  done
  push_var PRICEFLAG_MODE "$target" "real"
done

echo "==> Building and deploying"
if [[ "${1:-}" == "--prod" ]]; then
  DEPLOY_URL="$("${VC[@]}" deploy --prod --yes)"
else
  DEPLOY_URL="$("${VC[@]}" deploy --yes)"
fi
echo "    deployment: $DEPLOY_URL"

# APP_URL has to be the deployment's own origin for OAuth redirects to resolve.
echo "==> Setting APP_URL to the deployment origin"
for target in preview production; do
  push_var APP_URL "$target" "https://$TARGET_DOMAIN"
done

echo "==> Attempting the target domain: $TARGET_DOMAIN"
if "${VC[@]}" alias set "$DEPLOY_URL" "$TARGET_DOMAIN" 2>/dev/null; then
  echo "    alias set: https://$TARGET_DOMAIN"
else
  echo "    COULD NOT claim $TARGET_DOMAIN — it is probably taken globally."
  echo "    Deployment is still live at: $DEPLOY_URL"
  echo "    Not silently substituting another subdomain; see docs/lane-status/lane-b.md."
fi

echo
echo "Done. Verify with:  curl -s $DEPLOY_URL/api/health | jq"
echo "Reminder: the evaluator cron is intentionally NOT in vercel.json until B5."
