import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSecret,
  createSecretRetrievalGrant,
  issueApiToken,
  preflightSecretRetrieval,
  redeemSecretRetrievalGrant,
  removeMember,
  rotateSecret,
  updateSecret,
} from "@companion/core/services";
import { schema } from "@companion/db";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
  type TestActor,
} from "./testDatabase";

process.env.COMPANION_BILLING_MODE = "off";
process.env.COMPANION_SECRETS_MASTER_KEY ??= Buffer.alloc(32, 9).toString("base64");

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@companion/auth", () => ({
  auth: {
    api: { getSession: vi.fn(async () => null) },
    handler: vi.fn(),
    $Infer: {},
  },
  registerAgentCapabilityExecutor: vi.fn(() => () => undefined),
}));

import { app } from "../../src/index";

async function token(actor: TestActor, orgId: string, scopes: Array<"secrets:read" | "secrets:write">) {
  return issueApiToken({ actor, orgId, scopes, database: integrationDb });
}

function request(bearer: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return app.request(path, { ...init, headers });
}

/**
 * Product promise:
 * Secret values are write-only, access follows the current owner/audience/recipient ACL, and a
 * short-lived retrieval grant can reveal plaintext exactly once.
 *
 * Regression caught:
 * Returning or persisting plaintext, giving admins implicit access, accepting the wrong PAT scope,
 * or redeeming a grant twice would disclose organization credentials.
 *
 * Why this test is integrated:
 * The guarantee spans HTTP scopes, service authorization, encryption, transactions, audit rows,
 * Postgres RLS, and concurrent redemption; mocks cannot prove those layers agree.
 *
 * Failure proof:
 * Returning the submitted sentinel, granting admins owner access, or removing the atomic redeemed_at
 * guard must make this suite fail.
 */
