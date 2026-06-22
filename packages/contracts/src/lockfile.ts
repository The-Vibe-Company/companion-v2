import { z } from "zod";
import { skillOwnerTeamInputSchema } from "./skill";

/** One tracked skill in `companion.lock`. */
export const lockedSkillSchema = z.object({
  name: z.string(),
  /** Owner: `null`/absent = Personal; a team slug = owned by that team. */
  owner_team: skillOwnerTeamInputSchema,
  /** User intent: exact ("1.4.0"), a range ("^1.4.0"), or null (float to current). */
  pinned: z.string().nullable(),
  /** The version actually on disk. */
  resolved: z.string(),
  /** Checksum of the resolved published archive (drift baseline). */
  checksum: z.string(),
  size: z.number().int().nonnegative(),
  source: z.enum(["registry", "published", "local"]),
  installPath: z.string(),
  frontmatter: z
    .object({
      version: z.string().optional(),
      license: z.string().optional(),
      tools: z.array(z.string()).optional(),
    })
    .optional(),
  addedAt: z.string(),
  updatedAt: z.string(),
});
export type LockedSkill = z.infer<typeof lockedSkillSchema>;

/** `companion.lock` — committed to VCS so a team shares a reproducible skill set. */
export const lockfileSchema = z.object({
  lockfileVersion: z.literal(1),
  registry: z.object({
    url: z.string(),
    orgId: z.string().nullable(),
  }),
  skills: z.record(z.string(), lockedSkillSchema),
});
export type Lockfile = z.infer<typeof lockfileSchema>;

/** Drift classification used by `companion skills status` / `sync`. */
export type DriftState =
  | "up-to-date"
  | "outdated"
  | "modified"
  | "conflict"
  | "pinned"
  | "not-published"
  | "missing"
  | "untracked";
