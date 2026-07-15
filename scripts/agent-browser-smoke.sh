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
    http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*|http://\[::1\]|http://\[::1\]:*)
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
    if [[ "$url" == */skills* ]] && printf '%s' "$body" | grep -F "Add skill" >/dev/null; then
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

wait_for_contextual_action() {
  local explicit="$1" contextual="$2" explicit_js contextual_js result
  explicit_js="$(json_string "$explicit")"
  contextual_js="$(json_string "$contextual")"

  for _ in $(seq 1 30); do
    result="$(
      agent-browser eval "(() => {
        const explicit = ${explicit_js};
        const contextual = ${contextual_js};
        const button = Array.from(document.querySelectorAll('button[aria-label]'))
          .find((candidate) => candidate.getAttribute('aria-label') === explicit);
        return button?.textContent?.trim() === contextual && button?.title === explicit;
      })()" || true
    )"
    if [ "$result" = "true" ]; then
      return 0
    fi
    sleep 1
  done

  printf '[agent-browser-smoke] Timed out waiting for contextual action: %s / %s\n' "$contextual" "$explicit" >&2
  agent-browser get url >&2 || true
  body_text >&2 || true
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
assert_body_contains "Add skill"
# Shared label folder tree (replaces the old owner/visibility sidebar): the smoke skill is filed under "engineering".
assert_body_contains "engineering"

log "Checking contextual row-action alignment"
for width in 1024 760; do
  agent-browser set viewport "$width" 800
  agent-browser wait 150
  assert_eval_true "(() => {
    const header = document.querySelector('.clist--deps .chead span:last-child');
    const cells = Array.from(document.querySelectorAll('.clist--deps .crow > .crow__primary'));
    if (!header || cells.length === 0) return false;
    const expected = header.getBoundingClientRect();
    const headerColumns = getComputedStyle(header.parentElement).gridTemplateColumns;
    return cells.every((cell) => {
      const rect = cell.getBoundingClientRect();
      const button = cell.querySelector('.rowact--primary');
      const rowColumns = getComputedStyle(cell.parentElement).gridTemplateColumns;
      const aligned = Math.abs(rect.right - expected.right) < 1 && rowColumns === headerColumns;
      const contained = !button || button.getBoundingClientRect().right <= rect.right + 0.5;
      return aligned && contained;
    });
  })()" "contextual action columns are not aligned at ${width}px"
  assert_eval_true "document.documentElement.scrollWidth <= document.documentElement.clientWidth" \
    "contextual row actions introduced horizontal overflow at ${width}px"
done
assert_eval_true "(() => {
  const button = document.querySelector('button[aria-label=\"Install skill $SMOKE_SKILL\"]');
  return button?.querySelector('.rowact__label')?.textContent?.trim() === 'Install';
})()" "the compact Install row CTA includes the redundant word skill"
agent-browser set viewport 1440 1000

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
wait_for_contextual_action "Install skill" "Install"

log "Checking run launcher scrolling at a short desktop viewport"
agent-browser set viewport 1024 420
click_button_text "Run skill"
wait_for_body_contains "Configuration"
assert_eval_true "(() => {
  const dialog = document.querySelector('.run-launcher');
  const head = dialog?.querySelector('.og-dialog__head');
  const body = dialog?.querySelector('.og-dialog__body');
  const foot = dialog?.querySelector('.og-dialog__foot');
  if (!dialog || !head || !body || !foot) return false;
  const dialogRect = dialog.getBoundingClientRect();
  const headRect = head.getBoundingClientRect();
  const footRect = foot.getBoundingClientRect();
  const contained = dialogRect.top >= 0 && dialogRect.bottom <= window.innerHeight;
  const pinned = headRect.top >= dialogRect.top && headRect.bottom <= dialogRect.bottom &&
    footRect.top >= dialogRect.top && footRect.bottom <= dialogRect.bottom;
  const sectionsUnclipped = Array.from(body.children).every((section) =>
    section.scrollHeight <= section.clientHeight + 1
  );
  window.__runLauncherPinnedPositions = { headTop: headRect.top, footTop: footRect.top };
  return contained && pinned && sectionsUnclipped && body.scrollHeight > body.clientHeight;
})()" "run launcher is not contained, scrollable, and pinned at a short viewport"
agent-browser eval "(() => { const body = document.querySelector('.run-launcher .og-dialog__body'); if (body) body.scrollTop = body.scrollHeight; })()" >/dev/null
assert_eval_true "document.querySelector('.run-launcher .og-dialog__body')?.scrollTop > 0" \
  "run launcher body did not scroll"
