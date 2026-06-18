import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
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

function sortedMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b)));
}

export function withCompanionMetadata(
  frontmatter: SkillFrontmatter,
  companion: CompanionManifestMetadata,
): SkillFrontmatter {
  return {
    ...frontmatter,
    metadata: sortedMetadata({
      ...frontmatter.metadata,
      ...(companion.skillId ? { companion_skill_id: companion.skillId } : {}),
      companion_version: companion.version,
    }),
  };
}

export function buildNormalizedSkillMd(frontmatter: SkillFrontmatter, body: string): string {
  const stored = toStoredSkillFrontmatter(frontmatter);
  const yaml = stringifyYaml(stored, { sortMapEntries: false }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

export function buildNormalizedCompanionJson(manifest: CompanionManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function toStoredSkillVersionManifest(
  frontmatter: SkillFrontmatter,
  companion: CompanionManifest,
): ReturnType<typeof toStoredSkillFrontmatter> & { companion: CompanionManifest } {
  return {
    ...toStoredSkillFrontmatter(frontmatter),
    companion,
  };
}

function parseCompanionJson(raw: string | null, frontmatter: SkillFrontmatter): CompanionManifest {
  if (raw === null) {
    return fallbackCompanionManifest({
      summary: frontmatter.description,
      requirements: frontmatter.requirements,
    });
  }
  const parsed = companionManifestSchema.parse(JSON.parse(raw));
  return fallbackCompanionManifest({
    summary: frontmatter.description,
    display: parsed.display,
    requirements: parsed.requirements,
    dependencies: parsed.dependencies,
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
  const companionManifest = parseCompanionJson(rawCompanionJson, frontmatter);
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
