#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bash -n scripts/dev-stack.sh scripts/setup-conductor.sh scripts/dev-conductor.sh scripts/dev-stack-check.sh

# Conductor setup must select the native package manager before installing JS
# dependencies. Exercise both branches with command shims so this remains safe
# on CI hosts that have neither Homebrew nor dnf.
(
  mkdir -p "$ROOT/.context"
  setup_test_dir="$(mktemp -d "$ROOT/.context/conductor-setup-test.XXXXXX")"
  trap 'rm -rf "$setup_test_dir"' EXIT
  mkdir -p "$setup_test_dir/bin"

  if ! grep -Fxq 'setup = "bash scripts/setup-conductor.sh"' "$ROOT/.conductor/settings.toml"; then
    printf '[dev-stack-check] Conductor settings must invoke scripts/setup-conductor.sh\n' >&2
    exit 1
  fi

  for command_name in sudo dnf brew corepack pnpm; do
    # The shim must expand these variables when Conductor's setup invokes it.
    # shellcheck disable=SC2016
    printf '%s\n' '#!/usr/bin/env bash' \
      'printf "%s %s\\n" "$(basename "$0")" "$*" >>"$CONDUCTOR_SETUP_CALLS"' \
      >"$setup_test_dir/bin/$command_name"
    chmod +x "$setup_test_dir/bin/$command_name"
  done

  cloud_calls="$setup_test_dir/cloud-calls"
  env PATH="$setup_test_dir/bin:$PATH" CONDUCTOR_IS_LOCAL=0 \
    CONDUCTOR_SETUP_CALLS="$cloud_calls" bash "$ROOT/scripts/setup-conductor.sh"
  if [ "$(cat "$cloud_calls")" != "$(printf '%s\n' \
    'sudo dnf install -y lsof postgresql17 postgresql17-server' \
    'corepack enable' \
    'pnpm install')" ]; then
    printf '[dev-stack-check] unexpected cloud Conductor setup calls:\n%s\n' \
      "$(cat "$cloud_calls")" >&2
    exit 1
  fi

  local_calls="$setup_test_dir/local-calls"
  env PATH="$setup_test_dir/bin:$PATH" CONDUCTOR_IS_LOCAL=1 \
    CONDUCTOR_SETUP_CALLS="$local_calls" bash "$ROOT/scripts/setup-conductor.sh"
  if [ "$(cat "$local_calls")" != "$(printf '%s\n' \
    'brew install postgresql@17' \
    'brew install minio mailpit' \
    'corepack enable' \
    'pnpm install')" ]; then
    printf '[dev-stack-check] unexpected local Conductor setup calls:\n%s\n' \
      "$(cat "$local_calls")" >&2
    exit 1
  fi
)

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  config="$(
    env -u CONDUCTOR_PORT -u CONDUCTOR_WORKSPACE_NAME \
    COMPOSE_BIND_HOST=127.0.0.1 \
    POSTGRES_PORT=15432 \
    MINIO_PORT=19000 \
    MINIO_CONSOLE_PORT=19001 \
    MAILPIT_SMTP_PORT=11025 \
    MAILPIT_WEB_PORT=18025 \
    docker compose config
  )"

  require_config() {
    local expected="$1"
    if ! printf '%s\n' "$config" | grep -Fq "$expected"; then
      printf '[dev-stack-check] Missing expected Compose config: %s\n' "$expected" >&2
      exit 1
    fi
  }

  require_config "host_ip: 127.0.0.1"
  require_config 'published: "15432"'
  require_config "target: 5432"
  require_config 'published: "19000"'
  require_config "target: 9000"
  require_config 'published: "19001"'
  require_config "target: 9001"
  require_config 'published: "11025"'
  require_config "target: 1025"
  require_config 'published: "18025"'
  require_config "target: 8025"
else
  printf '[dev-stack-check] SKIP Docker Compose config checks (docker compose unavailable)\n'
fi

env_output="$(
  env -u CONDUCTOR_PORT -u CONDUCTOR_WORKSPACE_NAME \
  -u COMPOSE_PROJECT_NAME \
  -u DATABASE_URL \
  -u DATABASE_WORKER_URL \
  -u COMPANION_API_URL \
  -u COMPANION_WEB_URL \
  -u NEXT_PUBLIC_COMPANION_API_URL \
  -u BETTER_AUTH_URL \
  -u S3_ENDPOINT \
  -u COMPANION_SKILL_DATABASES_ENABLED \
  POSTGRES_PORT=15432 \
  COMPANION_API_PORT=13001 \
  COMPANION_WEB_PORT=13000 \
  MINIO_PORT=19000 \
  COMPANION_DEV_SKIP_ENV_FILE=1 \
  bash scripts/dev-stack.sh print-env
)"

