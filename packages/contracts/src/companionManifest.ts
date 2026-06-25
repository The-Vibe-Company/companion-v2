import { z } from "zod";
import { SEMVER_RE, SKILL_NAME_RE, SKILL_REQUIREMENT_KEY_RE, skillRequirementSchema, type SkillRequirement } from "./frontmatter";

export const COMPANION_MANIFEST_SCHEMA_URL = "https://thecompanion.sh/schemas/companion-manifest.v2.schema.json";

export const companionDisplaySchema = z
  .object({
    name: z.string().min(1, "display name must not be empty").max(120, "display name must be at most 120 characters").optional(),
    summary: z.string().min(1, "display summary must not be empty").max(1024, "display summary must be at most 1024 characters").optional(),
    description: z.string().min(1, "display description must not be empty").max(4000, "display description must be at most 4000 characters").optional(),
  })
  .strip()
  .default({});

export type CompanionDisplay = z.infer<typeof companionDisplaySchema>;

export const companionEnvironmentDeclarationSchema = z
  .object({
    required: z.boolean().default(true),
    description: z.string().max(2000, "environment description must be at most 2000 characters").default(""),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if ("value" in value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "environment declarations must not include values",
      });
    }
  })
  .transform((value) => ({
    required: value.required,
    description: value.description,
  }));

export type CompanionEnvironmentDeclaration = z.infer<typeof companionEnvironmentDeclarationSchema>;

const declarationRecordSchema = z
  .record(
    z.string().regex(SKILL_REQUIREMENT_KEY_RE, "environment keys must look like environment variables"),
    companionEnvironmentDeclarationSchema,
  )
  .default({});

export const companionEnvironmentSchema = z
  .object({
    env: declarationRecordSchema,
    secrets: declarationRecordSchema,
  })
  .strip()
  .default({ env: {}, secrets: {} });

export type CompanionEnvironment = z.infer<typeof companionEnvironmentSchema>;

export const companionChangelogEntrySchema = z
  .object({
    version: z.string().regex(SEMVER_RE, "changelog version must be valid semver"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "changelog date must be YYYY-MM-DD").optional(),
    changes: z.array(z.string().min(1).max(1000)).min(1, "changelog entry must include at least one change").max(50),
  })
  .strip();

export type CompanionChangelogEntry = z.infer<typeof companionChangelogEntrySchema>;

export const companionMetadataSchema = z
  .object({
    companionSkillId: z.string().uuid("companionSkillId must be a UUID").optional(),
    changelog: z.array(companionChangelogEntrySchema).max(200, "at most 200 changelog entries are allowed").default([]),
  })
  .strip()
  .default({ changelog: [] });

export type CompanionMetadata = z.infer<typeof companionMetadataSchema>;

export const companionCommandSchema = z
  .object({
    name: z.string().min(1).max(120),
    desc: z.string().min(1).max(500),
  })
  .strip();

export type CompanionCommand = z.infer<typeof companionCommandSchema>;

export const companionUpdateCheckSchema = z
  .object({
    runtime: z.literal("python"),
    script: z
      .string()
      .min(1, "check script path is required")
      .max(260, "check script path must be at most 260 characters")
      .refine((value) => !value.includes("\\"), "check script path must use forward slashes")
      .refine((value) => !value.startsWith("/"), "check script path must be relative")
      .refine((value) => !/^[a-zA-Z]:/.test(value), "check script path must be relative")
      .refine(
        (value) => value.split("/").every((segment) => segment && segment !== "." && segment !== ".."),
        "check script path must not contain empty, dot, or dot-dot segments",
      ),
    timeoutSeconds: z.number().int().min(1).max(300).default(30),
  })
  .strip();

export type CompanionUpdateCheck = z.infer<typeof companionUpdateCheckSchema>;

export const companionChecksSchema = z
  .object({
    updates: companionUpdateCheckSchema.optional(),
  })
  .strip()
  .default({});

export type CompanionChecks = z.infer<typeof companionChecksSchema>;

const legacyDependencySchema = z
  .union([
    z.string().regex(SKILL_NAME_RE, "dependency slug must be kebab-case"),
    z.object({ slug: z.string().regex(SKILL_NAME_RE, "dependency slug must be kebab-case") }).strip(),
  ])
  .transform((value) => (typeof value === "string" ? value : value.slug));

const dependencyMapSchema = z
  .record(
    z.string().regex(SKILL_NAME_RE, "dependency name must be kebab-case"),
    z.string().uuid("dependency id must be a UUID"),
  );

const legacyDependencyArraySchema = z
  .array(legacyDependencySchema)
  .transform((value) => [...new Set(value)].sort((a, b) => a.localeCompare(b)));

const companionDependenciesInputSchema = z
  .unknown()
  .default({})
  .superRefine((value, ctx) => {
    const parsed = Array.isArray(value) ? legacyDependencyArraySchema.safeParse(value) : dependencyMapSchema.safeParse(value);
    if (parsed.success) {
      const count = Array.isArray(parsed.data) ? parsed.data.length : Object.keys(parsed.data).length;
      if (count > 64) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "at most 64 dependencies are allowed",
        });
      }
      return;
    }
    for (const issue of parsed.error.issues) ctx.addIssue(issue);
  })
  .transform((value) => {
    const parsed = Array.isArray(value) ? legacyDependencyArraySchema.parse(value) : dependencyMapSchema.parse(value);
    if (Array.isArray(parsed)) return parsed;
    return Object.fromEntries(Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b)));
  });

export type CompanionDependencies = Record<string, string>;

