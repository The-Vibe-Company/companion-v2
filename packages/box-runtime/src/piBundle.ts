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
 * Bundle mode is off unless `COMPANION_PI_BUNDLE_ENABLED=true`. When it is off, the layout script
 * keeps installing Pi with `COMPANION_PI_INSTALL_COMMAND` exactly as it does today, so the escape
 * hatch that production currently relies on is never removed by this file. The artifact lives in
 * the existing skill-archives bucket under the `pi-bundles/` prefix — never a public bucket — and
 * the Box downloads it through a presigned GET URL that `apps/runtime` mints fresh for each layout
 * script generation. This module owns only the object key and the pins; it never sees a URL.
 */

/**
 * Placeholder checksum until the CI pipeline builds and publishes the first real artifact under the
 * `pi-bundles/` prefix of the skill-archives bucket. While this value is set, bundle mode still
 * generates a fully valid download-and-verify script — but the artifact guard
 * (`scripts/check-pi-bundle-artifact.ts`) skips its S3 HEAD so a pin can land in the repository
 * before the artifact it names exists.
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
 * The prefix that keeps Pi bundle artifacts a distinct object family inside the shared
 * skill-archives bucket, next to `companion-attachments/`, `orgs/`, and the per-org archive trees.
 */
export const PI_BUNDLE_OBJECT_PREFIX = "pi-bundles";

/**
 * The content-addressed object key inside the skill-archives bucket. The checksum lives in the
 * name, so a HEAD tells CI whether this pin is already published and a Box downloading it can never
 * silently get a different artifact.
 */
export function companionPiBundleObjectKey(sha: string = COMPANION_PI_BUNDLE.sha256): string {
  return `${PI_BUNDLE_OBJECT_PREFIX}/companion-pi-bundle-${companionPiBundleShaShort(sha)}.tar.gz`;
}

/**
 * Whether the deployment has switched bundle mode on. The gate is an explicit flag rather than an
 * inference from the pin or from S3 credentials: the runtime always holds S3 credentials for skill
 * archives, and inferring from a non-placeholder sha would silently flip every deployment the
 * moment a pin lands, taking away the operational off switch. `COMPANION_PI_BUNDLE_ENABLED=true`
 * is that switch; anything else keeps the `COMPANION_PI_INSTALL_COMMAND` escape hatch.
 */
export function piBundleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMPANION_PI_BUNDLE_ENABLED?.trim() === "true";
}

/**
 * Everything the layout script needs to verify and place one bundle. Deliberately no URL: the
 * download URL is a short-lived presigned GET minted by `apps/runtime` per script generation, so it
 * is an input to the script, never part of this env-derived plan.
 */
export interface CompanionPiBundlePlan {
  readonly objectKey: string;
  readonly manifest: CompanionPiBundleManifest;
}

/** Resolve the active bundle plan, or null when bundle mode is off. */
export function companionPiBundlePlan(
  env: NodeJS.ProcessEnv = process.env,
  manifest: CompanionPiBundleManifest = COMPANION_PI_BUNDLE,
): CompanionPiBundlePlan | null {
  if (!piBundleEnabled(env)) return null;
  return { objectKey: companionPiBundleObjectKey(manifest.sha256), manifest };
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