require_env() {
  local expected="$1"
  if ! printf '%s\n' "$env_output" | grep -Fxq "$expected"; then
    printf '[dev-stack-check] Missing expected env output: %s\n' "$expected" >&2
    exit 1
  fi
}

require_env "DATABASE_URL=postgres://companion_api:companion-api@127.0.0.1:15432/companion"
require_env "DATABASE_WORKER_URL=postgres://companion_worker:companion-worker@127.0.0.1:15432/companion"
require_env "COMPANION_API_URL=http://127.0.0.1:13001"
require_env "COMPANION_WEB_URL=http://127.0.0.1:13000"
require_env "NEXT_PUBLIC_COMPANION_API_URL=http://127.0.0.1:13001"
require_env "BETTER_AUTH_URL=http://127.0.0.1:13001"
require_env "S3_ENDPOINT=http://127.0.0.1:19000"
require_env "COMPANION_SKILL_DATABASES_ENABLED=true"

disabled_database_env_output="$(
  env -u CONDUCTOR_PORT -u CONDUCTOR_WORKSPACE_NAME \
  COMPANION_DEV_SKIP_ENV_FILE=1 \
  COMPANION_SKILL_DATABASES_ENABLED=false \
  bash scripts/dev-stack.sh print-env
)"
if ! printf '%s\n' "$disabled_database_env_output" | grep -Fxq "COMPANION_SKILL_DATABASES_ENABLED=false"; then
  printf '[dev-stack-check] an explicit local database feature opt-out must be preserved\n' >&2
  exit 1
fi

conductor_env_output="$(
  env -u COMPOSE_PROJECT_NAME \
  -u DATABASE_URL \
  -u DATABASE_WORKER_URL \
  -u COMPANION_API_URL \
  -u COMPANION_WEB_URL \
  -u NEXT_PUBLIC_COMPANION_API_URL \
  -u BETTER_AUTH_URL \
  -u S3_ENDPOINT \
  -u COMPANION_SKILL_DATABASES_ENABLED \
  CONDUCTOR_PORT=55100 \
  CONDUCTOR_WORKSPACE_NAME=montpellier-v1 \
  bash scripts/dev-stack.sh print-env
)"

require_conductor_env() {
  local expected="$1"
  if ! printf '%s\n' "$conductor_env_output" | grep -Fxq "$expected"; then
    printf '[dev-stack-check] Missing expected Conductor env output: %s\n' "$expected" >&2
    exit 1
  fi
}

require_conductor_env "COMPOSE_PROJECT_NAME=companion-montpellier-v1"
require_conductor_env "DATABASE_URL=postgres://companion_api:companion-api@127.0.0.1:55102/companion"
require_conductor_env "DATABASE_WORKER_URL=postgres://companion_worker:companion-worker@127.0.0.1:55102/companion"
require_conductor_env "COMPANION_API_URL=http://127.0.0.1:55101"
require_conductor_env "COMPANION_WEB_URL=http://127.0.0.1:55100"
require_conductor_env "NEXT_PUBLIC_COMPANION_API_URL=http://127.0.0.1:55101"
require_conductor_env "BETTER_AUTH_URL=http://127.0.0.1:55101"
require_conductor_env "S3_ENDPOINT=http://127.0.0.1:55103"
require_conductor_env "COMPANION_SKILL_DATABASES_ENABLED=true"
require_conductor_env "POSTGRES_PORT=55102"
require_conductor_env "MINIO_PORT=55103"
require_conductor_env "MINIO_CONSOLE_PORT=55104"
require_conductor_env "MAILPIT_SMTP_PORT=55105"
require_conductor_env "MAILPIT_WEB_PORT=55106"

# The standalone `pnpm dev:app` path must not turn an absent database URL into DATABASE_URL="",
# because postgres.js interprets that as OS-user defaults instead of @companion/db's local fallback.
# Expansion is intentionally deferred to the child invoked by `bash -c`.
# shellcheck disable=SC2016
worker_url_unset="$(
  env -u DATABASE_URL -u DATABASE_WORKER_URL \
    bash "$ROOT/scripts/dev-worker.sh" \
    bash -c 'if [ "${DATABASE_URL+x}" = x ]; then printf %s "$DATABASE_URL"; else printf unset; fi'
)"
if [ "$worker_url_unset" != "unset" ]; then
  printf '[dev-stack-check] dev-worker must preserve an unset DATABASE_URL, got: %s\n' \
    "$worker_url_unset" >&2
  exit 1
