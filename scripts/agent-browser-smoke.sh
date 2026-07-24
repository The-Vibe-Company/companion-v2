#!/usr/bin/env bash
set -euo pipefail

APP_URL="${APP_URL:-http://127.0.0.1:${CONDUCTOR_PORT:-3000}}"
APP_URL="${APP_URL%/}"
DEFAULT_SMOKE_EMAIL="admin@tvc.dev"
DEFAULT_SMOKE_PASSWORD="adminadmin"
SMOKE_EMAIL="${BROWSER_SMOKE_EMAIL:-$DEFAULT_SMOKE_EMAIL}"
SMOKE_PASSWORD="${BROWSER_SMOKE_PASSWORD:-$DEFAULT_SMOKE_PASSWORD}"
SMOKE_SKILL="incident-summary"
SMOKE_SKILL_TITLE=""
SMOKE_SKILL_DIR=""
SMOKE_PROFILE=""
PROJECTS_UI_AVAILABLE=0
RUN_SKILL_SURFACE=""
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

wait_for_projects() {
  local body url ready

  for _ in $(seq 1 30); do
    url="$(agent-browser get url || true)"
    body="$(body_text || true)"
    ready="$(agent-browser eval "!!document.querySelector('.cowork-home')" || true)"
    if [[ "$url" == */projects* ]] && [ "$ready" = "true" ] && printf '%s' "$body" | grep -F "New project" >/dev/null; then
      return 0
    fi
    sleep 1
  done

  printf '[agent-browser-smoke] Timed out waiting for the Projects home\n' >&2
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

projects_switch_available() {
  local result
  result="$(
    agent-browser eval "(() => {
      const nav = document.querySelector('nav[aria-label=\"Workspace space\"]');
      if (!nav) return false;
      return Array.from(nav.querySelectorAll('a')).some((link) =>
        (link.textContent || '').trim() === 'Projects' &&
        new URL(link.href, location.href).pathname === '/projects'
      );
    })()" || true
  )"
  [ "$result" = "true" ]
}

assert_no_browser_errors() {
  local errors
  errors="$(agent-browser errors || true)"
  if [ -n "$errors" ]; then
    printf '[agent-browser-smoke] Browser errors detected:\n%s\n' "$errors" >&2
    exit 1
  fi
}

