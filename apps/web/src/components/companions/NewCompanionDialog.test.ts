import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompanionProvidersResponse } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import { NewCompanionDialog } from "./NewCompanionDialog";

const noop = () => {};

function providers(overrides: Partial<CompanionProvidersResponse> = {}): CompanionProvidersResponse {
  return {
    catalog: [
      { id: "anthropic", name: "Claude", auth_methods: ["api_key", "subscription"], description: "" },
      { id: "zai", name: "z.ai", auth_methods: ["api_key"], description: "" },
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
  it("asks for a name, a persona, and one connected provider and nothing else", () => {
    const markup = render(providers());

    expect(markup).toContain("Name");
    expect(markup).toContain("Persona");
    expect(markup).toContain("Claude");
    expect(markup).toContain("Default");
    // Two text fields plus one radio per connected provider: no SDK, model, or settings wizard.
    expect(markup.match(/<input/g)).toHaveLength(3);
    expect(markup).not.toContain("z.ai");
  });

  it("points an admin at provider setup when the workspace has no provider", () => {
    const markup = render(providers({ connections: [], default_provider_id: null }));

    expect(markup).toContain("No provider is connected yet.");
    expect(markup).toContain("Connect one");
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