describe("write-only secret lifecycle", () => {
  let fixture: IntegrationFixture;
  let role: string;

  beforeEach(async () => {
    fixture = await createIntegrationFixture();
    role = `companion_secret_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    await integrationSql.unsafe(`create role ${role} nologin`);
    await integrationSql.unsafe(`grant ${role} to current_user with inherit true, set true`);
    await integrationSql.unsafe(`grant usage on schema public to ${role}`);
    await integrationSql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${role}`);
    await integrationSql.unsafe(`grant usage, select on all sequences in schema public to ${role}`);
  });

  afterEach(async () => {
    await integrationSql.unsafe(`drop owned by ${role}`);
    await integrationSql.unsafe(`revoke ${role} from current_user`);
    await integrationSql.unsafe(`drop role ${role}`);
    await fixture.cleanup();
  });

  async function visibleSecretIds(orgId: string, userId: string): Promise<string[]> {
    return integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('app.org_id', ${orgId}, true), set_config('app.user_id', ${userId}, true)`;
      const rows = await tx<Array<{ id: string }>>`select id from secrets order by id`;
      return rows.map((row) => row.id);
    });
  }

  async function cannotRenameSecretAs(userId: string, secretId: string): Promise<boolean> {
    return integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${userId}, true)`;
      const rows = await tx<Array<{ id: string }>>`
        update secrets set name = 'forbidden-rls-rename' where id = ${secretId}::uuid returning id
      `;
      return rows.length === 0;
    });
  }

  it("never returns or persists plaintext and gives an admin no implicit access", async () => {
    const sentinel = `sentinel-${randomUUID()}`;
    const emittedLogs: unknown[][] = [];
    const logSpies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        emittedLogs.push(args);
      }),
    );
    const ownerWrite = await token(fixture.owner, fixture.orgA, ["secrets:write"]);
    const ownerRead = await token(fixture.owner, fixture.orgA, ["secrets:read"]);
    const recipientRead = await token(fixture.developer, fixture.orgA, ["secrets:read"]);
    const adminRead = await token(fixture.admin, fixture.orgA, ["secrets:read"]);
    const outsiderRead = await token(fixture.outsider, fixture.orgB, ["secrets:read"]);

    const createdResponse = await request(ownerWrite.token, "/v1/secrets", {
      method: "POST",
      body: JSON.stringify({
        name: "Integration credential",
        key: "INTEGRATION_SECRET",
        value: sentinel,
        audience: "restricted",
        recipient_ids: [fixture.developer.id],
      }),
    });
    expect(createdResponse.status).toBe(201);
    const createdText = await createdResponse.text();
    expect(createdText).not.toContain(sentinel);
    const created = JSON.parse(createdText) as { id: string };

    const persisted = await integrationSql<Array<{ row: string }>>`
      select row_to_json(v)::text as row from secret_versions v
      where v.org_id = ${fixture.orgA}::uuid and v.secret_id = ${created.id}::uuid
    `;
    const audited = await integrationSql<Array<{ row: string }>>`
      select row_to_json(a)::text as row from audit_log a
      where a.org_id = ${fixture.orgA}::uuid and a.target_id = ${created.id}
    `;
    expect(JSON.stringify(persisted)).not.toContain(sentinel);
    expect(JSON.stringify(audited)).not.toContain(sentinel);
    expect(JSON.stringify(emittedLogs)).not.toContain(sentinel);

    const writeCannotRead = await request(ownerWrite.token, "/v1/secrets");
    expect(writeCannotRead.status).toBe(401);
    await expect(writeCannotRead.json()).resolves.toMatchObject({ error: expect.stringContaining("secrets:read") });

    const ownerList = await request(ownerRead.token, "/v1/secrets");
    expect(JSON.stringify(await ownerList.json())).toContain(created.id);
    const recipientList = await request(recipientRead.token, "/v1/secrets");
    expect(JSON.stringify(await recipientList.json())).toContain(created.id);
    const adminList = await request(adminRead.token, "/v1/secrets");
    expect(JSON.stringify(await adminList.json())).not.toContain(created.id);
    const outsiderDetail = await request(outsiderRead.token, `/v1/secrets/${created.id}`);
    expect(outsiderDetail.status).toBe(404);
    await expect(outsiderDetail.json()).resolves.toMatchObject({ error: "secret not found" });

    expect(await visibleSecretIds(fixture.orgA, fixture.owner.id)).toContain(created.id);
    expect(await visibleSecretIds(fixture.orgA, fixture.developer.id)).toContain(created.id);
    expect(await visibleSecretIds(fixture.orgA, fixture.admin.id)).not.toContain(created.id);
    expect(await visibleSecretIds(fixture.orgB, fixture.outsider.id)).not.toContain(created.id);
    expect(await cannotRenameSecretAs(fixture.admin.id, created.id)).toBe(true);
    logSpies.forEach((spy) => spy.mockRestore());
  });

  it("allows an authorized read token to redeem once and rejects replay or changed access", async () => {
    const sentinel = `grant-${randomUUID()}`;
    const created = await createSecret({
      actor: fixture.owner,
      orgId: fixture.orgA,
      database: integrationDb,
      value: {
        name: "Grant credential",
        key: "GRANT_SECRET",
        value: sentinel,
        audience: "restricted",
        recipient_ids: [fixture.developer.id],
      },
    });
    const recipientRead = await token(fixture.developer, fixture.orgA, ["secrets:read"]);
    const ownerWrite = await token(fixture.owner, fixture.orgA, ["secrets:write"]);
    const preflightBody = {
      operation_id: randomUUID(),
      skills: [],
      direct: [{ secret_id: created.id, env_key: "GRANT_SECRET", profile: "integration" }],
    };

    const wrongScope = await request(ownerWrite.token, "/v1/secret-retrievals/preflight", {
      method: "POST",
      body: JSON.stringify(preflightBody),
    });
    expect(wrongScope.status).toBeGreaterThanOrEqual(400);
    await expect(wrongScope.json()).resolves.toMatchObject({ error: expect.stringContaining("secrets:read") });

    const preflightResponse = await request(recipientRead.token, "/v1/secret-retrievals/preflight", {
      method: "POST",
      body: JSON.stringify(preflightBody),
    });
    expect(preflightResponse.status).toBe(200);
    const preflight = (await preflightResponse.json()) as { plan_id: string };
    const grantResponse = await request(recipientRead.token, `/v1/secret-retrievals/${preflight.plan_id}/grant`, {
      method: "POST",
    });
    expect(grantResponse.status).toBe(200);
    const grant = (await grantResponse.json()) as { grant: string };

    const [first, second] = await Promise.all([
      request(recipientRead.token, "/v1/secret-grants/redeem", {
        method: "POST",
        body: JSON.stringify({ grant: grant.grant }),
      }),
      request(recipientRead.token, "/v1/secret-grants/redeem", {
        method: "POST",
        body: JSON.stringify({ grant: grant.grant }),
      }),
    ]);
    const responses = [first, second].sort((a, b) => a.status - b.status);
    expect(responses.map((response) => response.status)).toEqual([200, 409]);
    expect(await responses[0]!.text()).toContain(sentinel);
    await expect(responses[1]!.json()).resolves.toMatchObject({ error: expect.stringContaining("already used") });

    const revocationPreflight = await preflightSecretRetrieval({
      actor: fixture.developer,
      orgId: fixture.orgA,
      database: integrationDb,
      value: {
        operation_id: randomUUID(),
        skills: [],
        direct: [{ secret_id: created.id, env_key: "GRANT_SECRET", profile: "revoked" }],
      },
    });
    const revocationGrant = await createSecretRetrievalGrant({
      actor: fixture.developer,
      orgId: fixture.orgA,
      planId: revocationPreflight.plan_id,
      database: integrationDb,
    });
    await updateSecret({
      actor: fixture.owner,
      orgId: fixture.orgA,
      secretId: created.id,
      database: integrationDb,
      value: { audience: "personal", recipient_ids: [] },
    });
    const revoked = await redeemSecretRetrievalGrant({
      actor: fixture.developer,
      orgId: fixture.orgA,
      grant: revocationGrant.grant,
      database: integrationDb,
    });
    expect(revoked).toMatchObject({ ok: false, error: expect.stringContaining("access changed") });

    // Rotation is version-pinned by design: a confirmed plan remains on the exact reviewed version,
    // while every later plan moves to the new value. This prevents a value changing between human
    // confirmation and redemption without letting future syncs keep using a superseded credential.
    const beforeRotation = await preflightSecretRetrieval({
      actor: fixture.owner,
      orgId: fixture.orgA,
      database: integrationDb,
      value: {
        operation_id: randomUUID(),
        skills: [],
        direct: [{ secret_id: created.id, env_key: "GRANT_SECRET", profile: "before-rotation" }],
      },
    });
    const beforeRotationGrant = await createSecretRetrievalGrant({
      actor: fixture.owner,
      orgId: fixture.orgA,
      planId: beforeRotation.plan_id,
      database: integrationDb,
    });
    const rotatedSentinel = `rotated-${randomUUID()}`;
    await rotateSecret({
      actor: fixture.owner,
      orgId: fixture.orgA,
      secretId: created.id,
      value: rotatedSentinel,
      database: integrationDb,
    });
    const pinnedRedemption = await redeemSecretRetrievalGrant({
      actor: fixture.owner,
      orgId: fixture.orgA,
      grant: beforeRotationGrant.grant,
      database: integrationDb,
    });
    expect(pinnedRedemption).toMatchObject({
      ok: true,
      value: { items: [expect.objectContaining({ secret_version: 1, value: sentinel })] },
    });

    const afterRotation = await preflightSecretRetrieval({
      actor: fixture.owner,
      orgId: fixture.orgA,
      database: integrationDb,
      value: {
        operation_id: randomUUID(),
        skills: [],
        direct: [{ secret_id: created.id, env_key: "GRANT_SECRET", profile: "after-rotation" }],
      },
    });
    expect(afterRotation.items).toEqual([expect.objectContaining({ secret_version: 2 })]);
    const afterRotationGrant = await createSecretRetrievalGrant({
      actor: fixture.owner,
      orgId: fixture.orgA,
      planId: afterRotation.plan_id,
      database: integrationDb,
    });
    const rotatedRedemption = await redeemSecretRetrievalGrant({
      actor: fixture.owner,
      orgId: fixture.orgA,
      grant: afterRotationGrant.grant,
      database: integrationDb,
    });
    expect(rotatedRedemption).toMatchObject({
      ok: true,
      value: { items: [expect.objectContaining({ secret_version: 2, value: rotatedSentinel })] },
    });
  });

  it("disables a departing member's secrets before removing their membership", async () => {
    const sentinel = `departing-${randomUUID()}`;
    const created = await createSecret({
      actor: fixture.developer,
      orgId: fixture.orgA,
      database: integrationDb,
      value: {
        name: "Departing member credential",
        key: "DEPARTING_SECRET",
        value: sentinel,
        audience: "organization",
        recipient_ids: [],
      },
    });

    await removeMember({
      actor: fixture.admin,
      orgId: fixture.orgA,
      userId: fixture.developer.id,
      database: integrationDb,
    });

    await expect(
      integrationDb.query.memberships.findFirst({
        where: and(eq(schema.memberships.orgId, fixture.orgA), eq(schema.memberships.userId, fixture.developer.id)),
      }),
    ).resolves.toBeUndefined();
    await expect(
      integrationDb.query.secrets.findFirst({ where: eq(schema.secrets.id, created.id) }),
    ).resolves.toMatchObject({ disabledAt: expect.any(Date) });
    await expect(
      preflightSecretRetrieval({
        actor: fixture.developer,
        orgId: fixture.orgA,
        database: integrationDb,
        value: {
          operation_id: randomUUID(),
          skills: [],
          direct: [{ secret_id: created.id, env_key: "DEPARTING_SECRET", profile: "removed" }],
        },
      }),
    ).rejects.toThrow("not a member");

    const persisted = await integrationSql<Array<{ row: string }>>`
      select row_to_json(v)::text as row from secret_versions v where v.secret_id = ${created.id}::uuid
    `;
    expect(JSON.stringify(persisted)).not.toContain(sentinel);
  });

  it("serializes concurrent preflight and grant quota claims without exceeding durable limits", async () => {
    const created = await createSecret({
      actor: fixture.owner,
      orgId: fixture.orgA,
      database: integrationDb,
      value: {
        name: "Rate-limit credential",
        key: "RATE_LIMIT_SECRET",
        value: `rate-${randomUUID()}`,
        audience: "organization",
        recipient_ids: [],
      },
    });
    const retrieval = () => ({
      operation_id: randomUUID(),
      skills: [],
      direct: [{ secret_id: created.id, env_key: "RATE_LIMIT_SECRET", profile: "rate-limit" }],
    });

    const preflightAttempts = await Promise.allSettled(
      Array.from({ length: 32 }, () =>
        preflightSecretRetrieval({
          actor: fixture.developer,
          orgId: fixture.orgA,
          database: integrationDb,
          value: retrieval(),
        }),
      ),
    );
    const acceptedPreflights = preflightAttempts.filter((result) => result.status === "fulfilled");
    expect(acceptedPreflights).toHaveLength(30);
    expect(preflightAttempts.filter((result) => result.status === "rejected")).toHaveLength(2);

    const planIds = acceptedPreflights.slice(0, 12).map((result) => result.value.plan_id);
    const grantAttempts = await Promise.allSettled(
      planIds.map((planId) =>
        createSecretRetrievalGrant({
          actor: fixture.developer,
          orgId: fixture.orgA,
          planId,
          database: integrationDb,
        }),
      ),
    );
    expect(grantAttempts.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    expect(grantAttempts.filter((result) => result.status === "rejected")).toHaveLength(2);

    const [claimCounts] = await integrationSql<Array<{ preflight: number; grant: number }>>`
      select
        count(*) filter (where target_id = 'preflight')::int as preflight,
        count(*) filter (where target_id = 'grant')::int as grant
      from audit_log
      where org_id = ${fixture.orgA}::uuid
        and actor_id = ${fixture.developer.id}
        and action = 'secret.retrieval.rate_claim'
    `;
    expect(claimCounts).toEqual({ preflight: 30, grant: 10 });
  }, 30_000);
});
