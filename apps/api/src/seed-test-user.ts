import { fallbackCompanionManifest } from "@companion/contracts";
import {
  createOrg,
  ensureUserBootstrap,
  installSkill,
  listOrgs,
  markOnboarded,
  publishSkillVersion,
  type ActorContext,
} from "@companion/core/services";
import { closeDb, db, schema, withTenantContext, type Db } from "@companion/db";
import {
  buildNormalizedCompanionJson,
  compareSemver,
  packDir,
  parseFrontmatter,
  skillChecksum,
  toTar,
  toStoredSkillVersionManifest,
} from "@companion/skills";
import {
  getSkillArchive,
  isStoragePreconditionFailure,
  putSkillArchive,
  skillArchiveKey,
} from "@companion/storage";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEMO_ARCHIVED_SLUGS,
  DEMO_EMPTY_ORG_LABELS,
  DEMO_EMPTY_PERSONAL_LABELS,
  DEMO_FORCED_DEPENDENCIES,
  DEMO_INSTALLS,
  DEMO_INVALID_SKILLS,
  DEMO_SKILL_CATALOG,
  type SeedSkillSpec,
  type SeedSkillVersionSpec,
} from "./seed-demo-catalog";

const DEFAULT_EMAIL = "admin@tvc.dev";
const DEFAULT_PASSWORD = "adminadmin";
const DEFAULT_NAME = "Admin";
const SEED_VERSION_NOTE = "Seeded for local development";
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

function storageConfigured(): boolean {
  return Boolean(
    process.env.S3_ENDPOINT &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY &&
      process.env.S3_BUCKET_SKILL_ARCHIVES,
  );
}