fi

# Expansion is intentionally deferred to the child invoked by `bash -c`.
# shellcheck disable=SC2016
worker_url_inherited="$(
  env DATABASE_URL=postgres://api DATABASE_WORKER_URL= \
    bash "$ROOT/scripts/dev-worker.sh" bash -c 'printf %s "$DATABASE_URL"'
)"
if [ "$worker_url_inherited" != "postgres://api" ]; then
  printf '[dev-stack-check] dev-worker must inherit DATABASE_URL without a worker override\n' >&2
  exit 1
fi

# Expansion is intentionally deferred to the child invoked by `bash -c`.
# shellcheck disable=SC2016
worker_url_overridden="$(
  env DATABASE_URL=postgres://api DATABASE_WORKER_URL=postgres://worker \
    bash "$ROOT/scripts/dev-worker.sh" bash -c 'printf %s "$DATABASE_URL"'
)"
if [ "$worker_url_overridden" != "postgres://worker" ]; then
  printf '[dev-stack-check] dev-worker must prefer DATABASE_WORKER_URL\n' >&2
  exit 1
fi

# --- Native Conductor launcher (scripts/dev-conductor.sh) ------------------
# The Conductor run/archive path is native (no Docker). Port-range guards run
# before any service starts, so these reject-cases exit early with no side
# effects (nothing is initialised, no ports are bound, no .conductor-pg/).
assert_conductor_rejects() {
  local label="$1"
  shift
  if bash scripts/dev-conductor.sh "$@" >/dev/null 2>&1; then
    printf '[dev-stack-check] dev-conductor.sh should reject %s\n' "$label" >&2
    exit 1
  fi
}

assert_conductor_rejects "privileged base port" --base 100
assert_conductor_rejects "out-of-range base port" --base 70000
assert_conductor_rejects "non-numeric base port" --base notaport
assert_conductor_rejects "empty --base= value" --base=
assert_conductor_rejects "unknown argument" --bogus-flag

if ! bash scripts/dev-conductor.sh --help >/dev/null 2>&1; then
  printf '[dev-stack-check] dev-conductor.sh --help should exit 0\n' >&2
  exit 1
fi

# Cloud workspaces intentionally have no CONDUCTOR_PORT. The web listener must
# still be reachable by Conductor's port forward, while local workspaces remain
# loopback-only. Reverting the cloud bind to 127.0.0.1 makes this regression
# check fail without starting Postgres or any long-running process.
inspect_conductor_network() {
  local is_local="$1"
  local conductor_port="$2"
  shift 2
  if [ "$conductor_port" = "unset" ]; then
    # The inner shell must expand variables defined by the sourced launcher, not this process.
    # shellcheck disable=SC2016
    env -u CONDUCTOR_PORT CONDUCTOR_IS_LOCAL="$is_local" COMPANION_DEV_SKIP_ENV_FILE=1 \
      bash -c 'script="$1"; shift; source "$script" "$@"; printf "%s|%s|%s|%s" "$BASE" "$WEB_BIND_HOST" "$WEB_URL" "$API_URL"' \
      _ "$ROOT/scripts/dev-conductor.sh" "$@"
  else
    # The inner shell must expand variables defined by the sourced launcher, not this process.
    # shellcheck disable=SC2016
    env CONDUCTOR_PORT="$conductor_port" CONDUCTOR_IS_LOCAL="$is_local" COMPANION_DEV_SKIP_ENV_FILE=1 \
      bash -c 'script="$1"; shift; source "$script" "$@"; printf "%s|%s|%s|%s" "$BASE" "$WEB_BIND_HOST" "$WEB_URL" "$API_URL"' \
      _ "$ROOT/scripts/dev-conductor.sh" "$@"
  fi
}

cloud_network="$(inspect_conductor_network 0 unset)"
if [ "$cloud_network" != "3000|0.0.0.0|http://127.0.0.1:3000|http://127.0.0.1:3001" ]; then
  printf '[dev-stack-check] unexpected cloud Conductor network config: %s\n' "$cloud_network" >&2
  exit 1
fi

