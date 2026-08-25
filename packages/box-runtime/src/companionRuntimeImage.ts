import { createHash } from "node:crypto";

import { COMPANION_BOX_AGENT_SOURCE } from "./companionBoxAgentSource";
import { COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE } from "./companionPermissionBroker";
import { COMPANION_PI_BROKER_SOURCE } from "./companionPiBrokerSource";

/**
 * Bump when the daemon wrapper or systemd unit changes without a broker/extension source change.
 * Overlay writes are the cheap in-place path for companions that are already running.
 */
export const COMPANION_PI_OVERLAY_REVISION = 8;
/** Bump when the archive/resume warmup profile changes without changing the runtime layout. */
export const COMPANION_RUNTIME_BOOT_PROFILE_REVISION = 1;

/** What a Box reports after `ensure-pi-layout.sh`. */
export type CompanionPiLayoutRefresh = "none" | "overlay" | "base";

interface CompanionPiLayoutRefreshLabels {
  readonly none: string;
  readonly overlay: string;
  readonly base: string;
}

export const COMPANION_PI_LAYOUT_REFRESH_LABEL = {
  none: "companion-layout-unchanged",
  overlay: "companion-layout-overlay",
  base: "companion-layout-base",
} satisfies CompanionPiLayoutRefreshLabels;

const IMAGE_NAME_PATTERN = /^companion-l[0-9]+-[a-f0-9]{12}$/;

export interface CompanionPiLayoutIdentity {
  layoutVersion: number;
  packages: readonly string[];
  qmdPackage: string;
  minimumPiVersion: string;
  companionSkillChecksum: string | null;
  bootProfileRevision: number;
  overlayRevision: number;
  overlayMarker: string;
  baseMarker: string;
  fullMarker: string;
  imageMarker: string;
  imageName: string;
}

const IMAGE_IDENTITY_SALT_PATTERN = /^[a-f0-9]{12,64}$/;

/**
 * Named ascii.dev snapshots are `^[a-z0-9][a-z0-9-]{0,62}$` and capped at ten per account.
 * The content hash lives in the name so GET tells us whether this pin set is already baked.
 */
export function companionRuntimeImageName(fullMarker: string, layoutVersion: number): string {
  const digest = createHash("sha256").update(fullMarker).digest("hex").slice(0, 12);
  return `companion-l${layoutVersion.toString(10)}-${digest}`;
}

export function isCompanionRuntimeImageName(name: string): boolean {
  return IMAGE_NAME_PATTERN.test(name);
}

export function companionPiOverlayMarker(overlayRevision = COMPANION_PI_OVERLAY_REVISION): string {
  return createHash("sha256")
    .update(`overlay-rev:${overlayRevision.toString(10)}\n`)
    .update(COMPANION_PI_BROKER_SOURCE)
    .update("\n")
    .update(COMPANION_PERMISSION_BROKER_EXTENSION_SOURCE)
    .update("\n")
    .update(COMPANION_BOX_AGENT_SOURCE)
    .digest("hex")
    .slice(0, 16);
}

export function companionPiBaseLayoutMarker(input: {
  layoutVersion: number;
  packages: readonly string[];
  qmdPackage: string;
  minimumPiVersion: string;
  /**
   * The active Pi bundle's sha256, present only in bundle mode. Folding its short digest into the
   * base marker makes a new bundle a new base identity: warm Boxes relayout once at their next health
   * tick and the registry re-bakes, all without a `disk_layout_version` bump. Escape-hatch installs
   * omit it, so a bundle identity and an install identity never collide.
   */
  bundleSha?: string;
}): string {
  const base = `${input.layoutVersion.toString(10)}:${input.packages.join(",")}`
    + `:qmd=${input.qmdPackage}:pi>=${input.minimumPiVersion}`;
  return input.bundleSha ? `${base}:bundle=${input.bundleSha.slice(0, 12)}` : base;
}

export function companionPiLayoutIdentity(input: {
  layoutVersion: number;
  packages: readonly string[];
  qmdPackage: string;
  minimumPiVersion: string;
  overlayRevision?: number;
  companionSkillChecksum?: string;
  bootProfileRevision?: number;
  /** The active Pi bundle sha256; present only in bundle mode. Folded into the base marker. */
  bundleSha?: string;
  /** Development-only salt used to isolate disposable research snapshots. */
  imageIdentitySalt?: string;
}): CompanionPiLayoutIdentity {
  if (
    input.imageIdentitySalt !== undefined
    && !IMAGE_IDENTITY_SALT_PATTERN.test(input.imageIdentitySalt)
  ) {
    throw new TypeError("Runtime image identity salt must be a lowercase hexadecimal digest.");
  }
  const overlayRevision = input.overlayRevision ?? COMPANION_PI_OVERLAY_REVISION;
  const overlayMarker = companionPiOverlayMarker(overlayRevision);
  const baseMarker = companionPiBaseLayoutMarker(input);
  const fullMarker = `${baseMarker}:overlay=${overlayMarker}`;
  const imageMarker = `${fullMarker}:skill=${input.companionSkillChecksum ?? "none"}`
    + `:boot=${(input.bootProfileRevision ?? COMPANION_RUNTIME_BOOT_PROFILE_REVISION).toString(10)}`
    + (input.imageIdentitySalt ? `:research=${input.imageIdentitySalt}` : "");
  return {
    layoutVersion: input.layoutVersion,
    packages: input.packages,
    qmdPackage: input.qmdPackage,
    minimumPiVersion: input.minimumPiVersion,
    companionSkillChecksum: input.companionSkillChecksum ?? null,
    bootProfileRevision: input.bootProfileRevision ?? COMPANION_RUNTIME_BOOT_PROFILE_REVISION,
    overlayRevision,
    overlayMarker,
    baseMarker,
    fullMarker,
    imageMarker,
    imageName: companionRuntimeImageName(imageMarker, input.layoutVersion),
  };
}

export function parseCompanionPiLayoutRefresh(stdout: string): CompanionPiLayoutRefresh {
  for (const line of stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).reverse()) {
    if (line === COMPANION_PI_LAYOUT_REFRESH_LABEL.none) return "none";
    if (line === COMPANION_PI_LAYOUT_REFRESH_LABEL.overlay) return "overlay";
    if (line === COMPANION_PI_LAYOUT_REFRESH_LABEL.base) return "base";
  }
  // An unlabeled success is a full install: restart Pi rather than assume the disk was already current.
  return "base";
}