assert_eval_true "(() => {
  const dialog = document.querySelector('.run-launcher');
  const head = dialog?.querySelector('.og-dialog__head');
  const foot = dialog?.querySelector('.og-dialog__foot');
  const before = window.__runLauncherPinnedPositions;
  if (!dialog || !head || !foot || !before) return false;
  const dialogRect = dialog.getBoundingClientRect();
  const headRect = head.getBoundingClientRect();
  const footRect = foot.getBoundingClientRect();
  return headRect.top >= dialogRect.top && headRect.bottom <= dialogRect.bottom &&
    footRect.top >= dialogRect.top && footRect.bottom <= dialogRect.bottom &&
    Math.abs(headRect.top - before.headTop) < 0.5 && Math.abs(footRect.top - before.footTop) < 0.5;
})()" "run launcher header or footer moved outside the dialog after scrolling"
agent-browser press Escape
agent-browser set viewport 1440 1000

agent-browser open "$APP_URL/skills?lib=org"
wait_for_skills

drag_and_drop_smoke

log "Checking add-skill dialog opens"
agent-browser find role button click --name "Add skill"
agent-browser wait 500
assert_body_contains "Add an organization skill"
assert_body_contains "Use an AI assistant"
assert_body_contains "Upload package"
assert_body_contains "Create in browser"
agent-browser find role button click --name "Cancel"

log "Checking Companion skills OpenCode support"
agent-browser open "$APP_URL/skills?view=local"
wait_for_body_contains "Companion skills"
assert_body_contains "OpenCode"
assert_no_browser_errors

log "Checking mobile viewport"
agent-browser set device "iPhone 14"
agent-browser open "$APP_URL/skills?lib=org"
wait_for_skills
assert_body_contains "Add skill"
assert_body_contains "$SMOKE_SKILL"

log "Checking mobile run launcher"
agent-browser set viewport 390 420
agent-browser open "$APP_URL/skills?lib=org&skill=$SMOKE_SKILL"
wait_for_contextual_action "Install skill" "Install"
click_button_text "Run skill"
wait_for_body_contains "Configuration"
assert_eval_true "(() => {
  const dialog = document.querySelector('.run-launcher');
  const head = dialog?.querySelector('.og-dialog__head');
  const body = dialog?.querySelector('.og-dialog__body');
  const foot = dialog?.querySelector('.og-dialog__foot');
  if (!dialog || !head || !body || !foot) return false;
  const dialogRect = dialog.getBoundingClientRect();
  const headRect = head.getBoundingClientRect();
  const footRect = foot.getBoundingClientRect();
  const style = getComputedStyle(dialog);
  const sectionsUnclipped = Array.from(body.children).every((section) =>
    section.scrollHeight <= section.clientHeight + 1
  );
  window.__runLauncherMobilePinnedPositions = { headTop: headRect.top, footTop: footRect.top };
  return Math.abs(dialogRect.top) < 0.5 && Math.abs(dialogRect.left) < 0.5 &&
    Math.abs(dialogRect.width - window.innerWidth) < 0.5 &&
    Math.abs(dialogRect.height - window.innerHeight) < 0.5 &&
    style.borderWidth === '0px' && style.borderRadius === '0px' &&
    getComputedStyle(body).overflowY === 'auto' && sectionsUnclipped &&
    body.scrollHeight > body.clientHeight &&
    headRect.top >= dialogRect.top && footRect.bottom <= dialogRect.bottom;
})()" "mobile run launcher is not fullscreen with a pinned, scrollable body"
agent-browser eval "(() => { const body = document.querySelector('.run-launcher .og-dialog__body'); if (body) body.scrollTop = body.scrollHeight; })()" >/dev/null
assert_eval_true "(() => {
  const dialog = document.querySelector('.run-launcher');
  const head = dialog?.querySelector('.og-dialog__head');
  const body = dialog?.querySelector('.og-dialog__body');
  const foot = dialog?.querySelector('.og-dialog__foot');
  const before = window.__runLauncherMobilePinnedPositions;
  if (!dialog || !head || !body || !foot || !before || body.scrollTop <= 0) return false;
  return Math.abs(head.getBoundingClientRect().top - before.headTop) < 0.5 &&
    Math.abs(foot.getBoundingClientRect().top - before.footTop) < 0.5;
})()" "mobile run launcher did not scroll with pinned header and footer"
agent-browser press Escape
agent-browser set device "iPhone 14"

log "Checking mobile install targets"
agent-browser open "$APP_URL/skills?lib=org&skill=$SMOKE_SKILL"
assert_body_contains "$SMOKE_SKILL"
wait_for_contextual_action "Install skill" "Install"
agent-browser find role button click --name "Install skill"
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
