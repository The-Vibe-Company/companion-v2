import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeviceInventory, DeviceInventorySkill, DeviceInventoryTarget } from "@companion/contracts";
import { deviceInventorySchema } from "@companion/contracts";
import { companionHome, configPath } from "../lib/paths";
import { detectInstalledTools } from "./toolRegistry";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function readConfiguredTools(): Promise<string[]> {
  const raw = await loadJson(configPath());
  if (isObject(raw) && Array.isArray(raw.tools)) {
    return raw.tools.filter((tool): tool is string => typeof tool === "string");
  }
  return detectInstalledTools();
}

function normalizeTargets(record: Record<string, unknown>): DeviceInventoryTarget[] {
  const targets: DeviceInventoryTarget[] = [];
  const raw = record.targets;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isObject(entry) || typeof entry.path !== "string") continue;
      targets.push({
        tool: typeof entry.tool === "string" ? entry.tool : "claude-code",
        scope: entry.scope === "project" ? "project" : "user",
        path: entry.path,
        checksum: typeof entry.checksum === "string" ? entry.checksum : null,
        version: typeof entry.version === "string" ? entry.version : typeof record.version === "string" ? record.version : null,
      });
    }
  }
  if (!targets.length) {
    const legacyPath = typeof record.installPath === "string" ? record.installPath : typeof record.path === "string" ? record.path : null;
    if (legacyPath) {
      targets.push({
        tool: "claude-code",
        scope: "user",
        path: legacyPath,
        checksum: null,
        version: typeof record.version === "string" ? record.version : typeof record.resolved === "string" ? record.resolved : null,
      });
    }
  }
  return targets;
}

function skillRecordsFromEntry(entry: Record<string, unknown> | null): DeviceInventorySkill[] {
  if (!entry) return [];
  let source: unknown = null;
  for (const key of ["skills", "installedSkills", "installs"]) {
    if (isObject(entry[key]) || Array.isArray(entry[key])) {
      source = entry[key];
      break;
    }
  }
  if (source === null && ["name", "version", "resolved", "installPath"].some((key) => key in entry)) {
    source = [entry];
  }
  if (source === null) return [];

  const iterable = Array.isArray(source) ? source.entries() : Object.entries(source as Record<string, unknown>);
  const records: DeviceInventorySkill[] = [];
  for (const [key, value] of iterable) {
    if (!isObject(value)) continue;
    const name =
      typeof value.name === "string"
        ? value.name
        : typeof value.slug === "string"
          ? value.slug
          : typeof key === "string"
            ? key
            : null;
    if (!name) continue;
    records.push({
      name,
      slug: typeof value.slug === "string" ? value.slug : name,
      skillId:
        typeof value.skillId === "string"
          ? value.skillId
          : typeof value.workspaceSkillId === "string"
            ? value.workspaceSkillId
            : typeof value.companionSkillId === "string"
              ? value.companionSkillId
              : null,
      companionSkillId: typeof value.companionSkillId === "string" ? value.companionSkillId : null,
      version:
        typeof value.version === "string"
          ? value.version
          : typeof value.resolved === "string"
            ? value.resolved
            : typeof value.installedVersion === "string"
              ? value.installedVersion
              : null,
      checksum: typeof value.checksum === "string" ? value.checksum : null,
      path:
        typeof value.installPath === "string" ? value.installPath : typeof value.path === "string" ? value.path : null,
      targets: normalizeTargets(value),
    });
  }
  return records.sort((left, right) => left.slug.localeCompare(right.slug));
}

function workspaceEntry(raw: unknown, workspaceId: string | null, apiUrl: string): Record<string, unknown> | null {
  if (!isObject(raw)) return null;
  const workspaces = raw.workspaces;
  if (isObject(workspaces)) {
    const activeWorkspaceId = typeof raw.activeWorkspaceId === "string" ? raw.activeWorkspaceId : null;
    for (const key of [workspaceId, activeWorkspaceId, apiUrl]) {
      if (key && isObject(workspaces[key])) return workspaces[key];
    }
  }
  return raw;
}

function companionSkillVersion(skills: DeviceInventorySkill[]): string | null {
  return skills.find((skill) => skill.slug === "companion" || skill.name === "companion")?.version ?? null;
}

export async function readLocalInventory(input: {
  workspaceId: string | null;
  apiUrl: string;
}): Promise<DeviceInventory> {
  const paths = [join(companionHome(), "skills.lock.json"), join(companionHome(), "skills.log.json")];
  let selectedPath: string | null = null;
  let raw: unknown = null;
  for (const path of paths) {
    raw = await loadJson(path);
    if (raw !== null) {
      selectedPath = path;
      break;
    }
  }
  const entry = workspaceEntry(raw, input.workspaceId, input.apiUrl);
  const skills = skillRecordsFromEntry(entry);
  return deviceInventorySchema.parse({
    lockfileVersion: isObject(raw) && typeof raw.lockfileVersion === "number" ? raw.lockfileVersion : undefined,
    lockfile: selectedPath,
    workspaceId: input.workspaceId,
    apiUrl: input.apiUrl,
    tools: await readConfiguredTools(),
    companionSkillVersion: companionSkillVersion(skills),
    skills,
  });
}
