import { describe, expect, it } from "vitest";
import {
  createCompanionInputSchema,
  inviteCompanionMemberInputSchema,
  saveCompanionProviderInputSchema,
  setCompanionWorkspaceShareInputSchema,
  startCompanionRuntimeInputSchema,
} from "../src/companions";

describe("Companion provider contracts", () => {
  it("requires a single-line API key and accepts Pi OAuth subscription entries", () => {
    expect(saveCompanionProviderInputSchema.parse({
      auth_method: "api_key",
      credential: "sk-test",
    })).toEqual({ auth_method: "api_key", credential: "sk-test" });
    expect(saveCompanionProviderInputSchema.parse({
      auth_method: "subscription",
      credential: { type: "oauth", access: "token", refresh: "refresh", expires: 123 },
    })).toMatchObject({ auth_method: "subscription" });
    expect(() => saveCompanionProviderInputSchema.parse({
      auth_method: "api_key",
      credential: "line-one\nline-two",
    })).toThrow();
    expect(() => saveCompanionProviderInputSchema.parse({
      auth_method: "subscription",
      credential: { type: "api_key", key: "wrong shape" },
    })).toThrow();
  });

  it("selects a provider at creation and rejects model credentials on start", () => {
    expect(createCompanionInputSchema.parse({
      name: "Research",
      provider_id: "anthropic",
    })).toMatchObject({ provider_id: "anthropic" });
    expect(createCompanionInputSchema.parse({
      name: "Luna",
      persona: "  Content marketing assistant  ",
      provider_id: "anthropic",
    })).toMatchObject({ persona: "Content marketing assistant" });
    expect(() => createCompanionInputSchema.parse({
      name: "Luna",
      persona: "x".repeat(281),
    })).toThrow();
    expect(() => createCompanionInputSchema.parse({
      name: "Luna",
      system_prompt: "not part of creation",
    })).toThrow();
    expect(() => startCompanionRuntimeInputSchema.parse({
      credentials: [{ provider: "anthropic", env_key: "ANTHROPIC_API_KEY", value: "must-not-enter-start" }],
    })).toThrow();
  });
});

describe("Companion runtime injection contract", () => {
  it("accepts labeled multi-account MCP configuration with transient credential references", () => {
    const parsed = startCompanionRuntimeInputSchema.parse({
      client_surface: "mobile_web",
      mcp_credentials: [
        { env_key: "GITHUB_PERSONAL", value: "personal-secret" },
        { env_key: "GITHUB_WORK", value: "work-secret" },
      ],
      mcp_accounts: [
        {
          id: "github-personal",
          label: "GitHub personal",
          transport: "http",
          url: "https://mcp.example.test/github",
          headers: { Authorization: "GITHUB_PERSONAL" },
        },
        {
          id: "github-work",
          label: "GitHub work",
          transport: "stdio",
          command: "github-mcp-server",
          env: { GITHUB_TOKEN: "GITHUB_WORK" },
        },
      ],
    });

    expect(parsed.client_surface).toBe("mobile_web");
    expect(parsed.mcp_accounts).toHaveLength(2);
  });

  it("rejects duplicate labels and missing MCP credential references", () => {
    const result = startCompanionRuntimeInputSchema.safeParse({
      mcp_credentials: [],
      mcp_accounts: [
        {
          id: "one",
          label: "Work",
          transport: "http",
          url: "https://mcp.example.test/one",
          headers: { Authorization: "MISSING_TOKEN" },
        },
        {
          id: "two",
          label: "work",
          transport: "http",
          url: "https://mcp.example.test/two",
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        "MCP account labels must be unique",
        "MCP environment reference MISSING_TOKEN has no matching mcp_credentials entry",
      ]));
    }
  });
});

describe("Companion sharing contracts", () => {
  it("accepts only Editor or Viewer for workspace and member grants", () => {
    expect(setCompanionWorkspaceShareInputSchema.parse({ role: "viewer" })).toEqual({
      role: "viewer",
    });
    expect(setCompanionWorkspaceShareInputSchema.parse({ role: null })).toEqual({ role: null });
    expect(inviteCompanionMemberInputSchema.parse({
      email: "editor@example.test",
      role: "editor",
    })).toEqual({ email: "editor@example.test", role: "editor" });
    expect(() => inviteCompanionMemberInputSchema.parse({
      email: "owner@example.test",
      role: "owner",
    })).toThrow();
  });
});
