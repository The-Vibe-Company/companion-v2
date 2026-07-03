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
SMOKE_PROFILE=""
# Filed under a NESTED label so the sidebar has a collapsed parent ("engineering") with a child
# ("engineering/tools") — required to exercise the 650ms folder dwell auto-open during a drag.
SMOKE_SKILL_LABEL="engineering/tools"

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

# Assert a JS expression evaluates to boolean true in the page. We query the DOM AFTER a real
# action, so production's own logic is under test — never the value we fed in.
assert_eval_true() {
  local expr="$1" msg="$2" result
  result="$(agent-browser eval "$expr" || true)"
  if [ "$result" != "true" ]; then
    printf '[agent-browser-smoke] %s (eval %s => %s)\n' "$msg" "$expr" "$result" >&2
    body_text >&2 || true
    exit 1
  fi
}

json_string() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] ?? ""))' "$1"
}

wait_for_body_contains() {
  local needle="$1" needle_js body
  needle_js="$(json_string "$needle")"

  for _ in $(seq 1 30); do
    body="$(body_text || true)"
    if printf '%s' "$body" | grep -Fi "$needle" >/dev/null; then
      return 0
    fi
    sleep 1
  done

  printf '[agent-browser-smoke] Timed out waiting for page text: %s\n' "$needle" >&2
  agent-browser get url >&2 || true
  agent-browser eval "({ wanted: ${needle_js}, body: document.body.innerText })" >&2 || true
  exit 1
}

fill_input() {
  local selector="$1" value="$2" selector_js value_js result
  selector_js="$(json_string "$selector")"
  value_js="$(json_string "$value")"
  result="$(
    agent-browser eval "(() => {
      const input = document.querySelector(${selector_js});
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) return false;
      input.focus();
      setter.call(input, ${value_js});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${value_js} }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value === ${value_js};
    })()" || true
  )"
  if [ "$result" != "true" ]; then
    printf '[agent-browser-smoke] Could not fill input %s (eval => %s)\n' "$selector" "$result" >&2
    body_text >&2 || true
    exit 1
  fi
}

click_button_text() {
  local name="$1" name_js result
  name_js="$(json_string "$name")"
  result="$(
    agent-browser eval "(() => {
      const wanted = ${name_js};
      const buttons = Array.from(document.querySelectorAll('button'));
      const button =
        buttons.find((b) => (b.textContent || '').trim() === wanted) ||
        buttons.find((b) => (b.textContent || '').includes(wanted));
      if (!button) return false;
      button.click();
      return true;
    })()" || true
  )"
  if [ "$result" != "true" ]; then
    printf '[agent-browser-smoke] Could not click button named "%s" (eval => %s)\n' "$name" "$result" >&2
    body_text >&2 || true
    exit 1
  fi
}

# Center point (x y) of an element's bounding box, from real layout.
box_center() {
  agent-browser get box "$1" | awk '/^x:/{x=$2}/^y:/{y=$2}/^width:/{w=$2}/^height:/{h=$2}END{printf "%d %d\n", x + w / 2, y + h / 2}'
}

# Ground truth (independent of the browser): does the skill now carry `label` directly?
assert_skill_filed_under() {
  local label="$1" info_json filed
  if ! info_json="$(pnpm --silent --filter @companion/cli dev --json skills info "$SMOKE_SKILL" --profile "$SMOKE_PROFILE" 2>/dev/null)"; then
    printf '[agent-browser-smoke] Could not read skill info to confirm the drop\n' >&2
    exit 1
  fi
  filed="$(printf '%s' "$info_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);const ls=Array.isArray(j.labels)?j.labels:[];process.stdout.write(ls.includes(process.argv[1])?"yes":"no");})' "$label")"
  if [ "$filed" != "yes" ]; then
    printf '[agent-browser-smoke] Drop did not file %s under "%s". Skill info: %s\n' "$SMOKE_SKILL" "$label" "$info_json" >&2
    exit 1
  fi
}

