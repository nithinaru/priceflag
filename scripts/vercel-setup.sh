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
# Safety: this script never touches vercel.json. The evaluator is NOT a Vercel
# cron — Deployment Protection 302s an unauthenticated request and Vercel Cron
# does not follow redirects, so it would fail silently. GitHub Actions
# (.github/workflows/evaluator.yml) is the only scheduler.

set -euo pipefail

PROJECT_NAME="priceflag-app"
# Pinned by id, not just name.
#
# NOTE: prj_gzNZMOkkZTOSIwkQ6o6cwPIOW5bh (now named "priceflagv1") is NOT this
# app any more — it was repurposed as the company homepage, its Git connection is
# disconnected, and it still holds priceflag.vercel.app. Do not deploy to it, do
# not touch its domains. This project is a separate one.
PROJECT_ID="prj_RU8NlBDoR7t89BNqn5BagOpmpnmm"
TEAM_SCOPE="team_AqaBD6YaOf9DIJ7NzbytTZTW"
TARGET_DOMAIN="priceflag-app.vercel.app"

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
mkdir -p .vercel
# Writing the link file directly is deterministic; `vercel link --project <name>`
# will happily offer to create a new project when resolution is ambiguous.
cat > .vercel/project.json <<JSON
{"projectId":"$PROJECT_ID","orgId":"$TEAM_SCOPE"}
JSON
echo "    linked to $PROJECT_ID on $TEAM_SCOPE"

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
  APP_ACCESS_SECRET
  ML_INGEST_SECRET
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
  DEPLOY_OUTPUT="$("${VC[@]}" deploy --prod --yes 2>&1)"
else
  DEPLOY_OUTPUT="$("${VC[@]}" deploy --yes 2>&1)"
fi

# The CLI emits a JSON envelope, not a bare URL. Capturing stdout wholesale and
# passing it to `alias set` fails in a way that looks exactly like "the domain is
# taken", so extract the hostname explicitly.
DEPLOY_URL="$(printf '%s' "$DEPLOY_OUTPUT" | grep -oE 'https://[a-z0-9.-]+\.vercel\.app' | head -1)"

if [[ -z "$DEPLOY_URL" ]]; then
  echo "error: could not determine the deployment URL. Raw output follows:" >&2
  printf '%s\n' "$DEPLOY_OUTPUT" >&2
  exit 1
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
echo "Done."
echo "  deployment: $DEPLOY_URL"
echo "  target:     https://$TARGET_DOMAIN"
echo
echo "Deployment Protection is enabled on this project, so a plain curl gets a 302"
echo "to Vercel SSO. That is a security setting and this script does not change it."
echo "To verify, open the URL in a browser signed in to Vercel."
echo
echo "Reminder: the evaluator cron is intentionally NOT in vercel.json until B5."