function buildSkillMd(slug: string, spec: SeedSkillVersionSpec): string {
  const lines = [
    "---",
    `name: ${slug}`,
    `description: ${JSON.stringify(spec.description)}`,
  ];
  if (spec.license) lines.push(`license: ${spec.license}`);
  if (spec.tools?.length) {
    lines.push(`allowed-tools: ${JSON.stringify(spec.tools.join(" "))}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n\n${spec.body.trim()}\n`;
}

async function seedSkill(
  actor: ActorContext,
  orgId: string,
  skill: SeedSkillSpec,
  spec: SeedSkillVersionSpec,
  database: Db,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "companion-seed-skill-"));
  try {
    const md = buildSkillMd(skill.slug, spec);
    const companionManifest = fallbackCompanionManifest({
      summary: spec.description,
      requirements: spec.requirements ?? [],
      dependencies: spec.dependencies ?? [],
      display: spec.title ? { name: spec.title, summary: spec.description } : undefined,
      icon: spec.icon,
      notes: spec.notes,
      name: skill.slug,
      version: spec.version,
      changelog: [{ version: spec.version, date: "2026-06-24", changes: [`Seed ${skill.slug} ${spec.version}.`] }],
    });
    await writeFile(join(dir, "SKILL.md"), md);
    await writeFile(join(dir, "companion.json"), buildNormalizedCompanionJson(companionManifest));
    for (const file of spec.files ?? []) {
      const path = join(dir, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
    const canonical = await packDir(dir);
    const parsed = parseFrontmatter(md);
    if (!parsed.ok) throw new Error(parsed.error);
    const fm = parsed.data;
    const key = skillArchiveKey({ orgId, slug: fm.name, version: spec.version });
    const payload = {
      slug: fm.name,
      scope: skill.scope,
      labels: skill.labels ?? [],
      version: spec.version,
      description: fm.description,
      checksum: canonical.checksum,
      storage_path: key,
      size_bytes: canonical.sizeBytes,
      frontmatter: JSON.stringify(toStoredSkillVersionManifest(fm, companionManifest), null, 2),
      body: parsed.body,
      tools: fm.allowedTools,
      license: fm.license ?? null,
      note: SEED_VERSION_NOTE,
      dependencies: spec.dependencies ?? [],
    };
    try {
      await putSkillArchive({ key, body: canonical.archive, preventOverwrite: true });
    } catch (error) {
      if (!isStoragePreconditionFailure(error)) throw error;
      const storedArchive = await getSkillArchive({ key });
      if (skillChecksum(toTar(storedArchive)) !== canonical.checksum) {
        throw new Error(`archive collision for ${skill.slug}@${spec.version}: stored bytes do not match the seed`);
      }
    }
    await publishSkillVersion({ actor, orgId, payload, archiveKey: key, database });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function seedDemoContent(actor: ActorContext): Promise<void> {
  const orgs = await listOrgs(actor);
  if (orgs.length === 0) return;
  const orgId = orgs[0]!.org_id;

  await withTenantContext({ orgId, userId: actor.id }, async (database) => {
    await database
      .insert(schema.labels)
      .values(DEMO_EMPTY_ORG_LABELS.map((path) => ({ orgId, path, createdBy: actor.id })))
      .onConflictDoNothing();
    await database
      .insert(schema.personalLabels)
      .values(DEMO_EMPTY_PERSONAL_LABELS.map((path) => ({ orgId, ownerId: actor.id, path })))
      .onConflictDoNothing();

    // Default workspace-activated models (ids from the sandbox catalog's offline fallback registry)
    // so the hard createRun activation gate never bricks a fresh dev workspace.
    await database
      .insert(schema.orgModelPreferences)
      .values({
        orgId,
        activatedModels: ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-5", "anthropic/claude-sonnet-4-5"],
        createdBy: actor.id,
      })
      .onConflictDoNothing();
  });

  if (!storageConfigured()) {
    console.warn("Skipping demo skills: S3 storage is not configured (S3_ENDPOINT and related env vars)");
    return;
  }

  // Catalog order keeps declared dependencies ahead of dependents. Versions within one skill are
  // applied oldest-first, and the existence check makes interrupted and repeated seeds resumable.
  for (const skill of DEMO_SKILL_CATALOG) {
    const versions = [...skill.versions].sort((a, b) => compareSemver(a.version, b.version));
    for (const version of versions) {
      const state = await withTenantContext({ orgId, userId: actor.id }, async (database) => {
        const row = await database.query.skills.findFirst({
          where: and(eq(schema.skills.orgId, orgId), eq(schema.skills.slug, skill.slug)),
        });
        if (!row) return { compatible: true, exists: false, latest: null };
        const currentVersion = row.currentVersionId
          ? await database.query.skillVersions.findFirst({
              where: and(
                eq(schema.skillVersions.orgId, orgId),
                eq(schema.skillVersions.id, row.currentVersionId),
              ),
            })
          : null;
        const compatible =
          row.creatorId === actor.id &&
          row.scope === skill.scope &&
          currentVersion?.createdBy === actor.id &&
          currentVersion.note === SEED_VERSION_NOTE;
        const rows = await database
          .select({ version: schema.skillVersions.version })
          .from(schema.skillVersions)
          .where(and(eq(schema.skillVersions.orgId, orgId), eq(schema.skillVersions.skillId, row.id)));
        const existing = rows.map((item) => item.version);
        return {
          compatible,
          exists: existing.includes(version.version),
          latest: existing.sort((a, b) => compareSemver(b, a))[0] ?? null,
        };
      });
      if (!state.compatible) {
        console.warn(`Skipped skill ${skill.slug}@${version.version}: slug belongs to non-seed content`);
        break;
      }
      if (state.exists) continue;
      if (state.latest && compareSemver(version.version, state.latest) <= 0) {
        console.warn(`Skipped skill ${skill.slug}@${version.version}: current seed data is already newer (${state.latest})`);
        continue;
      }
      try {
        await withTenantContext({ orgId, userId: actor.id }, (database) =>
          seedSkill(actor, orgId, skill, version, database),
        );
        console.log(`Seeded skill ${skill.slug}@${version.version}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Skipped skill ${skill.slug}@${version.version}: ${message}`);
      }
    }
  }

  await withTenantContext({ orgId, userId: actor.id }, async (database) => {
    const fixtures = await loadSeedFixtures(actor, orgId, database);
    const preexistingInstalls = new Set(
      (
        await database.query.skillInstalls.findMany({
          where: and(eq(schema.skillInstalls.orgId, orgId), eq(schema.skillInstalls.userId, actor.id)),
        })
      ).map((install) => install.skillId),
    );
    await seedDependencyShowcase(actor, orgId, fixtures, database);
    for (const install of DEMO_INSTALLS) {
      const skill = fixtures.get(install.slug);
      if (!skill || skill.scope !== "org") continue;
      const installClosure = await seedInstallClosure(orgId, skill.id, database);
      // Installing a root upserts its dependency closure. If any row predated this seed run, skip
      // the root so local versions, labels, sources, and timestamps remain the developer's choice.
      if ([...installClosure].some((skillId) => preexistingInstalls.has(skillId))) continue;
      const existing = await database.query.skillInstalls.findFirst({
        where: and(
          eq(schema.skillInstalls.orgId, orgId),
          eq(schema.skillInstalls.userId, actor.id),
          eq(schema.skillInstalls.skillId, skill.id),
        ),
      });
      // Preserve an existing local install choice and avoid adding audit noise on every dev restart.
      if (existing) continue;
      await installSkill({
        actor,
        orgId,
        slug: install.slug,
        version: install.version,
        source: "manual",
        agentLabel: "Seed fixture",
        database,
      });
    }
  });
}

async function seedInstallClosure(
  orgId: string,
  rootSkillId: string,
  database: Db,
): Promise<Set<string>> {
  const closure = new Set<string>();
  const pending = [rootSkillId];
  while (pending.length) {
    const skillId = pending.pop()!;
    if (closure.has(skillId)) continue;
    closure.add(skillId);
    const skill = await database.query.skills.findFirst({
      where: and(eq(schema.skills.orgId, orgId), eq(schema.skills.id, skillId)),
    });
    if (!skill?.currentVersionId) continue;
    const dependencies = await database
      .select({ skillId: schema.skillVersionDependencies.dependsOnSkillId })
      .from(schema.skillVersionDependencies)
      .where(
        and(
          eq(schema.skillVersionDependencies.orgId, orgId),
          eq(schema.skillVersionDependencies.skillVersionId, skill.currentVersionId),
        ),
      );
    for (const dependency of dependencies) {
      if (dependency.skillId) pending.push(dependency.skillId);
    }
  }
  return closure;
}

interface SeedFixtureRow {
  id: string;
  slug: string;
  scope: "org" | "personal";
  currentVersionId: string;
}

async function loadSeedFixtures(actor: ActorContext, orgId: string, database: Db): Promise<Map<string, SeedFixtureRow>> {
  const rows = await database
    .select({
      id: schema.skills.id,
      slug: schema.skills.slug,
      scope: schema.skills.scope,
      creatorId: schema.skills.creatorId,
      currentVersionId: schema.skills.currentVersionId,
      currentVersion: schema.skillVersions.version,
      currentVersionNote: schema.skillVersions.note,
      currentVersionCreatorId: schema.skillVersions.createdBy,
    })
    .from(schema.skills)
    .innerJoin(
      schema.skillVersions,
      and(
        eq(schema.skillVersions.orgId, schema.skills.orgId),
        eq(schema.skillVersions.id, schema.skills.currentVersionId),
      ),
    )
    .where(eq(schema.skills.orgId, orgId));
  const catalog = new Map(DEMO_SKILL_CATALOG.map((skill) => [skill.slug, skill] as const));
  return new Map(
    rows
      .filter((row): row is typeof row & { currentVersionId: string } => {
        const spec = catalog.get(row.slug);
        const expectedVersion = spec?.versions.at(-1)?.version;
        return Boolean(
          spec &&
            row.creatorId === actor.id &&
            row.scope === spec.scope &&
            row.currentVersion === expectedVersion &&
            row.currentVersionCreatorId === actor.id &&
            row.currentVersionNote === SEED_VERSION_NOTE &&
            row.currentVersionId,
        );
      })
      .map((row) => [row.slug, row] as const),
  );
}

/** Insert deliberately invalid dependency states after normal publish-time validation has run. */
async function seedDependencyShowcase(
  actor: ActorContext,
  orgId: string,
  bySlug: Map<string, SeedFixtureRow>,
  database: Db,
): Promise<void> {

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

  const edges = DEMO_FORCED_DEPENDENCIES.map(({ dependent, dependency }) => edge(dependent, dependency)).filter(
    (e): e is NonNullable<typeof e> => e != null,
  );

  if (edges.length) {
    await database.insert(schema.skillVersionDependencies).values(edges).onConflictDoNothing();
  }

  // Clean up legacy invalid showcase edges so an existing local workspace becomes runnable
  // after the seed command is re-run. These edges were never declared by incident-summary.
  const incidentSummary = bySlug.get("incident-summary");
  if (incidentSummary?.currentVersionId) {
    await database
      .delete(schema.skillVersionDependencies)
      .where(
        and(
          eq(schema.skillVersionDependencies.orgId, orgId),
          eq(schema.skillVersionDependencies.skillVersionId, incidentSummary.currentVersionId),
          inArray(schema.skillVersionDependencies.dependsOnSlug, ["html-sanitize", "screenshot-grab"]),
        ),
      );
  }

  // Keep two unrelated archived rows for archive-list and restore flows.
  const toArchive = DEMO_ARCHIVED_SLUGS.map((slug) => bySlug.get(slug)?.id).filter((id): id is string => !!id);
  if (toArchive.length) {
    await database
      .update(schema.skills)
      .set({ archivedAt: new Date(), archivedBy: actor.id, archiveReason: "Superseded — seeded archive demo" })
      .where(and(eq(schema.skills.orgId, orgId), inArray(schema.skills.id, toArchive), isNull(schema.skills.archivedAt)));
  }

  for (const fixture of DEMO_INVALID_SKILLS) {
    const skill = bySlug.get(fixture.slug);
    if (!skill) continue;
    await database
      .update(schema.skills)
      .set({ validation: "invalid", validationError: fixture.error })
      .where(and(eq(schema.skills.orgId, orgId), eq(schema.skills.id, skill.id)));
    if (skill.currentVersionId) {
      await database
        .update(schema.skillVersions)
        .set({ validation: "invalid", validationError: fixture.error })
        .where(and(eq(schema.skillVersions.orgId, orgId), eq(schema.skillVersions.id, skill.currentVersionId)));
    }
  }
  console.log("Seeded dependency, archive, and validation showcases");
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

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDb();
    });
}
