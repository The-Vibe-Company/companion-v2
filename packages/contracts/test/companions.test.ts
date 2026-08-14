import { describe, expect, it } from "vitest";
import {
  COMPANION_PROVIDER_CATALOG,
  COMPANION_TOOL_RUN_SCREENSHOT_MAX_CHARACTERS,
  companionProviderOAuthCompleteInputSchema,
  companionProviderOAuthStartInputSchema,
  companionDesktopSchema,
  companionMessageEventId,
  companionThreadSchema,
  companionToolRunSchema,
  companionTranscriptEntrySchema,
  companionSharesSchema,
  createCompanionInputSchema,
  saveCompanionProviderInputSchema,
  saveCompanionPluginInputSchema,
  sendCompanionMessageInputSchema,
  setCompanionWorkspaceShareInputSchema,
  startCompanionRuntimeInputSchema,
  updateCompanionInputSchema,
} from "../src/companions";

describe("Companion provider contracts", () => {
  it("keeps API keys write-only and removes browser-submitted subscription credentials", () => {
    expect(saveCompanionProviderInputSchema.parse({
      auth_method: "api_key",
      credential: "sk-test",
    })).toEqual({ auth_method: "api_key", credential: "sk-test" });
    expect(() => saveCompanionProviderInputSchema.parse({
      auth_method: "subscription",
      credential: { type: "oauth", access: "token", refresh: "refresh", expires: 123 },
    })).toThrow();
    expect(() => saveCompanionProviderInputSchema.parse({
      auth_method: "api_key",
      credential: "line-one\nline-two",
    })).toThrow();
  });

  it("pins Pi's Kimi, Moonshot, OpenAI, and Google API-key providers", () => {
    expect(COMPANION_PROVIDER_CATALOG).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "kimi-coding", auth_methods: ["api_key"] }),
      expect.objectContaining({ id: "moonshotai", auth_methods: ["api_key"] }),
      expect.objectContaining({ id: "openai", auth_methods: ["api_key"] }),
      expect.objectContaining({ id: "google", auth_methods: ["api_key"] }),
    ]));
  });

  it("pins at least one Pi model and exactly one default for every provider", () => {
    for (const provider of COMPANION_PROVIDER_CATALOG) {
      expect(provider.models.length).toBeGreaterThanOrEqual(1);
      expect(provider.models.filter((model) => model.default)).toHaveLength(1);
    }
  });

  it("starts only native Claude/Codex subscription login and accepts one-time codes only", () => {
    expect(companionProviderOAuthStartInputSchema.parse({
      provider_id: "anthropic",
    })).toEqual({ provider_id: "anthropic" });
    expect(companionProviderOAuthStartInputSchema.parse({
      provider_id: "openai-codex",
    })).toEqual({ provider_id: "openai-codex" });
    expect(() => companionProviderOAuthStartInputSchema.parse({
      provider_id: "zai",
    })).toThrow();
    expect(companionProviderOAuthCompleteInputSchema.parse({
      authorization_code: "one-time-code",
    })).toEqual({ authorization_code: "one-time-code" });
    expect(() => companionProviderOAuthCompleteInputSchema.parse({
      authorization_code: "{\"type\":\n\"oauth\"}",
    })).toThrow();
  });

  it("selects a provider at creation and rejects model credentials on start", () => {
    expect(createCompanionInputSchema.parse({
      name: "Research",
      provider_id: "anthropic",
      model_id: "claude-opus-4-8",
    })).toMatchObject({ provider_id: "anthropic", model_id: "claude-opus-4-8" });
    expect(createCompanionInputSchema.parse({
      name: "Research",
      provider_id: "anthropic",
      model_id: "claude-sonnet-5",
      selected_skill_ids: ["11111111-1111-4111-8111-111111111111"],
      can_write_skills: true,
    })).toMatchObject({
      selected_skill_ids: ["11111111-1111-4111-8111-111111111111"],
      can_write_skills: true,
    });
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

  it("persists skill selection and write-on-behalf on update", () => {
    expect(updateCompanionInputSchema.parse({
      selected_skill_ids: [],
      can_write_skills: false,
    })).toEqual({ selected_skill_ids: [], can_write_skills: false });
    expect(updateCompanionInputSchema.parse({
      selected_mcp_account_ids: ["22222222-2222-4222-8222-222222222222"],
    })).toEqual({
      selected_mcp_account_ids: ["22222222-2222-4222-8222-222222222222"],
    });
    expect(updateCompanionInputSchema.parse({
      selected_mcp_account_ids: [],
    })).toEqual({ selected_mcp_account_ids: [] });
    expect(() => updateCompanionInputSchema.parse({})).toThrow();
  });

  it("accepts MCP plugin selection on create", () => {
    expect(createCompanionInputSchema.parse({
      name: "Research",
      provider_id: "anthropic",
      model_id: "claude-opus-4-8",
      selected_mcp_account_ids: [
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ],
    })).toMatchObject({
      selected_mcp_account_ids: [
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ],
    });
  });

  it("accepts only the editable Companion settings and supports clearing instructions", () => {
    expect(updateCompanionInputSchema.parse({
      name: "Luna research",
      persona: null,
      provider_id: "openai-codex",
      model_id: "gpt-5.5",
    })).toEqual({
      name: "Luna research",
      persona: null,
      provider_id: "openai-codex",
      model_id: "gpt-5.5",
    });
    expect(updateCompanionInputSchema.parse({
      provider_id: "openai-codex",
      model_id: "gpt-5.6-sol",
    })).toMatchObject({ model_id: "gpt-5.6-sol" });
    expect(() => updateCompanionInputSchema.parse({})).toThrow();
    expect(() => updateCompanionInputSchema.parse({ owner_id: "user-2" })).toThrow();
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
      client_surface: "web",
    });
    expect(() => sendCompanionMessageInputSchema.parse({ content: "   " })).toThrow();
    expect(() => sendCompanionMessageInputSchema.parse({ content: "x".repeat(16_385) })).toThrow();
    // A thread carries no harness controls, so no client can smuggle tools into a message.
    expect(() => sendCompanionMessageInputSchema.parse({
      content: "Ship it",
      tools: ["bash"],
    })).toThrow();
  });

  it("lets a send name the turn it creates, and only as an id", () => {
    // One send, one id: the control plane stores the turn a resent request names once, so the id has
    // to survive parsing intact and anything that is not one is refused before persistence.
    expect(sendCompanionMessageInputSchema.parse({
      content: "Ship it",
      client_message_id: "33333333-3333-4333-8333-333333333333",
    })).toEqual({
      content: "Ship it",
      client_message_id: "33333333-3333-4333-8333-333333333333",
      client_surface: "web",
    });
    expect(sendCompanionMessageInputSchema.parse({
      content: "Ship it",
      client_surface: "native_mobile",
    }).client_surface).toBe("native_mobile");
    expect(() => sendCompanionMessageInputSchema.parse({
      content: "Ship it",
      client_message_id: "pi:512",
    })).toThrow();
  });

  it("keeps sent messages and projected Pi events in separate id namespaces", () => {
    // The composer shows a message under the id the control plane will store it under, so the two
    // must agree and neither may be able to name an entry the Pi log will claim later.
    expect(companionMessageEventId("33333333-3333-4333-8333-333333333333"))
      .toBe("msg:33333333-3333-4333-8333-333333333333");
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
    // A message is not a tool run, and the thread says so rather than leaving the field absent.
    expect(thread.entries[0]?.tool).toBeNull();
  });

  it("carries a tool run only on a tool entry", () => {
    const run = {
      call_id: "call_1",
      kind: "shell" as const,
      name: "bash",
      title: "ls -la",
      status: "ok" as const,
      detail: '{"command":"ls -la"}',
      screenshot: null,
    };

    expect(companionTranscriptEntrySchema.parse({
      event_id: "pi:512:tool:0",
      ordinal: 2,
      role: "tool",
      content: "ls -la",
      author_id: null,
      author_name: null,
      tool: run,
      created_at: "2026-08-12T12:00:02.000Z",
    }).tool).toMatchObject({ kind: "shell", status: "ok" });

    // A tool entry with nothing to report, and a reply smuggling a chip, are both incoherent.
    expect(() => companionTranscriptEntrySchema.parse({
      event_id: "pi:512:tool:0",
      ordinal: 2,
      role: "tool",
      content: "ls -la",
      author_id: null,
      author_name: null,
      created_at: "2026-08-12T12:00:02.000Z",
    })).toThrow();
    expect(() => companionTranscriptEntrySchema.parse({
      event_id: "pi:512",
      ordinal: 2,
      role: "assistant",
      content: "Listing the repository.",
      author_id: null,
      author_name: null,
      tool: run,
      created_at: "2026-08-12T12:00:02.000Z",
    })).toThrow();
  });

  it("accepts a Box frame only as an inline image and never as a URL a browser would fetch", () => {
    const frame = (screenshot: string) => companionToolRunSchema.parse({
      call_id: null,
      kind: "computer",
      name: "computer",
      title: "screenshot",
      status: "ok",
      detail: null,
      screenshot,
    });

    expect(frame("data:image/jpeg;base64,/9j/4AAQSkZJRg==").screenshot).toContain("data:image/jpeg");

    // The transcript hands this straight to an `img`, so anything that could reach out of the page —
    // or run in it — is refused here rather than trusted because the control plane wrote it.
    expect(() => frame("https://example.test/frame.jpg")).toThrow();
    expect(() => frame("javascript:alert(1)")).toThrow();
    expect(() => frame("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toThrow();
    // One downscaled still, not a recording: an oversized frame is refused, not truncated.
    expect(() => frame(`data:image/jpeg;base64,${"A".repeat(
      COMPANION_TOOL_RUN_SCREENSHOT_MAX_CHARACTERS,
    )}`)).toThrow();
  });
});

describe("Companion desktop contract", () => {
  it("names Lux as the only computer-use surface and allows a provisioning desktop", () => {
    expect(companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "lux",
      transport: "vnc",
    })).toMatchObject({ automation: "lux" });
    expect(companionDesktopSchema.parse({
      desktop_url: null,
      provisioning: true,
      automation: "lux",
      transport: null,
    }).desktop_url).toBeNull();
    // A second computer-use surface cannot be introduced through this payload.
    expect(() => companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "vnc",
      transport: "vnc",
    })).toThrow();
    // Nothing else travels with a secret-bearing URL.
    expect(() => companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "lux",
      transport: "vnc",
      box_token: "must-not-enter-the-contract",
    })).toThrow();
  });

  it("names the stream this mint got, and only a stream Box actually offers", () => {
    // The two Box desktop streams: VNC is asked for first, WebRTC is the fallback.
    expect(companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "lux",
      transport: "webrtc",
    }).transport).toBe("webrtc");
    expect(() => companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "lux",
      transport: "screenshots",
    })).toThrow();
    // A URL always came over one of them, so the surface is never left to infer which.
    expect(() => companionDesktopSchema.parse({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "lux",
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
