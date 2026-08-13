import { describe, expect, it } from "vitest";
import {
  companionDesktopSchema,
  companionThreadSchema,
  companionSharesSchema,
  createCompanionInputSchema,
  saveCompanionProviderInputSchema,
  saveCompanionPluginInputSchema,
  sendCompanionMessageInputSchema,
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
  it("validates the compact write-only Plugins form for both adapter transports", () => {
    expect(saveCompanionPluginInputSchema.parse({
      provider: "github",
      label: "work",
      transport: "http",
      url: "https://mcp.example.test/github",
      credential_name: "Authorization",
      credential_value: "Bearer secret",
    })).toMatchObject({ provider: "github", label: "work", args: [] });
    expect(saveCompanionPluginInputSchema.parse({
      provider: "github",
      label: "personal",
      transport: "stdio",
      command: "github-mcp-server",
      args: ["stdio"],
      credential_name: "GITHUB_TOKEN",
      credential_value: "secret",
    })).toMatchObject({ transport: "stdio" });
    expect(() => saveCompanionPluginInputSchema.parse({
      provider: "github",
      label: "work",
      transport: "http",
      credential_name: "Authorization",
    })).toThrow();
    expect(() => saveCompanionPluginInputSchema.parse({
      provider: "github",
      label: "work",
      transport: "stdio",
      command: "github-mcp-server",
      credential_name: "NOT-AN-ENV",
      credential_value: "secret",
    })).toThrow();
  });

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

describe("Companion chat contracts", () => {
  it("trims one message and rejects empty or oversized content", () => {
    expect(sendCompanionMessageInputSchema.parse({ content: "  Ship it  " })).toEqual({
      content: "Ship it",
    });
    expect(() => sendCompanionMessageInputSchema.parse({ content: "   " })).toThrow();
    expect(() => sendCompanionMessageInputSchema.parse({ content: "x".repeat(16_385) })).toThrow();
    // A thread carries no harness controls, so no client can smuggle tools into a message.
    expect(() => sendCompanionMessageInputSchema.parse({
      content: "Ship it",
      tools: ["bash"],
    })).toThrow();
  });

  it("describes one thread per Companion with its run boundary and message authors", () => {
    const thread = companionThreadSchema.parse({
      companion_id: "11111111-1111-4111-8111-111111111111",
      viewer_id: "user-2",
      access: "viewer",
      read_only: true,
      can_send: false,
      entries: [{
        event_id: "msg:1",
        ordinal: 0,
        role: "user",
        content: "Hello",
        author_id: "user-1",
        author_name: "Owner",
        created_at: "2026-08-12T12:00:00.000Z",
      }, {
        event_id: "pi:0",
        ordinal: 1,
        role: "assistant",
        content: "Hi",
        author_id: null,
        author_name: null,
        created_at: "2026-08-12T12:00:01.000Z",
      }],
      pending_count: 0,
      last_message_at: "2026-08-12T12:00:00.000Z",
    });

    expect(thread.read_only).toBe(true);
    expect(thread.can_send).toBe(false);
    // The reader is not the author, so the surface can attribute the message to the Owner.
    expect(thread.entries[0]?.author_id).not.toBe(thread.viewer_id);
    expect(thread.entries[1]?.author_id).toBeNull();
  });
});

describe("Companion desktop contract", () => {
  it("names Lux as the only computer-use surface and allows a provisioning desktop", () => {
    expect(companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "lux",
    })).toMatchObject({ automation: "lux" });
    expect(companionDesktopSchema.parse({
      desktop_url: null,
      provisioning: true,
      automation: "lux",
    }).desktop_url).toBeNull();
    // A second computer-use surface cannot be introduced through this payload.
    expect(() => companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "vnc",
    })).toThrow();
    // Nothing else travels with a secret-bearing URL.
    expect(() => companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "lux",
      box_token: "must-not-enter-the-contract",
    })).toThrow();
  });
});

describe("Companion sharing contracts", () => {
  it("accepts only Editor or Viewer for the workspace-wide grant", () => {
    expect(setCompanionWorkspaceShareInputSchema.parse({ role: "viewer" })).toEqual({
      role: "viewer",
    });
    expect(setCompanionWorkspaceShareInputSchema.parse({ role: null })).toEqual({ role: null });
    expect(() => setCompanionWorkspaceShareInputSchema.parse({ role: "owner" })).toThrow();
  });

  it("carries the workspace role only — sharing is workspace-only after THE-329", () => {
    const shares = companionSharesSchema.parse({
      companion_id: "11111111-1111-1111-1111-111111111111",
      workspace_role: "editor",
    });
    expect(shares).toEqual({
      companion_id: "11111111-1111-1111-1111-111111111111",
      workspace_role: "editor",
    });
    // No per-member list survives on the contract.
    expect("members" in shares).toBe(false);
    expect(() => companionSharesSchema.parse({
      companion_id: "11111111-1111-1111-1111-111111111111",
      workspace_role: null,
      members: [],
    })).not.toThrow();
  });
});
