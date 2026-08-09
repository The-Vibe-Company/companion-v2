/**
 * Product promise:
 * Getting-started progress is monotonic, creator-private, workspace-scoped, cross-device durable,
 * and never reports completion when its transaction fails.
 *
 * Regression caught:
 * A replace-style update, missing actor/org predicate, scope bypass, or split completion write could
 * move timestamps, expose another member's state, accept the wrong token, or leave partial progress.
 *
 * Why this test is integrated:
 * Real Hono auth, Drizzle transactions, Postgres constraints, and RLS-scoped service queries must
 * agree; mocks cannot prove timestamp stability or rollback after a database-side failure.
 *
 * Failure proof:
 * Removing COALESCE/set-once guards, actor/org predicates, scope gates, or the shared transaction
 * makes the retry, isolation, token, or injected-trigger rollback scenarios fail.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { COMPANION_SKILL_MANIFEST } from "@companion/companion-skill";
import { schema } from "@companion/db";
import { issueApiToken } from "@companion/core/services";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
  type TestActor,
} from "./testDatabase";

process.env.COMPANION_BILLING_MODE = "off";
process.env.COMPANION_SECRETS_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@companion/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async ({ headers }: { headers: Headers }) => {
        const id = headers.get("x-integration-user");
        if (!id) return null;
        const prefix = id.split("-")[0] ?? "member";
        return {
          user: { id, email: `${id}@example.test`, name: prefix[0]!.toUpperCase() + prefix.slice(1) },
          session: { id: `session-${id}`, userId: id },
        };
      }),
    },
    handler: vi.fn(),
    $Infer: {},
  },
  registerAgentCapabilityExecutor: vi.fn(() => () => undefined),
  authenticateAgentRequest: vi.fn(async () => null),
}));

import { app } from "../../src/index";

function sessionRequest(actor: TestActor, orgId: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-integration-user", actor.id);
  headers.set("x-companion-org", orgId);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return app.request(path, { ...init, headers });
}

function tokenRequest(token: string, orgId: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("x-companion-org", orgId);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return app.request(path, { ...init, headers });
}

async function clearState(orgId: string, userId: string) {
  await integrationDb
    .delete(schema.gettingStartedStates)
    .where(and(
      eq(schema.gettingStartedStates.orgId, orgId),
      eq(schema.gettingStartedStates.userId, userId),
    ));
}

describe("getting-started lifecycle", () => {
  let fixture: IntegrationFixture;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
  });

  afterAll(async () => fixture.cleanup());

  it("keeps repeated steps monotonic and completes only after all three", async () => {
    await clearState(fixture.orgA, fixture.owner.id);
    const initial = await sessionRequest(fixture.owner, fixture.orgA, "/v1/getting-started");
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      companion_installed_at: null,
      local_reviewed_at: null,
      org_reviewed_at: null,
      completed_at: null,
      dismissed_at: null,
      completed: false,
      first_incomplete_step: "companion_install",
    });

    const install = await sessionRequest(fixture.owner, fixture.orgA, "/v1/getting-started/steps", {
      method: "POST",
      body: JSON.stringify({ step: "companion_install", agent: "Codex" }),
    });
    expect(install.status).toBe(200);
    const installed = await install.json() as Record<string, unknown>;
    expect(installed).toMatchObject({ first_incomplete_step: "local_review", completed: false });

    const installRetry = await sessionRequest(fixture.owner, fixture.orgA, "/v1/getting-started/steps", {
      method: "POST",
      body: JSON.stringify({ step: "companion_install", agent: "Codex" }),
    });
    expect(installRetry.status).toBe(200);
    await expect(installRetry.json()).resolves.toMatchObject({
      companion_installed_at: installed.companion_installed_at,
      first_incomplete_step: "local_review",
    });

    for (const step of ["local_review", "org_review"] as const) {
      const response = await sessionRequest(fixture.owner, fixture.orgA, "/v1/getting-started/steps", {
        method: "POST",
        body: JSON.stringify({ step, agent: "Codex" }),
      });
      expect(response.status).toBe(200);
    }
    const completed = await sessionRequest(fixture.owner, fixture.orgA, "/v1/getting-started");
    await expect(completed.json()).resolves.toMatchObject({
      completed: true,
      first_incomplete_step: null,
    });
  });

  it("auto-completes Companion installation and keeps its callback idempotent", async () => {
    await clearState(fixture.orgA, fixture.admin.id);
    const body = JSON.stringify({
      version: COMPANION_SKILL_MANIFEST.version,
      agent: "Claude Code",
    });
    const first = await sessionRequest(fixture.admin, fixture.orgA, "/v1/local-skills/companion/installed", {
      method: "POST",
      body,
    });
    expect(first.status, await first.clone().text()).toBe(200);
    const afterFirst = await sessionRequest(fixture.admin, fixture.orgA, "/v1/getting-started");
    const firstState = await afterFirst.json() as Record<string, unknown>;
    expect(firstState).toMatchObject({ first_incomplete_step: "local_review" });

    const retry = await sessionRequest(fixture.admin, fixture.orgA, "/v1/local-skills/companion/installed", {
      method: "POST",
      body,
    });
    expect(retry.status).toBe(200);
    const afterRetry = await sessionRequest(fixture.admin, fixture.orgA, "/v1/getting-started");
    await expect(afterRetry.json()).resolves.toMatchObject({
      companion_installed_at: firstState.companion_installed_at,
      first_incomplete_step: "local_review",
    });
  });

  it("isolates state per user and per organization while preserving it across sessions", async () => {
    await clearState(fixture.orgA, fixture.developer.id);
    await clearState(fixture.orgA, fixture.owner.id);
    const step = await sessionRequest(fixture.developer, fixture.orgA, "/v1/getting-started/steps", {
      method: "POST",
      body: JSON.stringify({ step: "local_review" }),
    });
    expect(step.status).toBe(200);

    const secondSession = await sessionRequest(fixture.developer, fixture.orgA, "/v1/getting-started");
    const secondSessionState = await secondSession.json() as Record<string, unknown>;
    expect(secondSessionState).toMatchObject({
      local_reviewed_at: expect.any(String),
      first_incomplete_step: "companion_install",
    });

    const otherUser = await sessionRequest(fixture.owner, fixture.orgA, "/v1/getting-started");
    const otherUserState = await otherUser.json() as Record<string, unknown>;
    expect(otherUserState.local_reviewed_at).toBeNull();

    const crossTenant = await sessionRequest(fixture.developer, fixture.orgB, "/v1/getting-started");
    expect(crossTenant.status).toBeGreaterThanOrEqual(400);
    const outsider = await sessionRequest(fixture.outsider, fixture.orgB, "/v1/getting-started");
    expect(outsider.status).toBe(200);
    await expect(outsider.json()).resolves.toMatchObject({ local_reviewed_at: null });
  });

  it("enforces read/write PAT scopes and keeps dismissal session-only", async () => {
    await clearState(fixture.orgA, fixture.developer.id);
    const read = await issueApiToken({
      actor: fixture.developer,
      orgId: fixture.orgA,
      scopes: ["skills:read"],
      database: integrationDb,
    });
    const write = await issueApiToken({
      actor: fixture.developer,
      orgId: fixture.orgA,
      scopes: ["skills:write"],
      database: integrationDb,
    });

    expect((await tokenRequest(read.token, fixture.orgA, "/v1/getting-started")).status).toBe(200);
    expect((await tokenRequest(read.token, fixture.orgA, "/v1/getting-started/steps", {
      method: "POST",
      body: JSON.stringify({ step: "local_review" }),
    })).status).toBeGreaterThanOrEqual(400);
    expect((await tokenRequest(write.token, fixture.orgA, "/v1/getting-started")).status).toBeGreaterThanOrEqual(400);
    expect((await tokenRequest(write.token, fixture.orgA, "/v1/getting-started/steps", {
      method: "POST",
      body: JSON.stringify({ step: "local_review" }),
    })).status).toBe(200);
    expect((await tokenRequest(write.token, fixture.orgA, "/v1/getting-started/dismiss", {
      method: "POST",
    })).status).toBe(401);
    expect((await tokenRequest(write.token, fixture.orgA, "/v1/getting-started/reopen", {
      method: "POST",
    })).status).toBe(401);
  });

  it("round-trips dismissal and reopening without changing progress", async () => {
    await clearState(fixture.orgA, fixture.developer.id);
    const reviewed = await sessionRequest(fixture.developer, fixture.orgA, "/v1/getting-started/steps", {
      method: "POST",
      body: JSON.stringify({ step: "local_review" }),
    });
    const reviewedState = await reviewed.json() as Record<string, unknown>;

    const dismissed = await sessionRequest(fixture.developer, fixture.orgA, "/v1/getting-started/dismiss", {
      method: "POST",
    });
    expect(dismissed.status).toBe(200);
    await expect(dismissed.json()).resolves.toMatchObject({
      local_reviewed_at: reviewedState.local_reviewed_at,
      dismissed_at: expect.any(String),
    });

    const reopened = await sessionRequest(fixture.developer, fixture.orgA, "/v1/getting-started/reopen", {
      method: "POST",
    });
    expect(reopened.status).toBe(200);
    await expect(reopened.json()).resolves.toMatchObject({
      local_reviewed_at: reviewedState.local_reviewed_at,
      dismissed_at: null,
    });
  });

  it("rolls back the final step when completion auditing fails", async () => {
    await clearState(fixture.orgA, fixture.owner.id);
    for (const step of ["companion_install", "local_review"] as const) {
      const response = await sessionRequest(fixture.owner, fixture.orgA, "/v1/getting-started/steps", {
        method: "POST",
        body: JSON.stringify({ step }),
      });
      expect(response.status).toBe(200);
    }

    const actorLiteral = fixture.owner.id.replaceAll("'", "''");
    await integrationSql.unsafe(`
      CREATE OR REPLACE FUNCTION companion_test_reject_getting_started_complete()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.action = 'getting_started.complete' AND NEW.target_id = '${actorLiteral}' THEN
          RAISE EXCEPTION 'injected getting-started completion audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER companion_test_reject_getting_started_complete
      BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION companion_test_reject_getting_started_complete();
    `);
    try {
      const failed = await sessionRequest(fixture.owner, fixture.orgA, "/v1/getting-started/steps", {
        method: "POST",
        body: JSON.stringify({ step: "org_review" }),
      });
      expect(failed.status).toBeGreaterThanOrEqual(400);
      const state = await sessionRequest(fixture.owner, fixture.orgA, "/v1/getting-started");
      await expect(state.json()).resolves.toMatchObject({
        org_reviewed_at: null,
        completed_at: null,
        completed: false,
      });
    } finally {
      await integrationSql.unsafe(`
        DROP TRIGGER IF EXISTS companion_test_reject_getting_started_complete ON audit_log;
        DROP FUNCTION IF EXISTS companion_test_reject_getting_started_complete();
      `);
    }
  });

  it("accepts zero-action and decline-all review outcomes through the same completion signal", async () => {
    await clearState(fixture.orgB, fixture.outsider.id);
    for (const step of ["companion_install", "local_review", "org_review"] as const) {
      const response = await sessionRequest(fixture.outsider, fixture.orgB, "/v1/getting-started/steps", {
        method: "POST",
        body: JSON.stringify({ step, agent: "OpenCode" }),
      });
      expect(response.status).toBe(200);
    }
    const state = await sessionRequest(fixture.outsider, fixture.orgB, "/v1/getting-started");
    await expect(state.json()).resolves.toMatchObject({ completed: true });
  });
});