inspect_conductor_install_hints() {
  local is_local="$1"
  # The inner shell must read variables populated by the sourced launcher.
  # shellcheck disable=SC2016
  env CONDUCTOR_PORT=4310 CONDUCTOR_IS_LOCAL="$is_local" COMPANION_DEV_SKIP_ENV_FILE=1 \
    bash -c 'script="$1"; shift; source "$script"; printf "%s|%s" "$LSOF_INSTALL_HINT" "$POSTGRES_INSTALL_HINT"' \
    _ "$ROOT/scripts/dev-conductor.sh"
}

cloud_install_hints="$(inspect_conductor_install_hints 0)"
if [ "$cloud_install_hints" != "sudo dnf install -y lsof|sudo dnf install -y postgresql17 postgresql17-server" ]; then
  printf '[dev-stack-check] unexpected cloud Conductor install hints: %s\n' \
    "$cloud_install_hints" >&2
  exit 1
fi

local_install_hints="$(inspect_conductor_install_hints 1)"
if [ "$local_install_hints" != "brew install lsof|brew install postgresql@17" ]; then
  printf '[dev-stack-check] unexpected local Conductor install hints: %s\n' \
    "$local_install_hints" >&2
  exit 1
fi

local_network="$(inspect_conductor_network 1 4310)"
if [ "$local_network" != "4310|127.0.0.1|http://127.0.0.1:4310|http://127.0.0.1:4311" ]; then
  printf '[dev-stack-check] unexpected local Conductor network config: %s\n' "$local_network" >&2
  exit 1
fi

cloud_override_network="$(inspect_conductor_network 0 4310 --base 4520)"
if [ "$cloud_override_network" != "4520|0.0.0.0|http://127.0.0.1:4520|http://127.0.0.1:4521" ]; then
  printf '[dev-stack-check] cloud --base must override CONDUCTOR_PORT: %s\n' "$cloud_override_network" >&2
  exit 1
fi

local_override_network="$(inspect_conductor_network 1 4310 --base 4530)"
if [ "$local_override_network" != "4530|127.0.0.1|http://127.0.0.1:4530|http://127.0.0.1:4531" ]; then
  printf '[dev-stack-check] local --base must override CONDUCTOR_PORT: %s\n' "$local_override_network" >&2
  exit 1
fi

# A duplicate launcher must fail before installing cleanup traps; otherwise its
# EXIT path can tear down the first launcher's native services.
(
  mkdir -p "$ROOT/.context"
  lock_test_dir="$(mktemp -d "$ROOT/.context/conductor-lock-test.XXXXXX")"
  lock_owner_pid=""
  # Invoked indirectly by the EXIT trap below.
  # shellcheck disable=SC2317,SC2329
  cleanup_lock_test() {
    if [ -n "$lock_owner_pid" ]; then
      kill "$lock_owner_pid" 2>/dev/null || true
      wait "$lock_owner_pid" 2>/dev/null || true
    fi
    rm -rf "$lock_test_dir"
  }
  trap cleanup_lock_test EXIT

  mkdir -p "$lock_test_dir/scripts" "$lock_test_dir/.conductor-pg"
  cp "$ROOT/scripts/dev-conductor.sh" "$lock_test_dir/scripts/dev-conductor.sh"
  cd "$lock_test_dir"
  # Keep bash as the long-lived process so `ps` retains the launcher marker.
  # Amazon Linux implements sleep through a coreutils multicall binary, which
  # discards the argv[0] marker used by `exec -a` on macOS.
  bash -c 'while :; do sleep 1; done' "bash scripts/dev-conductor.sh" &
  lock_owner_pid=$!
  ln -s "$lock_owner_pid" .conductor-pg/run.lock

  if duplicate_output="$(bash scripts/dev-conductor.sh --base 55900 2>&1)"; then
    printf '[dev-stack-check] duplicate Conductor launcher should fail\n' >&2
    exit 1
  fi
  case "$duplicate_output" in
    *"already starting or running"*) ;;
    *)
      printf '[dev-stack-check] duplicate launcher returned the wrong error: %s\n' \
        "$duplicate_output" >&2
      exit 1
      ;;
  esac
  case "$duplicate_output" in
    *"Shutting down"*)
      printf '[dev-stack-check] duplicate launcher must not run service cleanup\n' >&2
      exit 1
      ;;
  esac
  kill -0 "$lock_owner_pid"
)

printf '[dev-stack-check] OK\n'
