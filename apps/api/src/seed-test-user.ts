import type { Scope } from "@companion/contracts";
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
import { eq } from "drizzle-orm";
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
  scope: Scope;
  teamSlug?: string;
  tools?: string[];
  license?: string;
}

function buildSkillMd(spec: Pick<SeedSkillSpec, "slug" | "version" | "description" | "body" | "tools" | "license">): string {
  const lines = [
    "---",
    `name: ${spec.slug}`,
    `version: ${spec.version}`,
    `description: ${JSON.stringify(spec.description)}`,
  ];
  if (spec.license) lines.push(`license: ${spec.license}`);
  if (spec.tools?.length) {
    lines.push("tools:");
    for (const tool of spec.tools) lines.push(`  - ${tool}`);
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
      scope: spec.scope,
      team_slug: spec.teamSlug ?? null,
      version: spec.version,
      description: fm.description,
      checksum: canonical.checksum,
      storage_path: key,
      size_bytes: canonical.sizeBytes,
      frontmatter: JSON.stringify(fm, null, 2),
      tools: fm.tools,
      license: fm.license ?? null,
      note: "Seeded for local development",
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

  const existingSlugs = new Set((await listSkills({ actor, orgId })).map((skill) => skill.slug));
  const specs: SeedSkillSpec[] = [
    {
      slug: "pdf-extract",
      version: "1.0.0",
      description: "Extract text, tables, and metadata from PDF documents.",
      body: "# pdf-extract\n\nExtracts text, tables, and metadata from PDF documents.",
      scope: "public",
      tools: ["read_file", "run_python"],
      license: "MIT",
    },
    {
      slug: "code-review",
      version: "1.0.0",
      description: "Review pull requests for bugs, style, and missing tests.",
      body: "# code-review\n\nStructured PR review checklist for backend and frontend changes.",
      scope: "team",
      teamSlug,
      tools: ["read_file", "grep"],
      license: "MIT",
    },
    {
      slug: "meeting-notes",
      version: "1.0.0",
      description: "Turn rough meeting transcripts into concise action items.",
      body: "# meeting-notes\n\nSummarize discussions and extract owners, deadlines, and follow-ups.",
      scope: "private",
      tools: ["read_file"],
    },
  ];

  for (const spec of specs) {
    if (existingSlugs.has(spec.slug)) continue;
    try {
      await seedSkill(actor, orgId, spec);
      console.log(`Seeded skill ${spec.slug}@${spec.version} (${spec.scope})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Skipped skill ${spec.slug}: ${message}`);
    }
  }
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
