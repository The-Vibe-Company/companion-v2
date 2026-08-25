#!/usr/bin/env bash
# Build the self-hosted Pi bundle: one content-addressed tarball carrying the exact Pi runtime, the
# four pinned Pi extensions, and the semantic-search binary. A Box laid out from this bundle never
# installs anything from a public npm registry at boot; it downloads and checksum-verifies this
# artifact instead. The pins come from packages/box-runtime/src/piBundle.ts (the single source), so a
# bundle can never disagree with what the runtime writes into the download-and-verify script.
#
# Output layout inside the tarball (what the setup script extracts into the Box's dist dir):
#   pi/           npm --global --prefix tree holding bin/pi
#   pi-agent-dir/ PI_CODING_AGENT_DIR with the four extensions installed
#   tools/        npm --global --prefix tree holding bin/qmd
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${1:-$repo_root/dist/pi-bundle}"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

# Read the pins from piBundle.ts so this build matches the runtime's pin exactly.
manifest="$(pnpm --filter @companion/api exec tsx "$repo_root/scripts/print-pi-bundle-manifest.ts")"
eval "$manifest"
: "${PI_BUNDLE_PI_PACKAGE:?}" "${PI_BUNDLE_EXTENSIONS:?}" "${PI_BUNDLE_QMD_PACKAGE:?}" "${PI_BUNDLE_NODE_MAJOR:?}" "${PI_BUNDLE_OBJECT_PREFIX:?}"

# Refuse to build on the wrong Node major: a native addon compiled here would not load on the Box.
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" != "$PI_BUNDLE_NODE_MAJOR" ]; then
  echo "build-pi-bundle: runner Node major is $node_major but the bundle pins $PI_BUNDLE_NODE_MAJOR" >&2
  exit 1
fi

staging="$(mktemp -d)"
cleanup() { rm -rf "$staging"; }
trap cleanup EXIT

pi_prefix="$staging/pi"
agent_dir="$staging/pi-agent-dir"
tools_prefix="$staging/tools"
mkdir -p "$pi_prefix" "$agent_dir" "$tools_prefix"

echo "build-pi-bundle: installing $PI_BUNDLE_PI_PACKAGE"
npm install --global --prefix "$pi_prefix" "$PI_BUNDLE_PI_PACKAGE"

pi_bin="$pi_prefix/bin/pi"
if [ ! -x "$pi_bin" ]; then
  echo "build-pi-bundle: pi binary was not installed at $pi_bin" >&2
  exit 1
fi

# shellcheck disable=SC2086 # PI_BUNDLE_EXTENSIONS is a deliberately space-separated pin list.
for spec in $PI_BUNDLE_EXTENSIONS; do
  echo "build-pi-bundle: installing extension $spec"
  PI_CODING_AGENT_DIR="$agent_dir" "$pi_bin" install "$spec"
done

echo "build-pi-bundle: installing $PI_BUNDLE_QMD_PACKAGE"
npm install --global --prefix "$tools_prefix" "$PI_BUNDLE_QMD_PACKAGE"

# Smoke: Pi runs, every extension landed, and qmd is present (its help stays best-effort like at boot).
"$pi_bin" --version
# shellcheck disable=SC2086 # Same deliberate word-splitting of the pin list.
for spec in $PI_BUNDLE_EXTENSIONS; do
  name="${spec#npm:}"
  name="${name%@*}"
  if [ -z "$(find "$agent_dir" -maxdepth 4 -name "*${name}*" -print -quit 2>/dev/null)" ]; then
    echo "build-pi-bundle: extension $name is missing from the agent dir" >&2
    exit 1
  fi
done
"$tools_prefix/bin/qmd" --help >/dev/null 2>&1 || true

mkdir -p "$out_dir"
tarball="$out_dir/companion-pi-bundle.tar.gz"
# --sort=name and a fixed mtime keep the archive reproducible so the same inputs hash the same.
tar --sort=name --mtime="@0" --owner=0 --group=0 --numeric-owner \
  -czf "$tarball" -C "$staging" pi pi-agent-dir tools 2>/dev/null \
  || tar -czf "$tarball" -C "$staging" pi pi-agent-dir tools

sha="$(sha256_of "$tarball")"
sha_short="${sha:0:12}"
# The published key lives under the pi-bundles/ prefix of the skill-archives bucket; the local
# artifact keeps the flat name.
artifact_name="companion-pi-bundle-${sha_short}.tar.gz"
object_key="${PI_BUNDLE_OBJECT_PREFIX}/${artifact_name}"
final="$out_dir/$artifact_name"
mv "$tarball" "$final"

echo "build-pi-bundle: built $final"
echo "build-pi-bundle: sha256=$sha"
echo "build-pi-bundle: object-key=$object_key"
echo "build-pi-bundle: update packages/box-runtime/src/piBundle.ts COMPANION_PI_BUNDLE.sha256 to $sha"

# Expose the results to a CI job via the step output file, when present.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "sha256=$sha"
    echo "object_key=$object_key"
    echo "tarball=$final"
  } >> "$GITHUB_OUTPUT"
fi
