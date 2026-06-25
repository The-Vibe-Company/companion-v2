#!/usr/bin/env bash
set -euo pipefail

APP_URL="${APP_URL:-http://127.0.0.1:${CONDUCTOR_PORT:-3000}}"
APP_URL="${APP_URL%/}"
DEFAULT_SMOKE_EMAIL="admin@tvc.dev"
DEFAULT_SMOKE_PASSWORD="adminadmin"
SMOKE_EMAIL="${BROWSER_SMOKE_EMAIL:-$DEFAULT_SMOKE_EMAIL}"
SMOKE_PASSWORD="${BROWSER_SMOKE_PASSWORD:-$DEFAULT_SMOKE_PASSWORD}"
SMOKE_SKILL="incident-summary"
SMOKE_SKILL_DIR=""

log() {
  printf '[agent-browser-smoke] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[agent-browser-smoke] Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

is_loopback_url() {
  case "$APP_URL" in
    http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*|http://[::1]|http://[::1]:*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

body_text() {
  agent-browser eval "document.body.innerText"
}

assert_body_contains() {
  local needle="$1"
  if ! body_text | grep -Fi "$needle" >/dev/null; then
    printf '[agent-browser-smoke] Expected page text not found: %s\n' "$needle" >&2
    body_text >&2
    exit 1
  fi
}

wait_for_skills() {
  local body url

  for _ in $(seq 1 30); do
    url="$(agent-browser get url || true)"
    body="$(body_text || true)"
    if [[ "$url" == */skills* ]] && printf '%s' "$body" | grep -F "Upload skill" >/dev/null; then
      return 0
    fi
    sleep 1
  done

  printf '[agent-browser-smoke] Timed out waiting for the skills page\n' >&2
  agent-browser get url >&2 || true
  body_text >&2 || true
  exit 1
}

wait_for_login() {
  local url

  for _ in $(seq 1 30); do
    url="$(agent-browser get url || true)"
    if [[ "$url" == */login* ]]; then
      return 0
    fi
    sleep 1
  done

  printf '[agent-browser-smoke] Expected /skills to redirect to /login when signed out\n' >&2
  agent-browser get url >&2 || true
  exit 1
}

assert_no_browser_errors() {
  local errors
  errors="$(agent-browser errors || true)"
  if [ -n "$errors" ]; then
    printf '[agent-browser-smoke] Browser errors detected:\n%s\n' "$errors" >&2
    exit 1
  fi
}

api_url() {
  if [ -n "${COMPANION_API_URL:-}" ]; then
    printf '%s\n' "${COMPANION_API_URL%/}"
    return
  fi

  case "$APP_URL" in
    http://127.0.0.1:*|http://localhost:*)
      local port
      port="${APP_URL##*:}"
      port="${port%%/*}"
      printf 'http://127.0.0.1:%s\n' "$((port + 1))"
      ;;
    *)
      printf '[agent-browser-smoke] COMPANION_API_URL is required when APP_URL is not localhost with an explicit port.\n' >&2
      exit 1
      ;;
  esac
}

prepare_fixtures() {
  local api profile
  api="$(api_url)"
  profile="browser-smoke-${APP_URL##*:}"
  profile="${profile%%/*}"

  log "Preparing smoke account and skill fixture against $api"
  pnpm --filter @companion/cli dev login \
    --url "$api" \
    --email "$SMOKE_EMAIL" \
    --password "$SMOKE_PASSWORD" \
    --profile "$profile" >/dev/null 2>&1 || \
  pnpm --filter @companion/cli dev login \
    --url "$api" \
    --email "$SMOKE_EMAIL" \
    --password "$SMOKE_PASSWORD" \
    --signup \
    --profile "$profile" >/dev/null

  mark_companion_skill_installed "$api" "$profile"
  SMOKE_SKILL_DIR="$(prepare_smoke_skill_dir "$profile")"

  local push_output
  if ! push_output="$(pnpm --filter @companion/cli dev skills push "$SMOKE_SKILL_DIR" \
    --label engineering \
    --profile "$profile" 2>&1)"; then
    if ! printf '%s' "$push_output" | grep -Fi "version already exists" >/dev/null; then
      printf '%s\n' "$push_output" >&2
      exit 1
    fi
  fi
}

mark_companion_skill_installed() {
  local api="$1" profile="$2"
  PROFILE="$profile" API_URL="$api" node <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const profile = process.env.PROFILE;
const api = process.env.API_URL.replace(/\/$/, "");
const suffix = profile === "default" ? "" : `.${profile}`;
const sessionPath = path.join(process.env.COMPANION_HOME || path.join(os.homedir(), ".companion"), `session${suffix}.json`);
const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
const headers = {
  cookie: session.cookie,
  "content-type": "application/json",
};
if (session.orgId) headers["x-companion-org"] = session.orgId;

(async () => {
  const current = await fetch(`${api}/v1/local-skills/companion`, { headers });
  if (!current.ok) throw new Error(`GET /v1/local-skills/companion failed: ${current.status}`);
  const row = await current.json();
  const version = row.availableVersion;
  if (!version) throw new Error("Companion local skill response did not include availableVersion");
  const installed = await fetch(`${api}/v1/local-skills/companion/installed`, {
    method: "POST",
    headers,
    body: JSON.stringify({ version, agent: "browser-smoke" }),
  });
  if (!installed.ok) throw new Error(`POST /v1/local-skills/companion/installed failed: ${installed.status}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
}

prepare_smoke_skill_dir() {
  local profile="$1"
  local fixture="$PWD/examples/skills/incident-summary"
  local info_json existing_id tmp

  if ! info_json="$(pnpm --silent --filter @companion/cli dev --json skills info "$SMOKE_SKILL" --profile "$profile" 2>/dev/null)"; then
    printf '%s\n' "$fixture"
    return
  fi
  existing_id="$(printf '%s' "$info_json" | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { const j = JSON.parse(s); process.stdout.write(j.id || ""); });')"
  if [ -z "$existing_id" ]; then
    printf '%s\n' "$fixture"
    return
  fi

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/companion-smoke-skill.XXXXXX")"
  cp -R "$fixture/." "$tmp/"
  SKILL_ID="$existing_id" SKILL_DIR="$tmp" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const manifestPath = path.join(process.env.SKILL_DIR, "companion.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.metadata = manifest.metadata || {};
manifest.metadata.companionSkillId = process.env.SKILL_ID;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
  printf '%s\n' "$tmp"
}

require_command agent-browser
trap 'agent-browser close >/dev/null 2>&1 || true; if [ -n "$SMOKE_SKILL_DIR" ] && [ "$SMOKE_SKILL_DIR" != "$PWD/examples/skills/incident-summary" ]; then rm -rf "$SMOKE_SKILL_DIR"; fi' EXIT

if ! is_loopback_url; then
  if [ -z "${BROWSER_SMOKE_EMAIL+x}" ] || [ -z "${BROWSER_SMOKE_PASSWORD+x}" ]; then
    printf '[agent-browser-smoke] Default seed credentials are only allowed for loopback APP_URL values.\n' >&2
    printf '[agent-browser-smoke] Set BROWSER_SMOKE_EMAIL and BROWSER_SMOKE_PASSWORD for non-local targets.\n' >&2
    exit 1
  fi
fi

prepare_fixtures

log "Opening $APP_URL"
agent-browser close >/dev/null 2>&1 || true
agent-browser set viewport 1440 1000
agent-browser open "$APP_URL/login"
agent-browser cookies clear >/dev/null 2>&1 || true

log "Checking anonymous redirect"
agent-browser open "$APP_URL/skills"
wait_for_login

log "Signing in"
agent-browser find label "Email" fill "$SMOKE_EMAIL"
agent-browser find label "Password" fill "$SMOKE_PASSWORD"
agent-browser find role button click --name "Sign in"
wait_for_skills
agent-browser open "$APP_URL/skills?lib=org"
wait_for_skills
agent-browser eval "for (const b of Array.from(document.querySelectorAll('button'))) { if (b.textContent && b.textContent.trim() === 'Clear') b.click(); }" >/dev/null
agent-browser wait 300
assert_body_contains "$SMOKE_SKILL"
assert_body_contains "Upload skill"
# Shared label folder tree (replaces the old owner/visibility sidebar): the smoke skill is filed under "engineering".
assert_body_contains "engineering"

log "Checking filter menu"
agent-browser find role button click --name "Filter"
agent-browser wait 300
assert_body_contains "Status"
assert_body_contains "Dependencies"
assert_body_contains "Has dependencies"
agent-browser press Escape

log "Checking detail view"
agent-browser find role button click --name "Open skill $SMOKE_SKILL"
agent-browser wait 1000
assert_body_contains "$SMOKE_SKILL"
assert_body_contains "Install skill"
agent-browser open "$APP_URL/skills?lib=org"
wait_for_skills

log "Checking upload dialog opens"
agent-browser find role button click --name "Upload skill"
agent-browser wait 500
assert_body_contains "Upload an organization skill"
assert_body_contains "Assistant IA"
assert_body_contains "Create in the browser"
agent-browser find role button click --name "Cancel"

log "Checking mobile viewport"
agent-browser set device "iPhone 14"
agent-browser open "$APP_URL/skills?lib=org"
wait_for_skills
assert_body_contains "Upload skill"
assert_body_contains "$SMOKE_SKILL"

assert_no_browser_errors
log "OK"
