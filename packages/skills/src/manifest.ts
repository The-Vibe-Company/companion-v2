import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  companionDependencySlugs,
  companionManifestJson,
  companionManifestSchema,
  fallbackCompanionManifest,
  toStoredSkillFrontmatter,
  type CompanionManifest,
  type FrontmatterWarning,
  type SkillFrontmatter,
  type SkillLegacyFrontmatter,
} from "@companion/contracts";
import { scanDir } from "./archive";
import { parseFrontmatter } from "./frontmatter";

export interface CompanionManifestMetadata {
  skillId?: string;
  version: string;
}

export interface PreparedSkillDir {
  rootDir: string;
  frontmatter: SkillFrontmatter;
  companionManifest: CompanionManifest;
  companionManifestPath: string;
  warnings: FrontmatterWarning[];
  legacy: SkillLegacyFrontmatter;
}

/**
 * Stable UUID for legacy declarations that predate explicit slot ids. This intentionally uses only
 * the immutable workspace skill id and the original env key: republishing the same declaration is
 * stable, while a rename without carrying the old slotId is treated as a new incompatible slot.
 */
export function deterministicSecretSlotId(skillId: string, envKey: string): string {
  const hex = createHash("md5").update(`${skillId}:secret:${envKey}`, "utf8").digest("hex").split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function withSecretSlotIds(environment: CompanionManifest["environment"], skillId: string): CompanionManifest["environment"] {
  return {
    env: environment.env,
    secrets: Object.fromEntries(
      Object.entries(environment.secrets).map(([key, declaration]) => [
        key,
        { ...declaration, slotId: declaration.slotId ?? deterministicSecretSlotId(skillId, key) },
      ]),
    ),
  };
}

export function withCompanionMetadata(
  frontmatter: SkillFrontmatter,
  _companion: CompanionManifestMetadata,
): SkillFrontmatter {
  const { companion_skill_id: _skillId, companion_version: _version, ...metadata } = frontmatter.metadata;
  return {
    ...frontmatter,
    metadata: Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function buildNormalizedSkillMd(frontmatter: SkillFrontmatter, body: string): string {
  const stored = toStoredSkillFrontmatter(frontmatter);
  const yaml = stringifyYaml(stored, { sortMapEntries: false }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

export function buildNormalizedCompanionJson(manifest: CompanionManifest): string {
  return `${JSON.stringify(companionManifestJson(manifest), null, 2)}\n`;
}

export function toStoredSkillVersionManifest(
  frontmatter: SkillFrontmatter,
  companion: CompanionManifest,
): ReturnType<typeof toStoredSkillFrontmatter> & { companion: Record<string, unknown> } {
  return {
    ...toStoredSkillFrontmatter(frontmatter),
    companion: companionManifestJson(companion),
  };
}

function publishChangelogForVersion(manifest: CompanionManifest, version: string): CompanionManifest["metadata"]["changelog"] {
  if (manifest.metadata.changelog.some((entry) => entry.version === version)) return manifest.metadata.changelog;
  return [
    {
      version,
      date: new Date().toISOString().slice(0, 10),
      changes: [`Publish version ${version}.`],
    },
    ...manifest.metadata.changelog,
  ];
}

function parseCompanionJson(raw: string | null, frontmatter: SkillFrontmatter): CompanionManifest {
  if (raw === null) {
    return fallbackCompanionManifest({
      summary: frontmatter.description,
      requirements: frontmatter.requirements,
      name: frontmatter.name,
      version: frontmatter.metadata.companion_version,
      companionSkillId: frontmatter.metadata.companion_skill_id,
    });
  }
  const parsed = companionManifestSchema.parse(JSON.parse(raw));
  return fallbackCompanionManifest({
    summary: parsed.description ?? frontmatter.description,
    name: parsed.name ?? frontmatter.name,
    version: parsed.version ?? frontmatter.metadata.companion_version,
    icon: parsed.icon,
    companionSkillId: parsed.metadata.companionSkillId ?? frontmatter.metadata.companion_skill_id,
    display: parsed.display,
    requirements: parsed.requirements,
    dependencies: parsed.legacyDependencySlugs.length ? companionDependencySlugs(parsed) : parsed.dependencies,
    environment: parsed.environment,
    changelog: parsed.metadata.changelog,
    commands: parsed.commands,
    checks: parsed.checks,
    notes: parsed.notes,
  });
}

function resolvePackageRoot(dir: string, skillName: string, skillMdPath: string | null, files: string[]): string {
  if (skillMdPath === "SKILL.md") return dir;
  const wrapper = `${skillName}/`;
  if (skillMdPath === `${wrapper}SKILL.md` && files.length > 0 && files.every((file) => file.startsWith(wrapper))) {
    return join(dir, skillName);
  }
  throw new Error(`unexpected SKILL.md location: ${skillMdPath ?? "(missing)"}`);
}

export async function prepareSkillDirForPublish(
  dir: string,
  companion: CompanionManifestMetadata,
): Promise<PreparedSkillDir> {
  const scan = await scanDir(dir);
  if (!scan.skillMd) throw new Error("SKILL.md not found in package");
  const parsed = parseFrontmatter(scan.skillMd);
  if (!parsed.ok) throw new Error(parsed.error);
  const rootDir = resolvePackageRoot(
    dir,
    parsed.data.name,
    scan.skillMdPath,
    scan.files.map((file) => file.relPath),
  );
  const skillMdPath = join(rootDir, "SKILL.md");
  const current = await readFile(skillMdPath, "utf8");
  const reparsed = parseFrontmatter(current);
  if (!reparsed.ok) throw new Error(reparsed.error);
  const frontmatter = withCompanionMetadata(reparsed.data, companion);
  const companionPath = join(rootDir, "companion.json");
  const rawCompanionJson = await readFile(companionPath, "utf8").catch(() => null);
  const existingManifest = parseCompanionJson(rawCompanionJson, frontmatter);
  const normalizedManifest = fallbackCompanionManifest({
    summary: existingManifest.description ?? frontmatter.description,
    name: frontmatter.name,
    version: companion.version,
    icon: existingManifest.icon,
    companionSkillId: companion.skillId,
    display: existingManifest.display,
    requirements: existingManifest.requirements,
    dependencies: existingManifest.legacyDependencySlugs.length ? companionDependencySlugs(existingManifest) : existingManifest.dependencies,
    environment: existingManifest.environment,
    changelog: publishChangelogForVersion(existingManifest, companion.version),
    commands: existingManifest.commands,
    checks: existingManifest.checks,
    notes: existingManifest.notes,
  });
  const companionManifest = fallbackCompanionManifest({
    summary: normalizedManifest.description ?? frontmatter.description,
    name: normalizedManifest.name,
    version: normalizedManifest.version,
    icon: normalizedManifest.icon,
    companionSkillId: normalizedManifest.metadata.companionSkillId,
    display: normalizedManifest.display,
    environment: withSecretSlotIds(normalizedManifest.environment, companion.skillId ?? frontmatter.name),
    dependencies: normalizedManifest.dependencies,
    changelog: normalizedManifest.metadata.changelog,
    commands: normalizedManifest.commands,
    checks: normalizedManifest.checks,
    notes: normalizedManifest.notes,
  });
  await writeFile(companionPath, buildNormalizedCompanionJson(companionManifest), "utf8");
  await writeFile(skillMdPath, buildNormalizedSkillMd(frontmatter, reparsed.body), "utf8");
  return {
    rootDir,
    frontmatter,
    companionManifest,
    companionManifestPath: companionPath,
    warnings: reparsed.warnings,
    legacy: reparsed.legacy,
  };
}