projects_desktop_smoke() {
  if ! projects_switch_available; then
    log "Projects switch not rendered; skipping feature-flagged Projects checks"
    return 0
  fi

  PROJECTS_UI_AVAILABLE=1
  log "Checking Skills | Projects workspace switch"
  assert_eval_true "(() => {
    const nav = document.querySelector('nav[aria-label=\"Workspace space\"]');
    const links = nav ? Array.from(nav.querySelectorAll('a')) : [];
    const labels = links.map((link) => (link.textContent || '').trim());
    const skills = links.find((link) => (link.textContent || '').trim() === 'Skills');
    const projects = links.find((link) => (link.textContent || '').trim() === 'Projects');
    return links.length === 2 && labels.join('|') === 'Skills|Projects' &&
      skills?.getAttribute('aria-current') === 'page' &&
      !projects?.hasAttribute('aria-current');
  })()" "Skills | Projects switch is missing or Skills is not active"
  assert_eval_true "(() => {
    const nav = document.querySelector('nav[aria-label=\"Workspace space\"]');
    const link = nav && Array.from(nav.querySelectorAll('a'))
      .find((candidate) => (candidate.textContent || '').trim() === 'Projects');
    if (!link) return false;
    link.click();
    return true;
  })()" "could not navigate to Projects from the workspace switch"
  wait_for_projects

  log "Checking Projects home controls"
  assert_eval_true "(() => {
    const nav = document.querySelector('nav[aria-label=\"Workspace space\"]');
    const links = nav ? Array.from(nav.querySelectorAll('a')) : [];
    const projects = links.find((link) => (link.textContent || '').trim() === 'Projects');
    return projects?.getAttribute('aria-current') === 'page' &&
      !!document.querySelector('.cowork-search input[placeholder=\"Search projects…\"]') &&
      !!document.querySelector('[role=\"group\"][aria-label=\"Filter projects by status\"]') &&
      !!document.querySelector('[role=\"table\"][aria-label=\"Projects\"]');
  })()" "Projects home is missing its active switch, search, filters, or table"
  assert_body_contains "Projects"
  assert_body_contains "New project"

  local can_create
  can_create="$(agent-browser eval "(() => {
    const button = document.querySelector('.cowork-page-head button');
    return !!button && !button.disabled;
  })()" || true)"
  if [ "$can_create" = "true" ]; then
    log "Checking New project dialog"
    assert_eval_true "(() => {
      const button = document.querySelector('.cowork-page-head button');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()" "could not open the New project dialog"
    wait_for_body_contains "A persistent space where sessions share files, skills and secrets."
    assert_eval_true "(() => {
      const dialog = document.querySelector('[role=\"dialog\"][aria-modal=\"true\"]');
      if (!dialog) return false;
      const labels = Array.from(dialog.querySelectorAll('.cds-field__label'))
        .map((label) => (label.textContent || '').trim());
      return dialog.querySelector('h2')?.textContent?.trim() === 'New project' &&
        labels.includes('Name') &&
        labels.includes('Default model') &&
        labels.includes('Skills to sync') &&
        !!dialog.querySelector('input[placeholder=\"e.g. Q4 planning\"]') &&
        !!dialog.querySelector('select') &&
        (dialog.textContent || '').includes(
          'Eligible secrets are checked and synced automatically at activation.'
        );
    })()" "New project dialog is missing name, model, skills, or secrets summary"
    agent-browser find role button click --name "Cancel"
    agent-browser wait 250
    assert_eval_true "!document.querySelector('[role=\"dialog\"][aria-modal=\"true\"]')" \
      "New project dialog did not close"
  else
    log "Projects runtime is offline; New project is correctly unavailable"
    assert_eval_true "document.querySelector('.cowork-page-head button')?.disabled === true" \
      "New project should be disabled while the Projects runtime is offline"
  fi

  assert_no_browser_errors
  assert_eval_true "(() => {
    const nav = document.querySelector('nav[aria-label=\"Workspace space\"]');
    const link = nav && Array.from(nav.querySelectorAll('a'))
      .find((candidate) => (candidate.textContent || '').trim() === 'Skills');
    if (!link) return false;
    link.click();
    return true;
  })()" "could not return to Skills from the workspace switch"
  wait_for_skills
  # The switch intentionally lands on the default Skills library. Restore the org fixture view
  # expected by the existing row, filter, detail, and drag checks below.
  agent-browser open "$APP_URL/skills?lib=org"
  wait_for_skills
}

