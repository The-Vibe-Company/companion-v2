#!/usr/bin/env bash
set -euo pipefail

MINIMUM_VERSION="2.7.0"
HOMEBREW_FORMULA="getsentry/xcodebuildmcp/xcodebuildmcp"
divergent_config=false

if [ "$(uname -s)" != "Darwin" ]; then
  printf '[mobile-mcp] XcodeBuildMCP requires macOS and Xcode.\n' >&2
  exit 1
fi

command -v xcodebuild >/dev/null 2>&1 || {
  printf '[mobile-mcp] Full Xcode and its command-line tools are required.\n' >&2
  exit 1
}
if ! xcodebuild -version >/dev/null 2>&1; then
  printf '[mobile-mcp] Xcode is not ready. Select the full Xcode installation with xcode-select.\n' >&2
  exit 1
fi
command -v xcrun >/dev/null 2>&1 || {
  printf '[mobile-mcp] Xcode Simulator tooling is unavailable. Install a simulator runtime in Xcode.\n' >&2
  exit 1
}
if ! xcrun simctl help >/dev/null 2>&1; then
  printf '[mobile-mcp] Xcode Simulator tooling is unavailable. Install a simulator runtime in Xcode.\n' >&2
  exit 1
fi

trust_formula() {
  if brew help trust >/dev/null 2>&1; then
    brew trust --formula "$HOMEBREW_FORMULA"
  fi
}

if ! command -v xcodebuildmcp >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || {
    printf '[mobile-mcp] Homebrew is required to install XcodeBuildMCP.\n' >&2
    exit 1
  }
  brew tap getsentry/xcodebuildmcp
  trust_formula
  brew install "$HOMEBREW_FORMULA"
fi

version_is_supported() {
  node -e '
    const [current, minimum] = process.argv.slice(1).map((value) => value.split(".").map(Number));
    for (let index = 0; index < Math.max(current.length, minimum.length); index += 1) {
      if ((current[index] ?? 0) > (minimum[index] ?? 0)) process.exit(0);
      if ((current[index] ?? 0) < (minimum[index] ?? 0)) process.exit(1);
    }
  ' "$1" "$MINIMUM_VERSION"
}

raw_version="$(xcodebuildmcp --version)"
if [[ "$raw_version" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
  current_version="${BASH_REMATCH[1]}"
else
  printf '[mobile-mcp] Could not parse the installed XcodeBuildMCP version: %s\n' "$raw_version" >&2
  exit 1
fi
if ! version_is_supported "$current_version"; then
  printf '[mobile-mcp] Upgrading XcodeBuildMCP %s to a supported release.\n' "$current_version"
  if command -v brew >/dev/null 2>&1 && brew list --versions xcodebuildmcp >/dev/null 2>&1; then
    trust_formula
    brew upgrade "$HOMEBREW_FORMULA"
  else
    xcodebuildmcp upgrade --yes
  fi
  raw_version="$(xcodebuildmcp --version)"
  if [[ "$raw_version" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    current_version="${BASH_REMATCH[1]}"
  else
    printf '[mobile-mcp] Could not parse the upgraded XcodeBuildMCP version: %s\n' "$raw_version" >&2
    exit 1
  fi
  if ! version_is_supported "$current_version"; then
    printf '[mobile-mcp] XcodeBuildMCP %s or newer is required; found %s.\n' \
      "$MINIMUM_VERSION" "$current_version" >&2
    exit 1
  fi
fi

configure_codex() {
  if ! command -v codex >/dev/null 2>&1; then
    printf '[mobile-mcp] Codex is not installed; skipping its MCP configuration.\n'
    return
  fi

  if codex mcp get XcodeBuildMCP >/dev/null 2>&1; then
    local config
    config="$(codex mcp get XcodeBuildMCP --json 2>/dev/null)"
    if printf '%s' "$config" | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        try {
          const config = JSON.parse(input);
          const transport = config.transport;
          if (
            transport?.type !== "stdio" ||
            transport.command !== "xcodebuildmcp" ||
            JSON.stringify(transport.args) !== JSON.stringify(["mcp"])
          ) process.exit(1);
        } catch {
          process.exit(1);
        }
      });
    '; then
      printf '[mobile-mcp] Codex already has XcodeBuildMCP configured.\n'
    else
      printf '[mobile-mcp] Codex has a different XcodeBuildMCP configuration; leaving it intact.\n' >&2
      divergent_config=true
    fi
  else
    codex mcp add XcodeBuildMCP -- xcodebuildmcp mcp
    printf '[mobile-mcp] Added XcodeBuildMCP to Codex.\n'
  fi
}

configure_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    printf '[mobile-mcp] Claude Code is not installed; skipping its MCP configuration.\n'
    return
  fi

  if claude mcp get XcodeBuildMCP >/dev/null 2>&1; then
    local config
    config="$(claude mcp get XcodeBuildMCP 2>&1)"
    if grep -Fxq '  Type: stdio' <<<"$config" && \
      grep -Fxq '  Command: xcodebuildmcp' <<<"$config" && \
      grep -Fxq '  Args: mcp' <<<"$config"; then
      printf '[mobile-mcp] Claude Code already has XcodeBuildMCP configured.\n'
    else
      printf '[mobile-mcp] Claude Code has a different XcodeBuildMCP configuration; leaving it intact.\n' >&2
      divergent_config=true
    fi
  else
    claude mcp add --scope user XcodeBuildMCP -- xcodebuildmcp mcp
    printf '[mobile-mcp] Added XcodeBuildMCP to Claude Code.\n'
  fi
}

configure_codex
configure_claude

if [ "$divergent_config" = true ]; then
  printf '[mobile-mcp] Resolve the divergent MCP configuration manually, then run this command again.\n' >&2
  exit 1
fi

printf '[mobile-mcp] Ready with XcodeBuildMCP %s. Refresh MCP status in Conductor, then start a new agent session.\n' \
  "$current_version"
