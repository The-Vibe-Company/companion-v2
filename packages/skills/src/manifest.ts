import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  toStoredSkillFrontmatter,
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
  await writeFile(skillMdPath, buildNormalizedSkillMd(frontmatter, reparsed.body), "utf8");
  return {
    rootDir,
    frontmatter,
    warnings: reparsed.warnings,
    legacy: reparsed.legacy,
  };
}