projects_mobile_smoke() {
  if [ "$PROJECTS_UI_AVAILABLE" != "1" ]; then
    return 0
  fi

  log "Checking mobile Projects navigation"
  assert_eval_true "(() => {
    const nav = document.querySelector('nav[aria-label=\"Workspace space\"]');
    const projects = nav && Array.from(nav.querySelectorAll('a'))
      .find((candidate) => (candidate.textContent || '').trim() === 'Projects');
    if (!projects) return false;
    const rect = projects.getBoundingClientRect();
    return rect.width >= 44 && rect.height >= 44;
  })()" "collapsed mobile workspace switch is not a 44px touch target"
  assert_eval_true "(() => {
    const nav = document.querySelector('nav[aria-label=\"Workspace space\"]');
    const link = nav && Array.from(nav.querySelectorAll('a'))
      .find((candidate) => (candidate.textContent || '').trim() === 'Projects');
    if (!link) return false;
    link.click();
    return true;
  })()" "could not open Projects from the mobile workspace switch"
  wait_for_projects
  assert_eval_true "document.documentElement.scrollWidth <= document.documentElement.clientWidth" \
    "Projects home introduced horizontal overflow on mobile"
  assert_eval_true "!!document.querySelector('.projects-side:not(.side--mobile-open) nav[aria-label=\"Workspace space\"]')" \
    "Projects mobile rail or workspace switch is missing"

  agent-browser find role button click --name "Expand navigation"
  agent-browser wait 250
  assert_eval_true "(() => {
    const side = document.querySelector('.projects-side.side--mobile-open');
    const list = side?.querySelector('.projects-side__list');
    const nav = side?.querySelector('nav[aria-label=\"Workspace space\"]');
    if (!side || !list || !nav) return false;
    const labels = Array.from(nav.querySelectorAll('a'))
      .map((link) => (link.textContent || '').trim());
    return labels.join('|') === 'Skills|Projects' &&
      getComputedStyle(list).overflowY === 'auto' &&
      side.getBoundingClientRect().width <= window.innerWidth;
  })()" "expanded mobile Projects sidebar is missing the switch or scrollable project list"
  assert_eval_true "document.documentElement.scrollWidth <= document.documentElement.clientWidth" \
    "expanded Projects sidebar introduced horizontal overflow on mobile"
  agent-browser find role button click --name "Collapse navigation"
  agent-browser wait 200
  assert_eval_true "!document.querySelector('.projects-side.side--mobile-open')" \
    "Projects mobile sidebar did not collapse"
  assert_no_browser_errors

  assert_eval_true "(() => {
    const nav = document.querySelector('nav[aria-label=\"Workspace space\"]');
    const link = nav && Array.from(nav.querySelectorAll('a'))
      .find((candidate) => (candidate.textContent || '').trim() === 'Skills');
    if (!link) return false;
    link.click();
    return true;
  })()" "could not return to Skills from mobile Projects"
  wait_for_skills
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

# Opening a portal dialog can race a responsive/detail refresh in Next dev. Retry only until the
# feature-flagged Project picker or legacy launcher DOM is mounted; subsequent assertions still
# exercise the real dialog behavior.
open_run_launcher() {
  local result selector
  for _ in $(seq 1 10); do
    result="$(
      agent-browser eval "(() => {
        if (document.querySelector('.cowork-project-picker')) return 2;
        if (document.querySelector('.run-launcher')) return 1;
        return 0;
      })()" || true
    )"
    if [ "$result" = "2" ] || [ "$result" = "1" ]; then
      agent-browser wait 400 >/dev/null
      selector=".run-launcher"
      RUN_SKILL_SURFACE="legacy"
      if [ "$result" = "2" ]; then
        selector=".cowork-project-picker"
        RUN_SKILL_SURFACE="projects"
      fi
      if [ "$(agent-browser eval "!!document.querySelector('$selector')" || true)" = "true" ]; then
        # Chrome-for-Testing can leave CSS animations at virtual time 0 between CLI commands. Finish
        # only the mounted dialog's entrance animation before asserting its final geometry.
        agent-browser eval "document.querySelector('$selector')?.closest('[role=\"dialog\"]')?.getAnimations().forEach((animation) => animation.finish())" >/dev/null
        return 0
      fi
    fi
    click_button_text "Run skill"
    agent-browser wait 150 >/dev/null
  done
  printf '[agent-browser-smoke] Run launcher did not open after the detail became interactive\n' >&2
  agent-browser get url >&2 || true
  body_text >&2 || true
  exit 1
}

wait_for_project_run_picker() {
  local ready

  for _ in $(seq 1 30); do
    ready="$(
      agent-browser eval "(() => {
        const body = document.querySelector('.cowork-project-picker');
        if (!body || body.querySelector('.cowork-project-picker__loading')) return false;
        return !!body.querySelector('.cowork-project-picker__list[aria-label=\"Projects\"]') ||
          !!body.querySelector('.cowork-project-picker__empty');
      })()" || true
    )"
    if [ "$ready" = "true" ]; then
      return 0
    fi
    sleep 1
  done

  printf '[agent-browser-smoke] Timed out waiting for the Project run picker\n' >&2
  body_text >&2 || true
  exit 1
}

