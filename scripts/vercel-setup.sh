#!/usr/bin/env bash
#
# Link the repo to the existing Vercel project, push env vars, and deploy a
# protected preview. This script deliberately cannot promote production.
#
#   bash scripts/vercel-setup.sh              # link + env + preview deploy
#
# Reads every value from .env.preview.local and passes it to Vercel on stdin, so
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

ENV_FILE=".env.preview.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found. Copy .env.example and fill it with staging/test-store values." >&2
  exit 1
fi

if [[ $# -ne 0 ]]; then
  echo "error: this command creates previews only and accepts no arguments." >&2
  echo "       Create and verify a staged production artifact only after every preview gate passes." >&2
  exit 1
fi

# Load without echoing. `set -a` exports everything defined in the file.
set -a
# shellcheck disable=SC1091
source "./$ENV_FILE"
set +a

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "error: VERCEL_TOKEN is not set in $ENV_FILE." >&2
  echo "       Create one at https://vercel.com/account/tokens (scope: $TEAM_SCOPE)." >&2
  exit 1
fi

VC=(npx --yes vercel@latest "--token=$VERCEL_TOKEN" "--scope=$TEAM_SCOPE")

# Every required server-side value for the invite beta. Fail before touching
# Vercel if one is absent; a partially configured preview is not launch proof.
REQUIRED_VARS=(
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  SHOPIFY_API_KEY
  SHOPIFY_API_SECRET
  SHOPIFY_APP_HANDLE
  SHOPIFY_API_VERSION
  SHOPIFY_SCOPES
  APP_URL
  ENCRYPTION_KEY
  CRON_SECRET
  APP_ACCESS_SECRET
  ML_INGEST_SECRET
  RESEND_API_KEY
  RESEND_FROM
  PRICEFLAG_SHOP_ALLOWLIST
)

for name in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "error: required variable $name is empty in $ENV_FILE." >&2
    exit 1
  fi
done

if [[ -n "${SHOPIFY_ADMIN_ACCESS_TOKEN:-}" || -n "${SHOPIFY_SHOP_DOMAIN:-}" ]]; then
  echo "error: preview verification must use the Partner OAuth test app, not static Shopify credentials." >&2
  exit 1
fi

echo "==> Linking to the existing '$PROJECT_NAME' project (never creating a second one)"
mkdir -p .vercel
# Writing the link file directly is deterministic; `vercel link --project <name>`
# will happily offer to create a new project when resolution is ambiguous.
cat > .vercel/project.json <<JSON
{"projectId":"$PROJECT_ID","orgId":"$TEAM_SCOPE"}
JSON
echo "    linked to $PROJECT_ID on $TEAM_SCOPE"

push_var() {
  local name="$1" env_target="$2" value="$3"
  # Remove any existing value first; `env add` refuses to overwrite.
  "${VC[@]}" env rm "$name" "$env_target" --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | "${VC[@]}" env add "$name" "$env_target" >/dev/null
  echo "    $name -> $env_target: set (${#value} chars)"
}

for target in preview; do
  echo "==> Pushing env vars ($target)"
  for name in "${REQUIRED_VARS[@]}"; do
    value="${!name:-}"
    push_var "$name" "$target" "$value"
  done
  push_var PRICEFLAG_MODE "$target" "real"

  # Static Admin API credentials are a local-development path. Keeping stale
  # copies in Vercel creates ambiguity even though runtime code rejects them.
  for legacy_name in SHOPIFY_ADMIN_ACCESS_TOKEN SHOPIFY_SHOP_DOMAIN; do
    "${VC[@]}" env rm "$legacy_name" "$target" --yes >/dev/null 2>&1 || true
    echo "    $legacy_name -> $target: removed (production OAuth only)"
  done
done

echo "==> Building and deploying a protected preview"
DEPLOY_OUTPUT="$("${VC[@]}" deploy --yes 2>&1)"

# Extract only the generated deployment hostname; do not print the CLI envelope.
DEPLOY_URL="$(printf '%s' "$DEPLOY_OUTPUT" | grep -oE 'https://[a-z0-9.-]+\.vercel\.app' | head -1)"

if [[ -z "$DEPLOY_URL" ]]; then
  echo "error: could not determine the deployment URL. Raw output follows:" >&2
  printf '%s\n' "$DEPLOY_OUTPUT" >&2
  exit 1
fi
echo "    deployment: $DEPLOY_URL"

echo
echo "Done."
echo "  preview artifact: $DEPLOY_URL"
echo "  production target (unchanged): https://$TARGET_DOMAIN"
echo "  production variables: unchanged"
echo
echo "Deployment Protection is enabled on this project, so a plain curl gets a 302"
echo "to Vercel SSO. That is a security setting and this script does not change it."
echo "To verify, open the URL in a browser signed in to Vercel."
echo "This script did not alias or promote the preview. After it passes, use"
echo "scripts/vercel-stage.sh to create a production-environment artifact without"
echo "assigning the production domain. Verify that exact staged URL before promotion."
echo
echo "Reminder: the evaluator cron is intentionally NOT in vercel.json until B5."
