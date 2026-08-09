import { describe, expect, it } from "vitest";
import { selectWorkspaceAuthentication } from "./auth-mode.js";

const workspace = {
  apiUrl: "https://companion.example/v1",
  agentAuth: { issuer: "https://companion.example", agentId: "agent-1" },
  legacyPat: { token: "cmp_pat_preserved" },
};

describe("Companion authentication mode", () => {
  it("uses Agent Auth by default even when a legacy PAT is preserved", () => {
    expect(selectWorkspaceAuthentication(workspace, undefined)).toEqual({
      kind: "agent",
      reference: workspace.agentAuth,
    });
  });

  it("uses a PAT only when legacy-pat is explicitly selected", () => {
    expect(selectWorkspaceAuthentication(workspace, "legacy-pat")).toEqual({
      kind: "legacy-pat",
      token: "cmp_pat_preserved",
    });
  });

  it("gives an environment delegation token first-class precedence with optional target binding", () => {
    expect(selectWorkspaceAuthentication(
      workspace,
      undefined,
      "cmp_pat_synthetic_delegation",
      "conductor-workspace-1",
    )).toEqual({
      kind: "delegation-token",
      token: "cmp_pat_synthetic_delegation",
      targetWorkspaceId: "conductor-workspace-1",
    });
  });

  it("never treats an Agent Auth failure as permission to fall back", () => {
    expect(() => selectWorkspaceAuthentication({ apiUrl: workspace.apiUrl, legacyPat: workspace.legacyPat }, undefined))
      .toThrow(/not connected with Agent Auth/);
    expect(() => selectWorkspaceAuthentication({ apiUrl: workspace.apiUrl }, "legacy-pat"))
      .toThrow(/no preserved PAT/);
  });
});
