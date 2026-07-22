import { describe, expect, it } from "vitest";
import {
  agentAuthTimestamp,
  isFreshDeviceApprovalSession,
  isUnambiguousDeviceApproval,
  projectConnectedAgents,
  resolveDeviceApprovalWorkspace,
} from "./agentAuthRoutes";

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

describe("device approval fresh-session gate", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");

  it("accepts sessions no older than five minutes", () => {
    expect(isFreshDeviceApprovalSession(new Date(now - 5 * 60_000), now)).toBe(true);
    expect(isFreshDeviceApprovalSession(new Date(now - 5 * 60_000 - 1), now)).toBe(false);
  });

  it("rejects missing, invalid, and future session timestamps", () => {
    expect(isFreshDeviceApprovalSession(null, now)).toBe(false);
    expect(isFreshDeviceApprovalSession("invalid", now)).toBe(false);
    expect(isFreshDeviceApprovalSession(new Date(now + 1), now)).toBe(false);
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