function requirementsToEnvironment(requirements: SkillRequirement[] | undefined): CompanionEnvironment {
  const env: Record<string, CompanionEnvironmentDeclaration> = {};
  const secrets: Record<string, CompanionEnvironmentDeclaration> = {};
  for (const requirement of requirements ?? []) {
    const target = requirement.type === "env" ? env : secrets;
    target[requirement.key] = {
      required: requirement.required,
      description: requirement.note,
    };
  }
  return companionEnvironmentSchema.parse({ env, secrets });
}

export function companionEnvironmentToRequirements(environment: CompanionEnvironment): SkillRequirement[] {
  return [
    ...Object.entries(environment.env).map(([key, value]) => ({
      key,
      type: "env" as const,
      required: value.required,
      note: value.description,
    })),
    ...Object.entries(environment.secrets).map(([key, value]) => ({
      key,
      type: "secret" as const,
      required: value.required,
      note: value.description,
    })),
  ].sort((a, b) => a.key.localeCompare(b.key));
}

export const companionManifestSchema = z
  .object({
    $schema: z.string().url().optional(),
    name: z.string().regex(SKILL_NAME_RE, "name must be kebab-case").optional(),
    version: z.string().regex(SEMVER_RE, "version must be valid semver").optional(),
    title: z.string().min(1).max(120).optional(),
    description: z.string().min(1).max(1024).optional(),
    notes: z.string().max(8000).optional(),
    metadata: companionMetadataSchema,
    environment: companionEnvironmentSchema,
    dependencies: companionDependenciesInputSchema,
    commands: z.array(companionCommandSchema).max(64, "at most 64 commands are allowed").default([]),
    checks: companionChecksSchema,
    /** Legacy v1 fields. Accepted for migration, never emitted by buildCompanionManifestJson. */
    display: companionDisplaySchema.optional(),
    requirements: z.array(skillRequirementSchema).max(64, "at most 64 requirements are allowed").optional(),
  })
  .strip()
  .superRefine((value, ctx) => {
    const requirementKeys = new Set<string>();
    for (const requirement of value.requirements ?? []) {
      if (requirementKeys.has(requirement.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requirements"],
          message: `duplicate requirement key: ${requirement.key}`,
        });
      }
      requirementKeys.add(requirement.key);
    }
    if (value.version && value.$schema && !value.metadata.changelog.some((entry) => entry.version === value.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metadata", "changelog"],
        message: `metadata.changelog must include an entry for version ${value.version}`,
      });
    }
  })
  .transform((value) => {
    const environment = value.requirements?.length ? requirementsToEnvironment(value.requirements) : value.environment;
    const title = value.title ?? value.display?.name;
    const description = value.description ?? value.display?.summary;
    const notes = value.notes ?? value.display?.description;
    const legacyDependencySlugs = Array.isArray(value.dependencies) ? value.dependencies : [];
    const dependencies = Array.isArray(value.dependencies) ? {} : value.dependencies;
    return {
      $schema: value.$schema,
      name: value.name,
      version: value.version,
      title,
      description,
      notes,
      metadata: {
        ...value.metadata,
        changelog: [...value.metadata.changelog].sort((a, b) => b.version.localeCompare(a.version)),
      },
      environment,
      dependencies,
      legacyDependencySlugs,
      commands: value.commands,
      checks: value.checks,
      // Compatibility read shape for existing UI/API code. These are not serialized to companion.json.
      display: companionDisplaySchema.parse({
        name: title,
        summary: description,
        description: value.display?.description,
      }),
      requirements: companionEnvironmentToRequirements(environment),
    };
  });

export type CompanionManifest = z.infer<typeof companionManifestSchema>;

export function companionDependencySlugs(manifest: Pick<CompanionManifest, "dependencies">): string[] {
  const legacy = "legacyDependencySlugs" in manifest ? (manifest as Pick<CompanionManifest, "legacyDependencySlugs">).legacyDependencySlugs : [];
  return [...new Set([...Object.keys(manifest.dependencies), ...legacy])].sort((a, b) => a.localeCompare(b));
}

export function companionManifestJson(manifest: CompanionManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    $schema: manifest.$schema ?? COMPANION_MANIFEST_SCHEMA_URL,
  };
  if (manifest.name) out.name = manifest.name;
  if (manifest.version) out.version = manifest.version;
  if (manifest.title) out.title = manifest.title;
  if (manifest.description) out.description = manifest.description;
  if (manifest.notes) out.notes = manifest.notes;
  out.metadata = manifest.metadata;
  out.environment = manifest.environment;
  out.dependencies = manifest.dependencies;
  out.commands = manifest.commands;
  if (manifest.checks.updates) out.checks = manifest.checks;
  return out;
}

export function fallbackCompanionManifest(input: {
  summary: string;
  requirements?: SkillRequirement[];
  dependencies?: string[] | Record<string, string>;
  display?: CompanionDisplay | null;
  name?: string;
  version?: string;
  companionSkillId?: string;
  changelog?: CompanionChangelogEntry[];
  environment?: CompanionEnvironment;
  commands?: CompanionCommand[];
  checks?: CompanionChecks;
  notes?: string;
}): CompanionManifest {
  const summary = input.summary.trim() || "Skill";
  const dependencies =
    input.dependencies &&
    !Array.isArray(input.dependencies) &&
    Object.keys(input.dependencies).length > 0 &&
    Object.values(input.dependencies).every((id) => id === "")
      ? Object.keys(input.dependencies)
      : input.dependencies;
  return companionManifestSchema.parse({
    name: input.name,
    version: input.version,
    title: input.display?.name,
    description: input.display?.summary ?? summary,
    notes: input.notes ?? input.display?.description,
    metadata: {
      companionSkillId: input.companionSkillId,
      changelog: input.changelog ?? [],
    },
    environment: input.environment ?? requirementsToEnvironment(input.requirements),
    dependencies: dependencies ?? {},
    commands: input.commands ?? [],
    checks: input.checks ?? {},
  });
}
