import type { SkillRequirement, SkillVisibilityInput } from "@companion/contracts";
import { toStoredSkillFrontmatter } from "@companion/contracts";
import {
  createOrg,
  createTeam,
  ensureUserBootstrap,
  listOrgs,
  listSkills,
  listTeamsForUser,
  markOnboarded,
  publishSkillVersion,
  type ActorContext,
} from "@companion/core/services";
import { closeDb, db, schema } from "@companion/db";
import { packDir, parseFrontmatter } from "@companion/skills";
import { putSkillArchive, skillArchiveKey } from "@companion/storage";
import { and, eq, inArray } from "drizzle-orm";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_EMAIL = "admin@tvc.dev";
const DEFAULT_PASSWORD = "adminadmin";
const DEFAULT_NAME = "Admin";
const LOCAL_DATABASE_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function seedEmail(): string {
  return (process.env.COMPANION_SEED_EMAIL ?? DEFAULT_EMAIL).trim().toLowerCase();
}

function seedPassword(): string {
  return process.env.COMPANION_SEED_PASSWORD ?? DEFAULT_PASSWORD;
}

function seedName(email: string): string {
  return (process.env.COMPANION_SEED_NAME ?? DEFAULT_NAME).trim() || email.split("@")[0] || DEFAULT_NAME;
}

function assertLocalSeedAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("refusing to seed a test user when NODE_ENV=production");
  }

  if (process.env.COMPANION_ALLOW_TEST_USER_SEED === "1") {
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed a local test user");
  }

  const host = new URL(databaseUrl).hostname;
  if (!LOCAL_DATABASE_HOSTS.has(host)) {
    throw new Error(
      `refusing to seed a test user against non-local database host "${host}"; set COMPANION_ALLOW_TEST_USER_SEED=1 to override`,
    );
  }
}

function createdMessage(email: string, password: string): string {
  if (process.env.COMPANION_SEED_PASSWORD) {
    return `Seeded local test user ${email}; password was read from COMPANION_SEED_PASSWORD`;
  }
  return `Seeded local test user ${email} / ${password}`;
}

const SEED_TEAM_NAME = "Engineering";

function storageConfigured(): boolean {
  return Boolean(
    process.env.S3_ENDPOINT &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY &&
      process.env.S3_BUCKET_SKILL_ARCHIVES,
  );
}

interface SeedSkillSpec {
  slug: string;
  version: string;
  description: string;
  body: string;
  visibility: SkillVisibilityInput;
  tools?: string[];
  license?: string;
  /** Declared required dependencies (must resolve cleanly — published earlier in the list). */
  dependencies?: string[];
  /** Declared required secrets / env vars + install notes (declarations only, never values). */
  requirements?: SkillRequirement[];
}