# Real-mouse pointer drag: skill row -> sidebar folder. This is the assertion the prior native-DnD
# attempts could never make truthfully — CDP mouse input drives genuine pointer events, so if the
# drop-target hover, the 650ms dwell auto-open, or the drop ever broke for a real user, this fails.
drag_and_drop_smoke() {
  log "Checking real-mouse pointer drag (skill -> folder)"
  agent-browser open "$APP_URL/skills?lib=org"
  wait_for_skills

  local src_sel dst_sel child_sel sx sy dx dy
  src_sel="button[aria-label=\"Open skill ${SMOKE_SKILL}\"]"
  dst_sel='[data-skill-drop-kind="label"][data-skill-drop-path="engineering"]'
  child_sel='[data-skill-drop-path="engineering/tools"]'

  assert_eval_true "!!document.querySelector('$dst_sel')" "engineering folder row not found"
  assert_eval_true "!document.querySelector('$child_sel')" "engineering should start collapsed"

  read -r sx sy < <(box_center "$src_sel")
  read -r dx dy < <(box_center "$dst_sel")

  # Press on the skill, cross the 4px threshold, then step the cursor onto the folder.
  agent-browser mouse move "$sx" "$sy"
  agent-browser mouse down left
  agent-browser mouse move "$((sx + 8))" "$((sy + 8))"
  agent-browser mouse move "$(((sx + dx) / 2))" "$(((sy + dy) / 2))"
  agent-browser mouse move "$dx" "$dy"
  agent-browser wait 120

  assert_eval_true "document.querySelector('$dst_sel').classList.contains('lblrow--dropok')" \
    "engineering did not highlight (.lblrow--dropok) under a real-mouse drag"
  assert_eval_true "document.querySelectorAll('.lblrow--dropok').length === 1" \
    "expected exactly one highlighted folder during the drag"

  # Hold over the closed parent: the 650ms dwell must reveal its child folder.
  agent-browser wait 800
  assert_eval_true "!!document.querySelector('$child_sel')" \
    "the 650ms dwell did not auto-open the engineering folder"

  # Drop, then confirm the model actually changed (not just the 1-frame .lblrow--dropdone flash).
  agent-browser mouse up left
  agent-browser wait 400
  assert_skill_filed_under "engineering"
  assert_no_browser_errors
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
  SMOKE_PROFILE="$profile"

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
    --label "$SMOKE_SKILL_LABEL" \
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
fill_input "#si-email" "$SMOKE_EMAIL"
fill_input "#si-pw" "$SMOKE_PASSWORD"
click_button_text "Sign in"
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

drag_and_drop_smoke

log "Checking upload dialog opens"
agent-browser find role button click --name "Upload skill"
agent-browser wait 500
assert_body_contains "Upload an organization skill"
assert_body_contains "Assistant IA"
assert_body_contains "Create in the browser"
agent-browser find role button click --name "Cancel"

log "Checking Companion skills OpenCode support"
agent-browser open "$APP_URL/skills?view=local"
wait_for_body_contains "Companion skills"
assert_body_contains "OpenCode"
assert_no_browser_errors


# --- Companion Agents console (UI-only; skipped when the agents API is absent) -------------------
log "Checking the agents console"
agent-browser set device "Desktop Chrome" >/dev/null 2>&1 || true
agents_probe="$(agent-browser eval "fetch('/v1/agents?lib=mine').then((r) => r.status).catch(() => 0)" 2>/dev/null | tr -d '\"' || true)"
if [ "$agents_probe" != "200" ]; then
  log "Agents API not available (status: ${agents_probe:-unknown}) — skipping the agents section"
else
  agent-browser open "$APP_URL/agents"
  wait_for_body_contains "New agent"
  assert_body_contains "My Companions"
  assert_body_contains "Running"
  assert_no_browser_errors

  log "Checking the org fleet + agents sidebar nav"
  agent-browser open "$APP_URL/agents?lib=org"
  wait_for_body_contains "New agent"
  assert_body_contains "Organization"
  assert_no_browser_errors

  log "Checking the create-agent form gating"
  agent-browser open "$APP_URL/agents?view=new"
  wait_for_body_contains "Provision agent"
  assert_body_contains "Instructions"
  assert_body_contains "Becomes the chat URL"
  assert_eval_true "Array.from(document.querySelectorAll('button')).some((el) => el.textContent.trim() === 'Provision agent' && el.disabled)" \
    "Provision agent should be disabled until a name and a skill are set"
  assert_no_browser_errors

  log "Checking an agent detail (seeded fleet)"
  seeded_agent="$(agent-browser eval "fetch('/v1/agents?lib=org').then((r) => r.json()).then((d) => (d.agents && d.agents[0] ? d.agents[0].slug : ''))" 2>/dev/null | tr -d '\"' || true)"
  if [ -n "$seeded_agent" ] && [ "$seeded_agent" != "null" ]; then
    agent-browser open "$APP_URL/agents?lib=org&agent=$seeded_agent"
    wait_for_body_contains "Properties"
    assert_body_contains "$seeded_agent"
    assert_body_contains "Danger zone"
    assert_no_browser_errors
  else
    log "No seeded org agents — skipping the detail check"
  fi
fi

log "Checking mobile viewport"
agent-browser set device "iPhone 14"
agent-browser open "$APP_URL/skills?lib=org"
wait_for_skills
assert_body_contains "Upload skill"
assert_body_contains "$SMOKE_SKILL"

log "Checking mobile install targets"
agent-browser open "$APP_URL/skills?lib=org&skill=$SMOKE_SKILL"
wait_for_body_contains "Install skill"
assert_body_contains "$SMOKE_SKILL"
click_button_text "Install skill"
wait_for_body_contains "Download package"
click_button_text "Download package"
wait_for_body_contains "OpenCode"
assert_eval_true "document.documentElement.scrollWidth <= document.documentElement.clientWidth" \
  "mobile install dialog introduced horizontal overflow"
assert_eval_true "Array.from(document.querySelectorAll('.up-seg')).some((el) => el.textContent.includes('OpenCode') && getComputedStyle(el).flexWrap === 'wrap' && el.scrollWidth <= el.clientWidth)" \
  "install-location selector did not wrap within its mobile container"
assert_eval_true "(() => { const buttons = Array.from(document.querySelectorAll('.up-seg button')).filter((el) => ['Claude Code', 'Codex', 'OpenCode', 'Local folder'].includes((el.textContent || '').trim())); return buttons.length === 4 && buttons.every((el) => getComputedStyle(el).minWidth === '0px'); })()" \
  "install-location buttons are missing min-width: 0"

assert_no_browser_errors
log "OK"
