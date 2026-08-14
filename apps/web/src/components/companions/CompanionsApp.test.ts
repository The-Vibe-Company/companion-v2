import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Companion, CompanionProvidersResponse } from "@companion/contracts";
import { describe, expect, it, vi } from "vitest";
import { CompanionsApp, type CompanionNavigation } from "./CompanionsApp";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

const org = {
  id: "org-1",
  name: "The Vibe Company",
  slug: "vibe",
  kind: "team" as const,
  myRole: "owner" as const,
  color: null,
  logoUrl: null,
};

const navigation: CompanionNavigation = {
  mineTreeRows: [],
  orgTreeRows: [],
  mineCount: 3,
  orgCount: 5,
  installedCount: 1,
  installedUpdateCount: 0,
  localUpdateCount: 0,
  archivedCount: 15,
};

const providers: CompanionProvidersResponse = {
  catalog: [
    { id: "anthropic", name: "Claude", auth_methods: ["api_key", "subscription"], description: "", models: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8", default: true }] },
  ],
  connections: [{
    provider_id: "anthropic",
    auth_method: "api_key",
    connected_by: "user-1",
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
  }],
  default_provider_id: "anthropic",
  can_manage: true,
};

function companion(overrides: Partial<Companion> = {}): Companion {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Luna",
    persona: "Content marketing assistant",
    model_id: "claude-opus-4-8",
    selected_skill_ids: [],
    can_write_skills: false,
    owner_id: "user-1",
    access: "owner",
    runtime: {
      state: "running",
      daemon_state: "running",
      box_id: "bx_23456789",
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 2,
      desktop_available: false,
      last_error: null,
      last_observed_at: null,
      last_started_at: null,
      last_stopped_at: null,
    },
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

function render(
  companions: Companion[],
  initialCompanionId?: string | null,
  initialPluginsOpen = false,
  initialSettingsCompanionId?: string | null,
) {
  return renderToStaticMarkup(React.createElement(CompanionsApp, {
    orgs: [org],
    currentOrg: org,
    navigation,
    initialCompanions: companions,
    initialProviders: providers,
    initialPlugins: [{
      id: "44444444-4444-4444-8444-444444444444",
      provider: "linear",
      label: "work",
      transport: "http",
      endpoint: "https://mcp.linear.example",
      connected: true,
      created_at: "2026-08-12T12:00:00.000Z",
      updated_at: "2026-08-12T12:00:00.000Z",
    }],
    initialCompanionId,
    initialPluginsOpen,
    initialSettingsCompanionId,
  }));
}

describe("CompanionsApp", () => {
  it("lists workspace Companions with persona, status, and access", () => {
    const markup = render([
      companion(),
      companion({
        id: "22222222-2222-4222-8222-222222222222",
        name: "Milo",
        persona: "Developer assistant",
        access: "viewer",
        runtime: { ...companion().runtime, state: "stopped", box_id: null },
      }),
    ]);

    expect(markup).toContain("Content marketing assistant");
    expect(markup).toContain("Developer assistant");
    expect(markup).toContain("Online");
    expect(markup).toContain("Asleep");
    expect(markup).toContain("New companion");
    expect(markup).toContain("Search companions");
    // The Companion Owner keeps sharing; a Viewer row must not offer it.
    expect(markup.match(/>Share</g)).toHaveLength(1);
    // Both rows expose settings; the Viewer receives its provider and model as disabled controls.
    expect(markup.match(/aria-label="Settings for/g)).toHaveLength(2);
  });

  it("carries the recorded reason next to an Error status in the list", () => {
    const markup = render([
      companion({
        runtime: {
          ...companion().runtime,
          state: "error",
          daemon_state: "error",
          last_error: "Box runtime is not configured; set COMPANION_BOX_API_KEY",
        },
      }),
    ]);

    expect(markup).toContain("Error");
    expect(markup).toContain('title="Box runtime is not configured; set COMPANION_BOX_API_KEY"');
  });

  it("offers creation from the empty state instead of a dead list", () => {
    const markup = render([]);

    expect(markup).toContain("No Companions yet");
    expect(markup).toContain("New companion");
    expect(markup).not.toContain("Search companions");
  });

  it("keeps the sidebar in Companions mode with the Skills switch available", () => {
    const markup = render([companion()]);

    expect(markup).toContain("Workspace mode");
    expect(markup).toContain("cmprow");
    expect(markup).not.toContain("My Skills");
  });

  it("opens the chat thread for a deep-linked Companion instead of the list", () => {
    const markup = render([companion()], "11111111-1111-4111-8111-111111111111");

    expect(markup).toContain("Chat with Luna");
    expect(markup).toContain("Back to Companions");
    expect(markup).not.toContain("Search companions");
  });

  it("falls back to the list when the deep-linked Companion is not visible", () => {
    const markup = render([companion()], "33333333-3333-4333-8333-333333333333");

    expect(markup).toContain("Search companions");
    expect(markup).not.toContain("Chat with Luna");
  });

  it("renders Plugins as a separate web surface and keeps it out of chat", () => {
    const plugins = render([companion()], null, true);
    expect(plugins).toContain("Browse the MCP registry and connect servers with labels.");
    expect(plugins).toContain("Linear");
    expect(plugins).toContain("work");
    expect(plugins).not.toContain("Chat with Luna");

    const chat = render([companion()], companion().id);
    expect(chat).toContain("Chat with Luna");
    expect(chat).not.toContain(">Plugins<");
    expect(chat).not.toContain("Add MCP");
  });

  it("renders settings as a separate surface for a runner and keeps them out of the list", () => {
    const settings = render([companion()], null, false, companion().id);

    expect(settings).toContain("Companion settings");
    expect(settings).toContain("Instructions");
    expect(settings).toContain("1. Provider");
    expect(settings).toContain("2. Model");
    expect(settings).toContain("Delete Companion");
    expect(settings).not.toContain("Search companions");
    expect(settings).not.toContain("Chat with Luna");
  });
});
