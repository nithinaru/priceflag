#!/usr/bin/env bash
# Safely revoke or rotate temporary reviewer credentials on the pinned app.
# This changes configuration only; it never deploys, aliases, or promotes.

set -euo pipefail

PROJECT_ID="prj_RU8NlBDoR7t89BNqn5BagOpmpnmm"
PROJECT_NAME="priceflag-app"
TEAM_SCOPE="team_AqaBD6YaOf9DIJ7NzbytTZTW"
ENV_FILE=".env.production.local"

cd "$(dirname "$0")/.."

ACTION="${1:-}"
if [[ "$ACTION" != "revoke" && "$ACTION" != "rotate" ]]; then
  echo "usage: $0 revoke|rotate" >&2
  exit 1
fi
if [[ $# -ne 1 ]]; then
  echo "error: expected exactly one action." >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found." >&2
  exit 1
fi

EXPLICIT_CONFIRM="${PRICEFLAG_DEMO_ACCESS_CONFIRM:-}"
set -a
# shellcheck disable=SC1091
source "./$ENV_FILE"
set +a
if [[ -n "$EXPLICIT_CONFIRM" ]]; then
  PRICEFLAG_DEMO_ACCESS_CONFIRM="$EXPLICIT_CONFIRM"
fi

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "error: VERCEL_TOKEN is not set in $ENV_FILE." >&2
  exit 1
fi

COMMIT="$(git rev-parse HEAD)"
ACTION_UPPER="$(printf '%s' "$ACTION" | tr '[:lower:]' '[:upper:]')"
EXPECTED_CONFIRM="${ACTION_UPPER}_DEMO_ACCESS:$COMMIT"
if [[ "${PRICEFLAG_DEMO_ACCESS_CONFIRM:-}" != "$EXPECTED_CONFIRM" ]]; then
  echo "error: explicit commit acknowledgement required." >&2
  echo "       export PRICEFLAG_DEMO_ACCESS_CONFIRM=$EXPECTED_CONFIRM" >&2
  exit 1
fi

mkdir -p .vercel
cat > .vercel/project.json <<JSON
{"projectId":"$PROJECT_ID","orgId":"$TEAM_SCOPE"}
JSON

# Re-attest the project through Vercel before the first mutation. A stale local
# link is not authority, even though the deterministic link above replaces it.
VERCEL_PROJECT_ID="$PROJECT_ID" VERCEL_PROJECT_NAME="$PROJECT_NAME" VERCEL_TEAM_ID="$TEAM_SCOPE" node - <<'NODE'
void (async () => {
  const id = process.env.VERCEL_PROJECT_ID;
  const name = process.env.VERCEL_PROJECT_NAME;
  const team = process.env.VERCEL_TEAM_ID;
  const token = process.env.VERCEL_TOKEN;
  const response = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(id)}?teamId=${encodeURIComponent(team)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Vercel project attestation failed with HTTP ${response.status}`);
  const project = await response.json();
  if (project.id !== id || project.name !== name) throw new Error('Vercel returned a different project');
})().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
NODE

VC=(npx --yes vercel@latest "--token=$VERCEL_TOKEN" "--scope=$TEAM_SCOPE")

remove_value() {
  local name="$1" target="$2"
  "${VC[@]}" env rm "$name" "$target" --yes >/dev/null 2>&1 || true
  local listing
  if ! listing="$("${VC[@]}" env ls "$target" 2>/dev/null)"; then
    echo "error: could not verify $target environment after removing $name." >&2
    exit 1
  fi
  if printf '%s\n' "$listing" | grep -Eq "(^|[[:space:]])${name}([[:space:]]|$)"; then
    echo "error: $name is still configured for $target." >&2
    exit 1
  fi
  echo "    $name -> $target: removed and verified"
}

set_value() {
  local name="$1" target="$2" value="$3"
  remove_value "$name" "$target"
  printf '%s' "$value" | "${VC[@]}" env add "$name" "$target" >/dev/null
  local listing
  if ! listing="$("${VC[@]}" env ls "$target" 2>/dev/null)"; then
    echo "error: could not verify $target environment after setting $name." >&2
    exit 1
  fi
  if ! printf '%s\n' "$listing" | grep -Eq "(^|[[:space:]])${name}([[:space:]]|$)"; then
    echo "error: $name was not present after the update for $target." >&2
    exit 1
  fi
  echo "    $name -> $target: set (${#value} chars)"
}

if [[ "$ACTION" == "revoke" ]]; then
  echo "==> Revoking temporary reviewer access on pinned project $PROJECT_ID"
  for target in preview production; do
    remove_value DEMO_PASSWORD "$target"
    remove_value DEMO_USERNAME "$target"
  done
else
  if [[ -z "${PRICEFLAG_DEMO_USERNAME:-}" ]]; then
    read -r -p "Reviewer username: " PRICEFLAG_DEMO_USERNAME
  fi
  if [[ -z "${PRICEFLAG_DEMO_PASSWORD:-}" ]]; then
    read -r -s -p "Reviewer password: " PRICEFLAG_DEMO_PASSWORD
    echo
  fi
  if [[ -z "$PRICEFLAG_DEMO_USERNAME" || -z "$PRICEFLAG_DEMO_PASSWORD" ]]; then
    echo "error: reviewer username and password must both be non-empty." >&2
    exit 1
  fi
  echo "==> Rotating temporary reviewer access on pinned project $PROJECT_ID"
  for target in preview production; do
    set_value DEMO_USERNAME "$target" "$PRICEFLAG_DEMO_USERNAME"
    set_value DEMO_PASSWORD "$target" "$PRICEFLAG_DEMO_PASSWORD"
  done
fi

echo
echo "Configuration changed, but running deployments still use their prior snapshot."
echo "Create and verify a new Preview, then stage, verify, and promote the exact"
echo "Production artifact. This command performed no deployment or promotion."