assert_project_run_picker_common() {
  local expected_title expected_title_js
  expected_title="Run $SMOKE_SKILL_TITLE"
  expected_title_js="$(json_string "$expected_title")"

  wait_for_project_run_picker
  assert_eval_true "(() => {
    const body = document.querySelector('.cowork-project-picker');
    const dialog = body?.closest('[role=\"dialog\"][aria-modal=\"true\"]');
    const footer = dialog?.querySelector('.cowork-project-picker__foot');
    const buttons = footer ? Array.from(footer.querySelectorAll('button')) : [];
    const cancel = buttons.find((button) => (button.textContent || '').trim() === 'Cancel');
    const create = buttons.find((button) => (button.textContent || '').trim() === 'New project');
    const list = body?.querySelector('.cowork-project-picker__list[aria-label=\"Projects\"]');
    const empty = body?.querySelector('.cowork-project-picker__empty');
    const projectState = list
      ? list.querySelectorAll(':scope > button').length > 0
      : !!empty && !(empty.textContent || '').includes('Projects could not be loaded.');
    const description = dialog?.querySelector('.cowork-dialog__head p');
    return dialog?.querySelector('h2')?.textContent?.trim() === ${expected_title_js} &&
      description?.textContent?.trim() ===
        'Choose the project whose files, skills and secrets this session should use.' &&
      projectState &&
      !!cancel &&
      !!create &&
      !!dialog.querySelector('button[aria-label=\"Close dialog\"]');
  })()" "Project run picker is missing its title, description, project list state, or actions"
}

project_run_picker_desktop_smoke() {
  log "Checking Project run picker at a short desktop viewport"
  assert_project_run_picker_common
  assert_eval_true "(() => {
    const body = document.querySelector('.cowork-project-picker');
    const dialog = body?.closest('[role=\"dialog\"]');
    const footer = dialog?.querySelector('.cowork-project-picker__foot');
    const rows = body
      ? Array.from(body.querySelectorAll('.cowork-project-picker__list > button'))
      : [];
    if (!body || !dialog || !footer) return false;
    const dialogRect = dialog.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    return dialogRect.top >= 0 &&
      dialogRect.left >= 0 &&
      dialogRect.right <= window.innerWidth &&
      dialogRect.bottom <= window.innerHeight &&
      footerRect.top >= dialogRect.top &&
      footerRect.bottom <= dialogRect.bottom &&
      body.scrollWidth <= body.clientWidth &&
      rows.every((row) => {
        const rect = row.getBoundingClientRect();
        return rect.height >= 44 &&
          rect.left >= dialogRect.left &&
          rect.right <= dialogRect.right;
      });
  })()" "Project run picker is not contained or its project choices are undersized on desktop"
  agent-browser press Escape
  agent-browser wait 200
  assert_eval_true "!document.querySelector('.cowork-project-picker')" \
    "Project run picker did not close without choosing a project"
}

project_run_picker_mobile_smoke() {
  log "Checking mobile Project run picker"
  assert_project_run_picker_common
  assert_eval_true "(() => {
    const body = document.querySelector('.cowork-project-picker');
    const dialog = body?.closest('[role=\"dialog\"]');
    const rows = body
      ? Array.from(body.querySelectorAll('.cowork-project-picker__list > button'))
      : [];
    if (!body || !dialog) return false;
    const dialogRect = dialog.getBoundingClientRect();
    return Math.abs(dialogRect.left) < 0.5 &&
      Math.abs(dialogRect.width - window.innerWidth) < 0.5 &&
      dialogRect.top >= 0 &&
      dialogRect.bottom <= window.innerHeight + 0.5 &&
      document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
      body.scrollWidth <= body.clientWidth &&
      rows.every((row) => {
        const rect = row.getBoundingClientRect();
        return rect.width >= 44 &&
          rect.height >= 44 &&
          rect.left >= dialogRect.left &&
          rect.right <= dialogRect.right;
      });
  })()" "mobile Project run picker is not contained or its project choices are not touch targets"
  agent-browser press Escape
  agent-browser wait 200
  assert_eval_true "!document.querySelector('.cowork-project-picker')" \
    "mobile Project run picker did not close without choosing a project"
}

