import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  agentAuthTimestamp,
  isUnambiguousDeviceApproval,
  projectConnectedAgents,
  registerAgentAuthRoutes,
  resolveDeviceApprovalWorkspace,
} from "./agentAuthRoutes";
import type { ApiVariables } from "./context";

describe("Agent Auth timestamp serialization", () => {
  it("normalizes Date instances and PostgreSQL timestamp strings", () => {
    const timestamp = "2026-07-21T12:00:00.000Z";
    expect(agentAuthTimestamp(new Date(timestamp))).toBe(timestamp);
    expect(agentAuthTimestamp("2026-07-21 12:00:00+00")).toBe(timestamp);
  });

  it("rejects invalid persisted timestamps", () => {
    expect(() => agentAuthTimestamp("not-a-timestamp")).toThrow("invalid timestamp");
  });
});

/**
 * Product promise: Connected Agents reports real permission activity, never inferred activity.
 * Regression caught: copying agent.last_used_at onto every grant made unrelated permissions look used.
 * Why unit-level: this is a deterministic response-projection rule with no database behavior involved.
 * Failure proof: replacing the grant null below with row.agent_last_used_at makes both assertions fail.
 */
describe("Connected Agent usage projection", () => {
  it("keeps agent activity without attributing it to each capability grant", () => {
    const lastUsedAt = "2026-07-21T12:00:00.000Z";
    const common = {
      agent_id: "agent-1",
      agent_name: "Codex on Mac",
      agent_status: "active",
      agent_created_at: "2026-07-20T12:00:00.000Z",
      agent_last_used_at: lastUsedAt,
      host_id: "host-1",
      host_name: "stan-mac",
      host_status: "active",
    };

    const [agent] = projectConnectedAgents([
      {
        ...common,
        grant_id: "grant-read",
        capability: "skills:read",
        constraints: { workspaceId: { eq: "org-1" } },
        grant_status: "active",
        grant_created_at: "2026-07-20T12:05:00.000Z",
      },
      {
        ...common,
        grant_id: "grant-write",
        capability: "secrets:write",
        constraints: { workspaceId: { eq: "org-1" } },
        grant_status: "active",
        grant_created_at: "2026-07-20T12:06:00.000Z",
      },
    ]);

    expect(agent?.last_used_at).toBe(lastUsedAt);
    expect(agent?.grants.map((grant) => grant.last_used_at)).toEqual([null, null]);
  });
});

/**
 * Product promise: Any active 30-day browser session can review an Agent Auth device request.
 * Regression caught: A duplicate five-minute freshness gate forced an already signed-in user to reauthenticate.
 * Why HTTP-level: The promise belongs to the product wrapper route, not a timestamp helper.
 * Failure proof: Restoring the createdAt freshness check changes this response from validation error to 403.
 */
describe("device approval browser-session gate", () => {
  it("accepts an active browser session created 30 days ago", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    app.use("*", async (c, next) => {
      c.set("user", {
        id: "user-1",
        email: "person@example.com",
        name: "Person",
      } as ApiVariables["user"]);
      c.set("session", {
        id: "session-1",
        userId: "user-1",
        token: "test-session-token",
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60_000),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      } as ApiVariables["session"]);
      await next();
    });
    registerAgentAuthRoutes(app);

    const response = await app.request(
      "/v1/agent-auth/device-approval?agent_id=not-a-uuid&code=ABCD-1234",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.not.toMatchObject({ error: "fresh_session_required" });
  });

  it("returns an authentication status when the browser session is absent", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    app.use("*", async (c, next) => {
      c.set("user", null);
      c.set("session", null);
      await next();
    });
    registerAgentAuthRoutes(app);

    const response = await app.request(
      "/v1/agent-auth/device-approval?agent_id=not-a-uuid&code=ABCD-1234",
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "not authenticated" });
  });
});

describe("device approval grant binding", () => {
  it("requires an exact one-to-one capability-name mapping", () => {
    expect(isUnambiguousDeviceApproval("skills:read secrets:read", ["skills:read", "secrets:read"])).toBe(true);
    expect(isUnambiguousDeviceApproval("skills:read", ["skills:read", "skills:read"])).toBe(false);
    expect(isUnambiguousDeviceApproval("skills:read skills:read", ["skills:read"])).toBe(false);
    expect(isUnambiguousDeviceApproval("skills:read", ["skills:write"])).toBe(false);
    expect(isUnambiguousDeviceApproval(null, [])).toBe(false);
  });

  it("accepts one exact workspace across tenant capabilities", () => {
    const workspaceId = "169b768e-b1d0-4dde-a62e-575022debe88";
    expect(resolveDeviceApprovalWorkspace([
      { capability: "skills:read", constraints: { workspaceId: { eq: workspaceId } } },
      { capability: "secrets:read", constraints: JSON.stringify({ workspaceId }) },
      { capability: "public-skills:install", constraints: null },
    ])).toEqual({ workspaceId, error: null });
  });

  it("rejects malformed and mixed-workspace tenant grants", () => {
    const workspaceA = "169b768e-b1d0-4dde-a62e-575022debe88";
    const workspaceB = "eb0961c4-6674-4620-82f5-f844fcc6ce25";
    expect(resolveDeviceApprovalWorkspace([
      { capability: "skills:read", constraints: { workspaceId: { eq: workspaceA } } },
      { capability: "skills:write", constraints: { workspaceId: { eq: workspaceB } } },
    ])).toEqual({ workspaceId: null, error: "mixed_workspace_approval" });
    expect(resolveDeviceApprovalWorkspace([
      { capability: "secrets:write", constraints: { workspaceId: { in: [workspaceA] } } },
    ])).toEqual({ workspaceId: null, error: "invalid_workspace_constraint" });
    expect(resolveDeviceApprovalWorkspace([
      { capability: "skills:read", constraints: { workspaceId: { eq: workspaceA, in: [workspaceA] } } },
    ])).toEqual({ workspaceId: null, error: "invalid_workspace_constraint" });
    expect(resolveDeviceApprovalWorkspace([
      { capability: "secrets:read", constraints: null },
    ])).toEqual({ workspaceId: null, error: "invalid_workspace_constraint" });
  });
});
