/**
 * The self-hosted, content-addressed Pi bundle.
 *
 * A Box laid out from a bundle never installs anything from a public npm registry at boot: instead of
 * `npm i -g` plus four `pi install` runs plus a qmd install (`setupScript()` in
 * `boxCompanionRuntime.ts`), the layout script downloads one immutable tarball we built and published
 * ourselves, verifies its checksum, and extracts it. The tarball carries the exact Pi runtime, the
 * four pinned extensions, and the semantic-search binary, so what a Box gets no longer depends on
 * what a registry serves the minute it happens to boot.
 *
 * These pins are the single product source for the bundle, mirroring how `PI_PACKAGES` is a product
 * decision rather than a deployment's to make. The build pipeline (`scripts/build-pi-bundle.sh` and
 * `.github/workflows/pi-bundle.yml`) reads them to build the artifact; `boxCompanionRuntime.ts` reads
 * them to write the download-and-verify script and to fold the bundle identity into the base layout
 * marker so a new bundle relayouts every warm Box on its next wake.
 *
 * Bundle mode is off unless `COMPANION_PI_BUNDLE_BASE_URL` is set. When it is off, the layout script
 * keeps installing Pi with `COMPANION_PI_INSTALL_COMMAND` exactly as it does today, so the escape
 * hatch that production currently relies on is never removed by this file.
 */

/**
 * Placeholder checksum until the CI pipeline builds and publishes the first real artifact to the
 * `companion-pi-bundles` bucket. While this value is set, bundle mode still generates a fully valid
 * download-and-verify script — but the artifact guard (`scripts/check-pi-bundle-artifact.ts`) skips
 * its S3 HEAD so a pin can land in the repository before the artifact it names exists.
 *
 * TODO(pi-bundle): replace with the sha256 printed by `scripts/build-pi-bundle.sh` once the artifact
 * is published, and delete this placeholder. The guard then enforces "no pin without an artifact".
 */
export const PI_BUNDLE_PLACEHOLDER_SHA256 =
  "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * The npm package that ships the Pi coding agent. It is the same package the escape-hatch install
 * command installs (`npm i -g @earendil-works/pi-coding-agent@<piVersion>`); the bundle build reads
 * it so the pinned Pi in the tarball is exactly the pinned Pi in install mode.
 */
export const COMPANION_PI_NPM_PACKAGE = "@earendil-works/pi-coding-agent";

export interface CompanionPiBundleManifest {
  /** The Pi coding agent version baked into the bundle. Matches the npm-mode pin. */
  readonly piVersion: string;
  /** Every pinned Pi extension the bundle carries, adapter first. Matches the npm-mode set. */
  readonly packages: readonly string[];
  /** The semantic-search binary pin, recorded so the build script and marker agree on it. */
  readonly qmdPackage: string;
  /**
   * The Node major the bundle was built against. The Box image supplies Node; the layout script
   * refuses a Box whose Node major differs, because a native addon compiled for another major does
   * not load. The spike measured Node v24 on a fresh Box; the build workflow pins the same major.
   */
  readonly nodeMajor: number;
  /** The sha256 of the published tarball. The object key and the checksum verification derive here. */
  readonly sha256: string;
  /** Bumped when the tarball's internal directory layout changes so old and new never mix. */
  readonly bundleFormat: number;
}

/**
 * The pinned bundle. These exact versions mirror the npm-mode pins in `boxCompanionRuntime.ts`
 * (`DEFAULT_PI_MCP_ADAPTER_PACKAGE`, `PI_PACKAGES`, `QMD_PACKAGE`, `MINIMUM_IMAGE_SAFE_PI_VERSION`):
 * a bundle that shipped a different set would give a Companion abilities its thread and instructions
 * disagree with.
 */
export const COMPANION_PI_BUNDLE = {
  piVersion: "0.84.2",
  packages: [
    "npm:pi-mcp-adapter@2.12.1",
    "npm:pi-web-access@0.24.0",
    "npm:pi-subagents@0.51.0",
    "npm:pi-memory@0.4.2",
  ],
  qmdPackage: "npm:@tobilu/qmd@2.8.3",
  nodeMajor: 24,
  sha256: PI_BUNDLE_PLACEHOLDER_SHA256,
  bundleFormat: 1,
} as const satisfies CompanionPiBundleManifest;

/** Stable stderr markers the layout script prints as its last line, mapped to persistable codes. */
export const COMPANION_PI_BUNDLE_FAILURE_MARKERS = {
  "companion-bundle-download-failed": "pi_bundle_download_failed",
  "companion-bundle-checksum-mismatch": "pi_bundle_checksum_mismatch",
  "companion-bundle-node-mismatch": "pi_bundle_node_mismatch",
} as const;

export type CompanionPiBundleFailureCode =
  (typeof COMPANION_PI_BUNDLE_FAILURE_MARKERS)[keyof typeof COMPANION_PI_BUNDLE_FAILURE_MARKERS];

/** True while the pin still points at the placeholder — the artifact guard skips its HEAD then. */
export function isPiBundleShaPlaceholder(sha: string = COMPANION_PI_BUNDLE.sha256): boolean {
  return sha === PI_BUNDLE_PLACEHOLDER_SHA256 || /^0+$/.test(sha);
}

/** The 12-hex-character short digest that names the on-disk dist directory and the object key. */
export function companionPiBundleShaShort(sha: string = COMPANION_PI_BUNDLE.sha256): string {
  return sha.slice(0, 12);
}

/**
 * The content-addressed object key. The checksum lives in the name, so a HEAD tells CI whether this
 * pin is already published and a Box downloading it can never silently get a different artifact.
 */
export function companionPiBundleObjectKey(sha: string = COMPANION_PI_BUNDLE.sha256): string {
  return `companion-pi-bundle-${companionPiBundleShaShort(sha)}.tar.gz`;
}

/**
 * Read the bundle download base URL. Undefined turns bundle mode off and the layout script falls back
 * to `COMPANION_PI_INSTALL_COMMAND`. The value is never hardcoded: it is a deployment input pointing
 * at the public `companion-pi-bundles` bucket (Tigris `fly.storage.tigris.dev`, or any S3-compatible
 * public host), and only the pinned checksum, not the host, is trusted.
 */
export function piBundleBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.COMPANION_PI_BUNDLE_BASE_URL?.trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}

/** Everything the layout script needs to download, verify, and place one bundle. */
export interface CompanionPiBundlePlan {
  readonly baseUrl: string;
  readonly objectKey: string;
  readonly manifest: CompanionPiBundleManifest;
}

/** Resolve the active bundle plan, or null when bundle mode is off. */
export function companionPiBundlePlan(
  env: NodeJS.ProcessEnv = process.env,
  manifest: CompanionPiBundleManifest = COMPANION_PI_BUNDLE,
): CompanionPiBundlePlan | null {
  const baseUrl = piBundleBaseUrl(env);
  if (!baseUrl) return null;
  return { baseUrl, objectKey: companionPiBundleObjectKey(manifest.sha256), manifest };
}

/** Map a Box layout stderr line to its persistable bundle failure code, or null. */
export function piBundleFailureCodeFromOutput(
  output: string | undefined,
): CompanionPiBundleFailureCode | null {
  if (!output) return null;
  const lines = output.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
  const markers = Object.entries(COMPANION_PI_BUNDLE_FAILURE_MARKERS);
  for (const line of lines.reverse()) {
    for (const [marker, code] of markers) {
      if (marker === line) return code;
    }
  }
  return null;
}