# Center point (x y) of an element's bounding box, from real layout.
box_center() {
  # A skill can legitimately appear in more than one label group. `agent-browser get box` resolves
  # a CSS selector to its first laid-out match; its Playwright-only `:nth-match()` syntax is not
  # accepted consistently across CLI releases.
  agent-browser get box "$1" --json | node scripts/agent-browser-box-center.mjs
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
  src_sel=".crow[data-skill-slug=\"${SMOKE_SKILL}\"] .crow__hit"
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
  local api profile info_json
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

  if ! info_json="$(pnpm --silent --filter @companion/cli dev --json skills info "$SMOKE_SKILL" --profile "$profile")"; then
    printf '[agent-browser-smoke] Could not resolve the prepared skill title\n' >&2
    exit 1
  fi
  SMOKE_SKILL_TITLE="$(printf '%s' "$info_json" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const skill = JSON.parse(input);
      const title = typeof skill.display?.name === "string" ? skill.display.name.trim() : "";
      process.stdout.write(title || skill.slug);
    });
  ')"
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
sleep 1
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
# List identity is intentionally the stable slug; the human title remains detail-only.
assert_body_contains "$SMOKE_SKILL"
assert_body_contains "Add skill"
# Shared label folder tree (replaces the old owner/visibility sidebar): the smoke skill is filed under "engineering".
assert_body_contains "engineering"

projects_desktop_smoke

log "Checking contextual row-action alignment"
for width in 1024 760; do
  agent-browser set viewport "$width" 800
  agent-browser wait 150
  assert_eval_true "(() => {
    const header = document.querySelector('.clist .chead span:last-child');
    const cells = Array.from(document.querySelectorAll('.clist .crow > .crow__primary'));
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
  const button = document.querySelector('.crow[data-skill-slug=\"$SMOKE_SKILL\"] .rowact--primary');
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
assert_eval_true "(() => {
  const button = document.querySelector('.crow[data-skill-slug=\"$SMOKE_SKILL\"] .crow__hit');
  if (!button) return false;
  button.click();
  return true;
})()" "could not open the smoke skill by its stable slug"
agent-browser wait 1000
assert_body_contains "$SMOKE_SKILL_TITLE"
wait_for_contextual_action "Install skill" "Install"

log "Checking run launcher scrolling at a short desktop viewport"
agent-browser set viewport 1024 420
# Reload the deep link after the viewport transition. This gives the layout and the browser's
# connection pool one settled navigation before the launcher issues its Strict Mode option reads.
agent-browser open "$APP_URL/skills?lib=org&skill=$SMOKE_SKILL"
wait_for_contextual_action "Install skill" "Install"
open_run_launcher
if [ "$RUN_SKILL_SURFACE" = "projects" ]; then
  project_run_picker_desktop_smoke
else
  wait_for_body_contains "Configuration"
  agent-browser wait 300
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
  agent-browser wait 200
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
fi
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

projects_mobile_smoke

log "Checking mobile run launcher"
agent-browser set viewport 390 420
agent-browser open "$APP_URL/skills?lib=org&skill=$SMOKE_SKILL"
wait_for_contextual_action "Install skill" "Install"
open_run_launcher
if [ "$RUN_SKILL_SURFACE" = "projects" ]; then
  project_run_picker_mobile_smoke
else
  wait_for_body_contains "Configuration"
  agent-browser wait 300
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
  agent-browser wait 200
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
fi
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