function buildSkillMd(
  spec: Pick<SeedSkillSpec, "slug" | "version" | "description" | "body" | "tools" | "license" | "requirements">,
): string {
  const lines = [
    "---",
    `name: ${spec.slug}`,
    `description: ${JSON.stringify(spec.description)}`,
    "metadata:",
    `  companion_version: ${JSON.stringify(spec.version)}`,
  ];
  if (spec.license) lines.push(`license: ${spec.license}`);
  if (spec.tools?.length) {
    lines.push(`allowed-tools: ${JSON.stringify(spec.tools.join(" "))}`);
  }
  if (spec.requirements?.length) {
    lines.push("requirements:");
    for (const req of spec.requirements) {
      lines.push(`  - key: ${req.key}`);
      lines.push(`    type: ${req.type}`);
      lines.push(`    required: ${req.required}`);
      lines.push(`    note: ${JSON.stringify(req.note)}`);
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n\n${spec.body.trim()}\n`;
}

async function seedSkill(actor: ActorContext, orgId: string, spec: SeedSkillSpec): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "companion-seed-skill-"));
  try {
    const md = buildSkillMd(spec);
    await writeFile(join(dir, "SKILL.md"), md);
    const canonical = await packDir(dir);
    const parsed = parseFrontmatter(md);
    if (!parsed.ok) throw new Error(parsed.error);
    const fm = parsed.data;
    const key = skillArchiveKey({ orgId, slug: fm.name, version: spec.version });
    const payload = {
      slug: fm.name,
      visibility: spec.visibility,
      version: spec.version,
      description: fm.description,
      checksum: canonical.checksum,
      storage_path: key,
      size_bytes: canonical.sizeBytes,
      frontmatter: JSON.stringify(toStoredSkillFrontmatter(fm), null, 2),
      tools: fm.allowedTools,
      license: fm.license ?? null,
      note: "Seeded for local development",
      dependencies: spec.dependencies ?? [],
    };
    try {
      await putSkillArchive({ key, body: canonical.archive, preventOverwrite: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("precondition") && !message.toLowerCase().includes("already exists")) {
        throw error;
      }
    }
    await publishSkillVersion({ actor, orgId, payload, archiveKey: key });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedDemoContent(actor: ActorContext): Promise<void> {
  const orgs = await listOrgs(actor);
  if (orgs.length === 0) return;
  const orgId = orgs[0]!.org_id;

  let teamSlug = (await listTeamsForUser({ actor, orgId }))[0]?.slug;
  if (!teamSlug) {
    const created = await createTeam({ actor, orgId, name: SEED_TEAM_NAME });
    teamSlug = created.slug;
    console.log(`Seeded team "${SEED_TEAM_NAME}" (${teamSlug})`);
  }

  if (!storageConfigured()) {
    console.warn("Skipping demo skills: S3 storage is not configured (S3_ENDPOINT and related env vars)");
    return;
  }

  // Include archived skills so a re-run does not try to republish ones the showcase archived.
  const existingSlugs = new Set(
    (await listSkills({ actor, orgId, includeArchived: true })).map((skill) => skill.slug),
  );
  // Ordered so every declared dependency is published before its dependents (publish blocks
  // missing/cycle/visibility). The showcase edges below (missing/cycle/visibility/archived) are
  // inserted directly afterwards, since those states cannot pass the publish-time check.
  const specs: SeedSkillSpec[] = [
    {
      slug: "markdown-report",
      version: "2.1.0",
      description: "Render structured findings into a clean Markdown report.",
      body: "# markdown-report\n\nRenders structured findings into a clean Markdown report.",
      visibility: { everyone: true, teams: [] },
      tools: ["read_file"],
      license: "MIT",
    },
    {
      slug: "log-parser",
      version: "1.4.0",
      description: "Parse heterogeneous log formats into a normalized event stream.",
      body: "# log-parser\n\nParses heterogeneous log formats into a normalized event stream.",
      visibility: { everyone: true, teams: [] },
      tools: ["read_file"],
      license: "MIT",
    },
    {
      slug: "diff-tools",
      version: "0.9.4",
      description: "Compute and present structured diffs across files and revisions.",
      body: "# diff-tools\n\nComputes and presents structured diffs across files and revisions.",
      visibility: { everyone: true, teams: [] },
      tools: ["read_file"],
      license: "MIT",
    },
    {
      slug: "slack-notify",
      version: "1.1.0",
      description: "Post a formatted notification to a Slack channel.",
      body: "# slack-notify\n\nPosts a formatted notification to a Slack channel.",
      visibility: { everyone: false, teams: [teamSlug] },
      tools: ["run_python"],
      license: "MIT",
      requirements: [
        {
          key: "SLACK_BOT_TOKEN",
          type: "secret",
          required: true,
          note: "Slack bot token (xoxb-…). Ask a workspace admin to install the Companion app, or create one at https://api.slack.com/apps → OAuth & Permissions.",
        },
        {
          key: "SLACK_DEFAULT_CHANNEL",
          type: "env",
          required: false,
          note: "Channel ID to post to when a message does not specify one. Defaults to #general.",
        },
      ],
    },
    {
      slug: "vault-index",
      version: "1.3.0",
      description: "Maintain a searchable index over a Granite memory vault.",
      body: "# vault-index\n\nMaintains a searchable index over a Granite memory vault.",
      visibility: { everyone: true, teams: [] },
      tools: ["read_file"],
      license: "MIT",
    },
    {
      slug: "granite-recall",
      version: "1.0.0",
      description: "Recall relevant memories from a Granite vault for a given query.",
      body: "# granite-recall\n\nRecalls relevant memories from a Granite vault for a query.",
      visibility: { everyone: true, teams: [] },
      tools: ["read_file"],
      license: "MIT",
    },
    {
      slug: "screenshot-grab",
      version: "0.2.0",
      description: "Capture a rendered screenshot of a page region.",
      body: "# screenshot-grab\n\nCaptures a rendered screenshot of a page region.",
      visibility: { everyone: true, teams: [] },
      tools: ["run_python"],
      license: "MIT",
    },
    {
      slug: "html-export",
      version: "1.0.0",
      description: "Export a report to a standalone HTML file. Superseded by markdown-report.",
      body: "# html-export\n\nExports a report to a standalone HTML file.",
      visibility: { everyone: true, teams: [] },
      tools: ["read_file"],
      license: "MIT",
    },
    {
      slug: "incident-summary",
      version: "0.1.8",
      description: "Summarize an incident timeline from logs into a concise postmortem draft.",
      body: "# incident-summary\n\nReads a directory of log excerpts and produces a terse incident summary.",
      visibility: { everyone: true, teams: [] },
      tools: ["read_file", "run_python"],
      license: "MIT",
      dependencies: ["log-parser", "markdown-report"],
    },
    {
      slug: "email-digest",
      version: "1.2.0",
      description: "Compile a daily digest of activity into a short formatted email.",
      body: "# email-digest\n\nCompiles a daily digest of activity into a short formatted email.",
      visibility: { everyone: true, teams: [] },
      tools: ["read_file"],
      license: "MIT",
      dependencies: ["markdown-report"],
    },
  ];

  for (const spec of specs) {
    if (existingSlugs.has(spec.slug)) continue;
    try {
      await seedSkill(actor, orgId, spec);
      console.log(`Seeded skill ${spec.slug}@${spec.version}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Skipped skill ${spec.slug}: ${message}`);
    }
  }

  await seedDependencyShowcase(actor, orgId);
}

/**
 * Insert the showcase dependency states (missing / visibility / cycle / archived) directly, since
 * these deliberately cannot pass the publish-time check. Idempotent: edges use onConflictDoNothing
 * and archive flags are set unconditionally.
 */
async function seedDependencyShowcase(actor: ActorContext, orgId: string): Promise<void> {
  const rows = await db
    .select({ id: schema.skills.id, slug: schema.skills.slug, currentVersionId: schema.skills.currentVersionId })
    .from(schema.skills)
    .where(eq(schema.skills.orgId, orgId));
  const bySlug = new Map(rows.map((r) => [r.slug, r] as const));

  const edge = (dependentSlug: string, dependsOnSlug: string) => {
    const dependent = bySlug.get(dependentSlug);
    if (!dependent?.currentVersionId) return null;
    const target = bySlug.get(dependsOnSlug);
    return {
      orgId,
      skillVersionId: dependent.currentVersionId,
      skillId: dependent.id,
      dependsOnSlug,
      dependsOnSkillId: target?.id ?? null,
    };
  };

  const edges = [
    // Cycle: vault-index ↔ granite-recall.
    edge("vault-index", "granite-recall"),
    edge("granite-recall", "vault-index"),
    // Visibility mismatch: an Everyone skill requiring a team-only dependency.
    edge("email-digest", "slack-notify"),
    // Missing: a declared dependency that was never published to the workspace.
    edge("incident-summary", "html-sanitize"),
    // Archived dependency, still referenced by a live version (keeps it downloadable).
    edge("incident-summary", "screenshot-grab"),
  ].filter((e): e is NonNullable<typeof e> => e != null);

  if (edges.length) {
    await db.insert(schema.skillVersionDependencies).values(edges).onConflictDoNothing();
  }

  // Archive screenshot-grab (referenced by incident-summary → downloadable) and html-export (unreferenced).
  const toArchive = ["screenshot-grab", "html-export"].map((slug) => bySlug.get(slug)?.id).filter((id): id is string => !!id);
  if (toArchive.length) {
    await db
      .update(schema.skills)
      .set({ archivedAt: new Date(), archivedBy: actor.id, archiveReason: "Superseded — seeded archive demo" })
      .where(and(eq(schema.skills.orgId, orgId), inArray(schema.skills.id, toArchive)));
  }
  console.log("Seeded dependency showcase (cycle, visibility, missing, archived)");
}

async function createAuthUser(input: { email: string; password: string; name: string }): Promise<void> {
  const { auth } = await import("@companion/auth");
  const authUrl = process.env.BETTER_AUTH_URL ?? process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001";
  const response = await auth.handler(
    new Request(`${authUrl.replace(/\/$/, "")}/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: authUrl,
      },
      body: JSON.stringify(input),
    }),
  );

  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as { message?: string; error?: { message?: string } };
    throw new Error(json.error?.message ?? json.message ?? `sign-up failed with ${response.status}`);
  }
}

