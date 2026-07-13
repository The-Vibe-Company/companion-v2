import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecret,
  createSecretRetrievalGrant,
  preflightSecretRetrieval,
  redeemSecretRetrievalGrant,
  updateSecret,
} from "@companion/core";
import { schema, type Db } from "@companion/db";

const enabled = process.env.RUN_SECRET_DB_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://companion:companion@127.0.0.1:5432/companion";
process.env.COMPANION_SECRETS_MASTER_KEY ??= Buffer.alloc(32, 9).toString("base64");

describe.skipIf(!enabled)("Secrets database security boundary", () => {
  const sql = postgres(databaseUrl, { max: 4 });
  const database = drizzle(sql, { schema }) as Db;
  const suffix = randomUUID();
  const orgA = randomUUID();
  const orgB = randomUUID();
  const owner = { id: `secret-owner-${suffix}`, email: `owner-${suffix}@example.test`, name: "Secret Owner" };
  const recipient = { id: `secret-recipient-${suffix}`, email: `recipient-${suffix}@example.test`, name: "Secret Recipient" };
  const admin = { id: `secret-admin-${suffix}`, email: `admin-${suffix}@example.test`, name: "Secret Admin" };
  const rateUser = { id: `secret-rate-${suffix}`, email: `rate-${suffix}@example.test`, name: "Secret Rate User" };
  const outsider = { id: `secret-outsider-${suffix}`, email: `outsider-${suffix}@example.test`, name: "Secret Outsider" };
  const actors = [owner, recipient, admin, rateUser, outsider];
  const rlsRole = `companion_secret_rls_${suffix.replaceAll("-", "").slice(0, 20)}`;

  async function visibleSecretIds(orgId: string, userId: string): Promise<string[]> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      await tx`select set_config('app.org_id', ${orgId}, true), set_config('app.user_id', ${userId}, true)`;
      const rows = await tx<{ id: string }[]>`select id from secrets order by id`;
      return rows.map((row) => row.id);
    });
  }

  async function adminCannotRename(secretId: string): Promise<boolean> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      await tx`select set_config('app.org_id', ${orgA}, true), set_config('app.user_id', ${admin.id}, true)`;
      const rows = await tx<{ id: string }[]>`update secrets set name = 'forbidden-admin-rename' where id = ${secretId}::uuid returning id`;
      return rows.length === 0;
    });
  }

  beforeAll(async () => {
    for (const actor of actors) {
      await database.insert(schema.user).values({ id: actor.id, name: actor.name, email: actor.email, emailVerified: true });
      await database.insert(schema.profiles).values({ id: actor.id, name: actor.name, email: actor.email, initials: actor.name.split(" ").map((part) => part[0]).join(""), onboardedAt: new Date() });
    }
    await database.insert(schema.organizations).values([
      { id: orgA, name: "Secrets integration A", slug: `secrets-integration-a-${suffix}` },
      { id: orgB, name: "Secrets integration B", slug: `secrets-integration-b-${suffix}` },
    ]);
    await database.insert(schema.memberships).values([
      { orgId: orgA, userId: owner.id, orgRole: "owner" },
      { orgId: orgA, userId: recipient.id, orgRole: "developer" },
      { orgId: orgA, userId: admin.id, orgRole: "admin" },
      { orgId: orgA, userId: rateUser.id, orgRole: "developer" },
      { orgId: orgB, userId: outsider.id, orgRole: "owner" },
    ]);
    await sql.unsafe(`create role ${rlsRole} nologin`);
    await sql.unsafe(`grant usage on schema public to ${rlsRole}`);
    await sql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${rlsRole}`);
    await sql.unsafe(`grant usage, select on all sequences in schema public to ${rlsRole}`);
  });

  afterAll(async () => {
    await sql`delete from organizations where id in (${orgA}::uuid, ${orgB}::uuid)`;
    for (const actor of actors) await sql`delete from "user" where id = ${actor.id}`;
    await sql.unsafe(`drop owned by ${rlsRole}`);
    await sql.unsafe(`drop role ${rlsRole}`);
    await sql.end();
  });

  it("enforces RLS/ACLs, keeps persistence value-free, and consumes grants once", async () => {
    const sentinel = `sentinel-${randomUUID()}`;
    const created = await createSecret({
      actor: owner,
      orgId: orgA,
      database,
      value: {
        name: "Integration credential",
        key: "INTEGRATION_SECRET",
        value: sentinel,
        audience: "restricted",
        recipient_ids: [recipient.id],
      },
    });

    expect(JSON.stringify(created)).not.toContain(sentinel);
    const persisted = await sql<{ row: string }[]>`
      select row_to_json(v)::text as row from secret_versions v
      where v.org_id = ${orgA}::uuid and v.secret_id = ${created.id}::uuid
    `;
    expect(JSON.stringify(persisted)).not.toContain(sentinel);
    const audited = await sql<{ row: string }[]>`
      select row_to_json(a)::text as row from audit_log a
      where a.org_id = ${orgA}::uuid and a.target_id = ${created.id}
    `;
    expect(JSON.stringify(audited)).not.toContain(sentinel);

    expect(await visibleSecretIds(orgA, owner.id)).toContain(created.id);
    expect(await visibleSecretIds(orgA, recipient.id)).toContain(created.id);
    expect(await visibleSecretIds(orgA, admin.id)).not.toContain(created.id);
    expect(await visibleSecretIds(orgB, outsider.id)).not.toContain(created.id);
    expect(await adminCannotRename(created.id)).toBe(true);

    await expect(preflightSecretRetrieval({
      actor: outsider,
      orgId: orgA,
      database,
      value: { operation_id: randomUUID(), skills: [], direct: [{ secret_id: created.id, env_key: "INTEGRATION_SECRET", profile: "cross-tenant" }] },
    })).rejects.toThrow("not a member");

    const preflight = await preflightSecretRetrieval({
      actor: recipient,
      orgId: orgA,
      database,
      value: { operation_id: randomUUID(), skills: [], direct: [{ secret_id: created.id, env_key: "INTEGRATION_SECRET", profile: "integration" }] },
    });
    const grant = await createSecretRetrievalGrant({ actor: recipient, orgId: orgA, planId: preflight.plan_id, database });
    const concurrentRedemptions = await Promise.all([
      redeemSecretRetrievalGrant({ actor: recipient, orgId: orgA, grant: grant.grant, database }),
      redeemSecretRetrievalGrant({ actor: recipient, orgId: orgA, grant: grant.grant, database }),
    ]);
    const redeemed = concurrentRedemptions.filter((result) => result.ok);
    const replayed = concurrentRedemptions.filter((result) => !result.ok);
    expect(redeemed).toHaveLength(1);
    expect(replayed).toHaveLength(1);
    if (redeemed[0]?.ok) expect(redeemed[0].value.items[0]?.value).toBe(sentinel);
    expect(replayed[0]).toMatchObject({ ok: false, error: expect.stringContaining("already used") });

    const revocationPlan = await preflightSecretRetrieval({
      actor: recipient,
      orgId: orgA,
      database,
      value: { operation_id: randomUUID(), skills: [], direct: [{ secret_id: created.id, env_key: "INTEGRATION_SECRET", profile: "revoked" }] },
    });
    const revocationGrant = await createSecretRetrievalGrant({ actor: recipient, orgId: orgA, planId: revocationPlan.plan_id, database });
    await updateSecret({ actor: owner, orgId: orgA, secretId: created.id, database, value: { audience: "personal", recipient_ids: [] } });
    expect(await visibleSecretIds(orgA, recipient.id)).not.toContain(created.id);
    const revoked = await redeemSecretRetrievalGrant({ actor: recipient, orgId: orgA, grant: revocationGrant.grant, database });
    expect(revoked).toMatchObject({ ok: false, error: expect.stringContaining("access changed") });

    const rateSecret = await createSecret({
      actor: owner,
      orgId: orgA,
      database,
      value: {
        name: "Rate-limit credential",
        key: "RATE_LIMIT_SECRET",
        value: `rate-${randomUUID()}`,
        audience: "organization",
        recipient_ids: [],
      },
    });
    const preflightAttempts = await Promise.allSettled(Array.from({ length: 32 }, () => preflightSecretRetrieval({
      actor: rateUser,
      orgId: orgA,
      database,
      value: { operation_id: randomUUID(), skills: [], direct: [{ secret_id: rateSecret.id, env_key: "RATE_LIMIT_SECRET", profile: "rate-limit" }] },
    })));
    const acceptedPreflights = preflightAttempts.filter((result) => result.status === "fulfilled");
    const limitedPreflights = preflightAttempts.filter((result) => result.status === "rejected");
    expect(acceptedPreflights).toHaveLength(30);
    expect(limitedPreflights).toHaveLength(2);

    const planIds = acceptedPreflights.slice(0, 12).map((result) => result.value.plan_id);
    const grantAttempts = await Promise.allSettled(planIds.map((planId) => createSecretRetrievalGrant({
      actor: rateUser,
      orgId: orgA,
      planId,
      database,
    })));
    expect(grantAttempts.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    expect(grantAttempts.filter((result) => result.status === "rejected")).toHaveLength(2);
    const [claimCounts] = await sql<{ preflight: number; grant: number }[]>`
      select
        count(*) filter (where target_id = 'preflight')::int as preflight,
        count(*) filter (where target_id = 'grant')::int as grant
      from audit_log
      where org_id = ${orgA}::uuid
        and actor_id = ${rateUser.id}
        and action = 'secret.retrieval.rate_claim'
    `;
    expect(claimCounts).toEqual({ preflight: 30, grant: 10 });
  }, 30_000);
});
