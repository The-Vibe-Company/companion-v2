import { readFile, writeFile } from "node:fs/promises";
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
    companionSkillId: parsed.metadata.companionSkillId ?? frontmatter.metadata.companion_skill_id,
    display: parsed.display,
    requirements: parsed.requirements,
    dependencies: parsed.legacyDependencySlugs.length ? companionDependencySlugs(parsed) : parsed.dependencies,
    environment: parsed.environment,
    changelog: parsed.metadata.changelog,
    commands: parsed.commands,
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
  const companionManifest = fallbackCompanionManifest({
    summary: existingManifest.description ?? frontmatter.description,
    name: frontmatter.name,
    version: companion.version,
    companionSkillId: companion.skillId,
    display: existingManifest.display,
    requirements: existingManifest.requirements,
    dependencies: existingManifest.legacyDependencySlugs.length ? companionDependencySlugs(existingManifest) : existingManifest.dependencies,
    environment: existingManifest.environment,
    changelog: publishChangelogForVersion(existingManifest, companion.version),
    commands: existingManifest.commands,
    notes: existingManifest.notes,
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
