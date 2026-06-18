import {
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
    return input.companionManifest.dependencies;
  }
  return input.queryDependencies;
}

export function buildInlineCompanionManifest(input: {
  description: string;
  carriedDisplay?: CompanionDisplay | null;
  carriedRequirements: SkillRequirement[];
  carriedDependencies: string[];
}): CompanionManifest {
  const previousSummary = input.carriedDisplay?.summary?.trim();
  const previousDescription = input.carriedDisplay?.description?.trim();
  const hasRichDescription = previousDescription && previousDescription !== previousSummary;
  return fallbackCompanionManifest({
    summary: input.description,
    display: {
      name: input.carriedDisplay?.name,
      summary: input.description,
      description: hasRichDescription ? input.carriedDisplay?.description : input.description,
    },
    requirements: input.carriedRequirements,
    dependencies: input.carriedDependencies,
  });
}
