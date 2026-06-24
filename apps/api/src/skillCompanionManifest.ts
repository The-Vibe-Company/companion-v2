import {
  companionDependencySlugs,
  companionManifestJson,
  companionManifestSchema,
  fallbackCompanionManifest,
  type CompanionDisplay,
  type CompanionManifest,
  type SkillRequirement,
} from "@companion/contracts";

export function uploadDependencyValues(input: {
  queryDependencies: string[];
  companionManifestPath: string | null | undefined;
  companionManifest?: CompanionManifest;
}): string[] {
  if (input.companionManifestPath !== null && input.companionManifest) {
    return companionDependencySlugs(input.companionManifest);
  }
  return input.queryDependencies;
}

export function withResolvedManifestDependencies(
  manifest: CompanionManifest,
  dependencies: string[] | Record<string, string>,
): CompanionManifest {
  return companionManifestSchema.parse({
    ...companionManifestJson(manifest),
    dependencies,
  });
}

export function buildInlineCompanionManifest(input: {
  description: string;
  carriedDisplay?: CompanionDisplay | null;
  carriedNotes?: string | null;
  carriedRequirements: SkillRequirement[];
  carriedDependencies: string[] | Record<string, string>;
  name?: string;
  version?: string;
  companionSkillId?: string;
}): CompanionManifest {
  const previousSummary = input.carriedDisplay?.summary?.trim();
  const previousDescription = input.carriedDisplay?.description?.trim();
  const hasRichDescription = previousDescription && previousDescription !== previousSummary;
  const carriedNotes = input.carriedNotes?.trim() || (hasRichDescription ? previousDescription : undefined);
  return fallbackCompanionManifest({
    summary: input.description,
    display: {
      name: input.carriedDisplay?.name,
      summary: input.description,
    },
    notes: carriedNotes,
    requirements: input.carriedRequirements,
    dependencies: input.carriedDependencies,
    name: input.name,
    version: input.version,
    companionSkillId: input.companionSkillId,
    changelog: input.version
      ? [{ version: input.version, date: new Date().toISOString().slice(0, 10), changes: [`Publish version ${input.version}.`] }]
      : undefined,
  });
}
