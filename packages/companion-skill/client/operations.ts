import {
  COMPANION_AGENT_OPERATION_REGISTRY,
  matchCompanionAgentOperation,
  type CompanionAgentHttpMethod,
  type CompanionAgentTenantCapability,
} from "@companion/contracts/agent-operations";

export type CompanionCapability = CompanionAgentTenantCapability | "public-skills:install";
export type CompanionHttpMethod = CompanionAgentHttpMethod;

/** Derived compatibility export; contracts owns the only operation list. */
export const COMPANION_OPERATION_REGISTRY = COMPANION_AGENT_OPERATION_REGISTRY;

export interface ResolvedOperation {
  capability: CompanionAgentTenantCapability;
  binary?: "upload" | "download";
  sensitive: boolean;
}

export type TicketedDownloadTarget =
  | { kind: "skill-package"; slug: string; version: string }
  | { kind: "skill-file"; slug: string; version: string; filePath: string }
  | { kind: "local-skill"; slug: string };

function pathnameFromRelativeApiPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("#")) {
    throw new Error("Companion API paths must be relative, absolute-path references");
  }
  const rawPathname = path.split("?", 1)[0]!;
  for (const segment of rawPathname.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("Companion API path contains invalid percent encoding");
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error("Companion API path contains an unsafe path segment");
    }
  }
  return rawPathname;
}

export function resolveOperation(method: CompanionHttpMethod, path: string): ResolvedOperation {
  const matching = matchCompanionAgentOperation(method, pathnameFromRelativeApiPath(path));
  if (!matching) throw new Error(`operation is not in the Companion Agent Auth registry: ${method} ${path}`);
  const binary = matching.transport === "transfer-ticket-upload"
    ? "upload"
    : matching.transport === "transfer-ticket-download"
      ? "download"
      : undefined;
  return {
    capability: matching.capability,
    ...(binary ? { binary } : {}),
    sensitive: "sensitive" in matching && matching.sensitive === true,
  };
}

/** Parse only the three binary download shapes backed by a closed capability ticket exchange. */
export function resolveTicketedDownloadTarget(path: string): TicketedDownloadTarget {
  const operation = resolveOperation("GET", path);
  if (operation.binary !== "download" || operation.capability !== "skills:read") {
    throw new Error("operation is not a registered skills:read binary download");
  }
  const target = new URL(path, "https://companion.invalid");
  const skillPackage = /^\/skills\/([^/]+)\/versions\/([^/]+)\/package$/.exec(target.pathname);
  if (skillPackage) {
    return {
      kind: "skill-package",
      slug: decodeURIComponent(skillPackage[1]!),
      version: decodeURIComponent(skillPackage[2]!),
    };
  }
  const skillFile = /^\/skills\/([^/]+)\/versions\/([^/]+)\/files\/content$/.exec(target.pathname);
  if (skillFile) {
    const filePath = target.searchParams.get("path")?.trim();
    if (!filePath) throw new Error("skill file download requires an exact path query parameter");
    return {
      kind: "skill-file",
      slug: decodeURIComponent(skillFile[1]!),
      version: decodeURIComponent(skillFile[2]!),
      filePath,
    };
  }
  const localSkill = /^\/local-skills\/([^/]+)\/package$/.exec(target.pathname);
  if (localSkill) return { kind: "local-skill", slug: decodeURIComponent(localSkill[1]!) };
  throw new Error("this binary download does not have a registered Agent Auth ticket exchange");
}
