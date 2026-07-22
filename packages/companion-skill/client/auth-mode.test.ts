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

  it("never treats an Agent Auth failure as permission to fall back", () => {
    expect(() => selectWorkspaceAuthentication({ apiUrl: workspace.apiUrl, legacyPat: workspace.legacyPat }, undefined))
      .toThrow(/not connected with Agent Auth/);
    expect(() => selectWorkspaceAuthentication({ apiUrl: workspace.apiUrl }, "legacy-pat"))
      .toThrow(/no preserved PAT/);
  });
});