async function main(): Promise<void> {
  assertLocalSeedAllowed();

  const email = seedEmail();
  const password = seedPassword();
  const name = seedName(email);

  let user = await db.query.user.findFirst({
    where: (table, { eq }) => eq(table.email, email),
  });
  const created = !user;

  if (!user) {
    await createAuthUser({ email, password, name });
    user = await db.query.user.findFirst({
      where: (table, { eq }) => eq(table.email, email),
    });
  }

  if (!user) throw new Error(`could not create seed user ${email}`);

  // Email/password sign-in now requires a verified email (requireEmailVerification). Mark the local
  // test user verified so `pnpm dev` / browser:smoke can sign in without going through the OTP flow.
  if (!user.emailVerified) {
    await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, user.id));
  }

  const actor = { id: user.id, email: user.email, name: user.name || name };
  await ensureUserBootstrap(actor);
  // The first-user auto-bootstrap was removed in favor of onboarding, so give the local test user a
  // workspace and mark them onboarded — keeps `pnpm dev` / browser:smoke landing on /skills, not /onboarding.
  const orgs = await listOrgs(actor);
  if (orgs.length === 0) {
    await createOrg({ actor, name: "Acme", kind: "team" });
  }
  await markOnboarded(actor);
  await seedDemoContent(actor);

  console.log(created ? createdMessage(email, password) : `Local test user ${email} already exists; leaving password unchanged`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
