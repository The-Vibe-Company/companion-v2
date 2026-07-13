import type { SkillVM } from "@/lib/types";

export type SkillActionId =
  | "share"
  | "install"
  | "update"
  | "download"
  | "publish-version"
  | "archive"
  | "restore"
  | "mark-installed"
  | "mark-not-installed";

export interface SkillAction {
  id: SkillActionId;
  /** Explicit label for global surfaces, tooltips, and accessible names. */
  label: string;
  /** Short label for controls that already identify the target as a skill. */
  contextualLabel?: string;
  icon: string;
}

export interface SkillActionPermissions {
  canShare: boolean;
  canPublishVersion: boolean;
  canArchive: boolean;
  canRestore: boolean;
  canCorrectInstall: boolean;
}

export interface SkillActionModel {
  primary: SkillAction | null;
  secondary: SkillAction[];
}

export const SKILL_ACTIONS = {
  share: { id: "share", label: "Share to organization", icon: "send" },
  install: { id: "install", label: "Install skill", contextualLabel: "Install", icon: "download" },
  update: { id: "update", label: "Update skill", contextualLabel: "Update", icon: "arrow-up-circle" },
  download: { id: "download", label: "Download package", icon: "package-2" },
  publishVersion: { id: "publish-version", label: "Publish new version", icon: "git-commit" },
  archive: { id: "archive", label: "Archive skill", contextualLabel: "Archive", icon: "archive" },
  restore: { id: "restore", label: "Restore skill", contextualLabel: "Restore", icon: "rotate-ccw" },
  markInstalled: { id: "mark-installed", label: "Mark as installed", icon: "circle-check" },
  markNotInstalled: { id: "mark-not-installed", label: "Mark as not installed", icon: "circle-x" },
} as const satisfies Record<string, SkillAction>;

type ActionSkill = Pick<
  SkillVM,
  | "scope"
  | "source"
  | "archived"
  | "installStatus"
  | "installedVersion"
  | "version"
  | "validation"
  | "referenced"
  | "usedByCount"
>;

/**
 * Presentation-only permission projection. API/service authorization remains authoritative; this
 * helper only prevents the UI from advertising actions the current actor cannot perform.
 */
export function skillActionPermissions(
  skill: Pick<SkillVM, "scope" | "authorId">,
  actorId: string,
): SkillActionPermissions {
  const canManage = skill.scope === "org" || skill.authorId === actorId;
  return {
    canShare: skill.scope === "personal" && skill.authorId === actorId,
    canPublishVersion: canManage,
    canArchive: canManage,
    canRestore: canManage,
    canCorrectInstall: skill.scope === "org",
  };
}

/**
 * Canonical skill-action matrix shared by every frontend surface. Precedence matters: archive and
 * personal scope are resolved before install state, so neither can accidentally expose Install.
 */
export function resolveSkillActions(skill: ActionSkill, permissions: SkillActionPermissions): SkillActionModel {
  let primary: SkillAction | null = null;

  if (skill.archived) {
    primary = permissions.canRestore ? SKILL_ACTIONS.restore : null;
  } else if (skill.scope === "personal") {
    primary = permissions.canShare ? SKILL_ACTIONS.share : null;
  } else if (skill.validation === "valid" && skill.version) {
    if (skill.installStatus === "none") primary = SKILL_ACTIONS.install;
    else if (
      skill.installStatus === "update" ||
      (skill.installStatus === "installed" &&
        skill.installedVersion !== null &&
        skill.installedVersion !== skill.version)
    ) {
      primary = SKILL_ACTIONS.update;
    }
  }

  const secondary: SkillAction[] = [];
  const downloadable = !!skill.version && (!skill.archived || (skill.referenced ?? skill.usedByCount > 0));
  if (downloadable) secondary.push(SKILL_ACTIONS.download);

  if (!skill.archived) {
    if (permissions.canPublishVersion) secondary.push(SKILL_ACTIONS.publishVersion);
    if (permissions.canArchive) secondary.push(SKILL_ACTIONS.archive);
  }

  if (permissions.canCorrectInstall && skill.version) {
    if (skill.installStatus === "none") {
      if (!skill.archived && skill.validation === "valid") secondary.push(SKILL_ACTIONS.markInstalled);
    } else {
      secondary.push(SKILL_ACTIONS.markNotInstalled);
    }
  }

  return { primary, secondary };
}
