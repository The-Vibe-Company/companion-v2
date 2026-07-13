import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema, type Db } from "@companion/db";

if (process.env.COMPANION_INTEGRATION_TESTS !== "1") {
  throw new Error("integration tests must run through the explicit test:integration command");
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("integration tests require an explicit disposable DATABASE_URL");
}

export const integrationSql = postgres(databaseUrl, { max: 10 });
export const integrationDb = drizzle(integrationSql, { schema }) as Db;

export interface TestActor {
  id: string;
  email: string;
  name: string;
}

export interface IntegrationFixture {
  suffix: string;
  orgA: string;
  orgB: string;
  owner: TestActor;
  admin: TestActor;
  developer: TestActor;
  outsider: TestActor;
  cleanup(): Promise<void>;
}

function actor(prefix: string, suffix: string): TestActor {
  return {
    id: `${prefix}-${suffix}`,
    email: `${prefix}-${suffix}@example.test`,
    name: prefix[0]!.toUpperCase() + prefix.slice(1),
  };
}

export async function createIntegrationFixture(): Promise<IntegrationFixture> {
  const suffix = randomUUID();
  const orgA = randomUUID();
  const orgB = randomUUID();
  const owner = actor("owner", suffix);
  const admin = actor("admin", suffix);
  const developer = actor("developer", suffix);
  const outsider = actor("outsider", suffix);
  const actors = [owner, admin, developer, outsider];

  await integrationDb.insert(schema.user).values(
    actors.map((value) => ({
      id: value.id,
      name: value.name,
      email: value.email,
      emailVerified: true,
    })),
  );
  await integrationDb.insert(schema.profiles).values(
    actors.map((value) => ({
      id: value.id,
      name: value.name,
      email: value.email,
      initials: value.name.slice(0, 2).toUpperCase(),
      onboardedAt: new Date(),
    })),
  );
  await integrationDb.insert(schema.organizations).values([
    { id: orgA, name: `Integration A ${suffix}`, slug: `integration-a-${suffix}` },
    { id: orgB, name: `Integration B ${suffix}`, slug: `integration-b-${suffix}` },
  ]);
  await integrationDb.insert(schema.memberships).values([
    { orgId: orgA, userId: owner.id, orgRole: "owner" },
    { orgId: orgA, userId: admin.id, orgRole: "admin" },
    { orgId: orgA, userId: developer.id, orgRole: "developer" },
    { orgId: orgB, userId: outsider.id, orgRole: "owner" },
  ]);

  return {
    suffix,
    orgA,
    orgB,
    owner,
    admin,
    developer,
    outsider,
    async cleanup() {
      await integrationDb.delete(schema.organizations).where(inArray(schema.organizations.id, [orgA, orgB]));
      await integrationDb.delete(schema.user).where(inArray(schema.user.id, actors.map((value) => value.id)));
    },
  };
}

export interface SeededSkill {
  id: string;
  versionId: string;
  slug: string;
  orgId: string;
}

export async function seedSkill(input: {
  orgId: string;
  creator: TestActor;
  slug: string;
  scope: "personal" | "org";
  description?: string;
}): Promise<SeededSkill> {
  const id = randomUUID();
  const versionId = randomUUID();
  const description = input.description ?? `Integration skill ${input.slug}`;
  await integrationDb.insert(schema.skills).values({
    id,
    orgId: input.orgId,
    slug: input.slug,
    description,
    creatorId: input.creator.id,
    scope: input.scope,
  });
  await integrationDb.insert(schema.skillVersions).values({
    id: versionId,
    orgId: input.orgId,
    skillId: id,
    version: "1.0.0",
    frontmatter: JSON.stringify({ name: input.slug, description, metadata: {} }),
    body: `# ${input.slug}\n\n${description}`,
    sizeBytes: 128,
    checksum: `sha256:${"a".repeat(64)}`,
    storagePath: `integration/${input.orgId}/${input.slug}/1.0.0.tar.gz`,
    createdBy: input.creator.id,
  });
  await integrationDb
    .update(schema.skills)
    .set({ currentVersionId: versionId })
    .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.id, id)));
  return { id, versionId, slug: input.slug, orgId: input.orgId };
}

export async function seedPersonalLabel(input: {
  orgId: string;
  owner: TestActor;
  skillId: string;
  path: string;
}): Promise<void> {
  await integrationDb.insert(schema.personalLabels).values({
    orgId: input.orgId,
    ownerId: input.owner.id,
    path: input.path,
  });
  await integrationDb.insert(schema.personalSkillLabels).values({
    orgId: input.orgId,
    ownerId: input.owner.id,
    skillId: input.skillId,
    path: input.path,
  });
}
