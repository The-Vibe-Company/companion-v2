import { z } from "zod";
import { SKILL_NAME_RE, skillRequirementSchema } from "./frontmatter";

export const companionDependencySchema = z
  .union([
    z.string().regex(SKILL_NAME_RE, "dependency slug must be kebab-case"),
    z.object({ slug: z.string().regex(SKILL_NAME_RE, "dependency slug must be kebab-case") }).strip(),
  ])
  .transform((value) => (typeof value === "string" ? value : value.slug));

export const companionDisplaySchema = z
  .object({
    name: z.string().min(1, "display name must not be empty").max(120, "display name must be at most 120 characters").optional(),
    summary: z.string().min(1, "display summary must not be empty").max(1024, "display summary must be at most 1024 characters").optional(),
    description: z.string().min(1, "display description must not be empty").max(4000, "display description must be at most 4000 characters").optional(),
  })
  .strip()
  .default({});

export type CompanionDisplay = z.infer<typeof companionDisplaySchema>;

export const companionManifestSchema = z
  .object({
    display: companionDisplaySchema,
    requirements: z.array(skillRequirementSchema).max(64, "at most 64 requirements are allowed").default([]),
    dependencies: z.array(companionDependencySchema).max(64, "at most 64 dependencies are allowed").default([]),
  })
  .strip()
  .superRefine((value, ctx) => {
    const requirementKeys = new Set<string>();
    for (const requirement of value.requirements) {
      if (requirementKeys.has(requirement.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requirements"],
          message: `duplicate requirement key: ${requirement.key}`,
        });
      }
      requirementKeys.add(requirement.key);
    }
  })
  .transform((value) => ({
    display: value.display,
    requirements: [...value.requirements].sort((a, b) => a.key.localeCompare(b.key)),
    dependencies: [...new Set(value.dependencies)].sort((a, b) => a.localeCompare(b)),
  }));

export type CompanionManifest = z.infer<typeof companionManifestSchema>;

export function fallbackCompanionManifest(input: {
  summary: string;
  requirements?: z.infer<typeof skillRequirementSchema>[];
  dependencies?: string[];
  display?: CompanionDisplay | null;
}): CompanionManifest {
  const summary = input.summary.trim() || "Skill";
  return companionManifestSchema.parse({
    display: {
      ...input.display,
      summary: input.display?.summary ?? summary,
    },
    requirements: input.requirements ?? [],
    dependencies: input.dependencies ?? [],
  });
}
