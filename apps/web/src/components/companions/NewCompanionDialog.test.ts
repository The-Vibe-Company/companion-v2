import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompanionProvidersResponse } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import { NewCompanionDialog } from "./NewCompanionDialog";

const noop = () => {};

function providers(overrides: Partial<CompanionProvidersResponse> = {}): CompanionProvidersResponse {
  return {
    catalog: [
      { id: "anthropic", name: "Claude", auth_methods: ["api_key", "subscription"], description: "", models: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8", default: true }] },
      { id: "kimi-coding", name: "Kimi", auth_methods: ["api_key"], description: "", models: [{ id: "kimi-for-coding", name: "Kimi K2.7 Code", default: true }] },
      {
        id: "zai",
        name: "z.ai",
        auth_methods: ["api_key"],
        description: "",
        models: [
          { id: "glm-4.7", name: "GLM-4.7", default: true },
          { id: "glm-5.2", name: "GLM-5.2" },
          { id: "glm-5.3", name: "GLM-5.3" },
        ],
      },
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
    ...overrides,
  };
}

function render(response: CompanionProvidersResponse) {
  return renderToStaticMarkup(React.createElement(NewCompanionDialog, {
    orgId: "org-1",
    providers: response,
    onCreated: noop,
    onConnectProvider: noop,
    onClose: noop,
  }));
}

describe("NewCompanionDialog", () => {
  it("shows only the selected connected provider's models", () => {
    const markup = render(providers());

    expect(markup).toContain("Name");
    expect(markup).toContain("Persona");
    expect(markup).toContain("Claude");
    expect(markup).toContain("Claude Opus 4.8");
    expect(markup).toContain("Default");
    // Two text fields plus the selected provider and model radios: no SDK or settings wizard.
    expect(markup.match(/<input/g)).toHaveLength(4);
    expect(markup).not.toContain("z.ai");
    expect(markup).not.toContain("GLM-4.7");
  });

  it("points an admin at provider setup when the workspace has no provider", () => {
    const markup = render(providers({ connections: [], default_provider_id: null }));

    expect(markup).toContain("No provider is connected yet.");
    expect(markup).toContain("Connect one");
  });

  it("uses the shared catalog to render Kimi once it is connected", () => {
    const kimi = {
      ...providers().connections[0]!,
      provider_id: "kimi-coding",
    };
    const markup = render(providers({
      connections: [kimi],
      default_provider_id: "kimi-coding",
    }));

    expect(markup).toContain("Kimi");
    expect(markup).toContain("Kimi K2.7 Code");
    expect(markup).not.toContain("Claude");
    expect(markup).not.toContain("Claude Opus 4.8");
  });

  it("keeps the two-step picker and renders live z.ai models from the API payload", () => {
    const zai = {
      ...providers().connections[0]!,
      provider_id: "zai",
    };
    const markup = render(providers({
      connections: [zai],
      default_provider_id: "zai",
    }));

    expect(markup).toContain("1. Provider");
    expect(markup).toContain("2. Model");
    expect(markup).toContain("GLM-5.2");
    expect(markup).toContain("GLM-5.3");
  });

  it("tells a member without provider rights who can connect one", () => {
    const markup = render(providers({
      connections: [],
      default_provider_id: null,
      can_manage: false,
    }));

    expect(markup).toContain("Ask a workspace admin to connect one.");
    expect(markup).not.toContain("Connect one</button>");
  });
});
