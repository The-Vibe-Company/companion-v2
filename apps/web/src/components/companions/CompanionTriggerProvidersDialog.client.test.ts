// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CompanionTriggerProviderAccount } from "@companion/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompanionTriggerProvidersDialog,
  type CompanionTriggerProvidersApi,
} from "./CompanionTriggerProvidersDialog";

const roots: Root[] = [];
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});
const api = {
  disconnectCompanionTriggerProviderAccount: vi.fn<CompanionTriggerProvidersApi["disconnectCompanionTriggerProviderAccount"]>(),
  saveCompanionTriggerProviderAccount: vi.fn<CompanionTriggerProvidersApi["saveCompanionTriggerProviderAccount"]>(),
  startCompanionPluginOAuth: vi.fn<CompanionTriggerProvidersApi["startCompanionPluginOAuth"]>(),
} satisfies CompanionTriggerProvidersApi;

function account(
  overrides: Partial<CompanionTriggerProviderAccount> = {},
): CompanionTriggerProviderAccount {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "github",
    label: "work",
    credential_source: "mcp_oauth",
    mcp_account_id: "22222222-2222-4222-8222-222222222222",
    status: "connected",
    dependent_trigger_count: 2,
    created_at: "2026-08-30T00:00:00.000Z",
    updated_at: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

async function mount(input: {
  accounts?: CompanionTriggerProviderAccount[];
  onAccountsChange?: (accounts: CompanionTriggerProviderAccount[]) => void;
  onMcpAccountRemoved?: (accountId: string) => void;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(CompanionTriggerProvidersDialog, {
      orgId: "org-1",
      accounts: input.accounts ?? [],
      onAccountsChange: input.onAccountsChange ?? (() => undefined),
      onMcpAccountRemoved: input.onMcpAccountRemoved,
      onClose: () => undefined,
      api,
    }));
  });
  return container;
}

function buttonNamed(container: ParentNode, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return button;
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("member-wide trigger provider management", () => {
  it("shows shared status and disconnects every dependent trigger without a Companion attachment", async () => {
    const connected = account();
    const disconnected = account({ status: "disconnected", mcp_account_id: null });
    api.disconnectCompanionTriggerProviderAccount.mockResolvedValue(disconnected);
    const onAccountsChange = vi.fn();
    const onMcpAccountRemoved = vi.fn();
    const container = await mount({
      accounts: [connected],
      onAccountsChange,
      onMcpAccountRemoved,
    });

    expect(container.textContent).toContain("there is no attachment step");
    expect(container.textContent).toContain("Shared OAuth · 2 triggers");
    await act(async () => buttonNamed(container, "Disconnect").click());

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining(
      "2 dependent triggers across all Companions will become unregistered",
    ));
    expect(api.disconnectCompanionTriggerProviderAccount).toHaveBeenCalledWith(
      "org-1",
      connected.id,
    );
    expect(onAccountsChange).toHaveBeenCalledWith([disconnected]);
    expect(onMcpAccountRemoved).toHaveBeenCalledWith(connected.mcp_account_id);
  });

  it("connects the Linear API-key fallback once at member level", async () => {
    const saved = account({
      id: "33333333-3333-4333-8333-333333333333",
      provider: "linear",
      credential_source: "api_key",
      mcp_account_id: null,
      dependent_trigger_count: 0,
    });
    api.saveCompanionTriggerProviderAccount.mockResolvedValue(saved);
    const onAccountsChange = vi.fn();
    const container = await mount({ onAccountsChange });

    await act(async () => buttonNamed(container, "Connect Linear").click());
    const providerDialog = container.querySelector(".companions-trigger-providers-dialog");
    const providerDialogLayer = providerDialog?.closest(".og-scrim")?.parentElement;
    expect(providerDialogLayer?.getAttribute("aria-hidden")).toBe("true");
    expect(providerDialogLayer?.hasAttribute("inert")).toBe(true);
    const inputs = [...container.querySelectorAll("#trigger-provider-key-form input")];
    const labelInput = inputs[0];
    const credentialInput = inputs[1];
    if (!(labelInput instanceof HTMLInputElement) || !(credentialInput instanceof HTMLInputElement)) {
      throw new Error("Missing provider key fields");
    }
    await act(async () => {
      setInput(labelInput, "work");
      setInput(credentialInput, "secret-key");
    });
    const form = container.querySelector("#trigger-provider-key-form");
    if (!(form instanceof HTMLFormElement)) throw new Error("Missing provider key form");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

    expect(api.saveCompanionTriggerProviderAccount).toHaveBeenCalledWith("org-1", {
      provider: "linear",
      label: "work",
      credential: "secret-key",
    });
    expect(onAccountsChange).toHaveBeenCalledWith([saved]);
  });
});
