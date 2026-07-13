// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgSettingsMember, SecretRow } from "@companion/contracts";
import { SecretsApp } from "./SecretsApp";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rpc = vi.hoisted(() => ({
  createSecret: vi.fn(),
  deleteSecret: vi.fn(),
  rotateSecret: vi.fn(),
  updateSecret: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/lib/secrets", () => rpc);
vi.mock("../org/OrgSwitcher", () => ({ OrgSwitcher: () => React.createElement("div", null, "Acme") }));
vi.mock("../org/Onboarding", () => ({ Onboarding: () => null }));
vi.mock("../org/useOrgActions", () => ({
  useOrgActions: () => ({
    onboarding: null,
    busy: false,
    error: null,
    switchOrg: vi.fn(),
    setOnboarding: vi.fn(),
    createOrg: vi.fn(),
    joinOrg: vi.fn(),
    setError: vi.fn(),
  }),
}));

const owner = { id: "user-1", name: "Ada Lovelace", initials: "AL", avatar_url: null };
const grace = { id: "user-2", name: "Grace Hopper", initials: "GH", avatar_url: null };

function secret(overrides: Partial<SecretRow> & Pick<SecretRow, "id" | "name" | "key">): SecretRow {
  return {
    org_id: "00000000-0000-4000-8000-000000000001",
    audience: "personal",
    owner,
    recipients: [],
    current_version: 1,
    last_rotated_at: "2026-07-13T10:00:00.000Z",
    disabled_at: null,
    deleted_at: null,
    created_at: "2026-07-13T10:00:00.000Z",
    updated_at: "2026-07-13T10:00:00.000Z",
    can_use: true,
    can_manage: true,
    usage_count: 2,
    ...overrides,
  };
}

const members: OrgSettingsMember[] = [
  { userId: "user-1", role: "owner", joined: "today", pending: false, name: owner.name, email: "ada@example.com", initials: owner.initials, avatarUrl: null },
  { userId: "user-2", role: "developer", joined: "today", pending: false, name: grace.name, email: "grace@example.com", initials: grace.initials, avatarUrl: null },
];

const rows: SecretRow[] = [
  secret({ id: "00000000-0000-4000-8000-000000000011", name: "Personal key", key: "PERSONAL_KEY" }),
  secret({ id: "00000000-0000-4000-8000-000000000012", name: "Team key", key: "TEAM_KEY", audience: "organization" }),
  secret({
    id: "00000000-0000-4000-8000-000000000013",
    name: "Shared key",
    key: "SHARED_KEY",
    audience: "restricted",
    owner: grace,
    can_manage: false,
    usage_count: 0,
  }),
];

const roots: Root[] = [];

async function mount(initialSecrets = rows) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(SecretsApp, {
      initialSecrets,
      members,
      me: { id: owner.id, name: owner.name, email: "ada@example.com", initials: owner.initials, avatarUrl: null },
      orgs: [{ id: "org-1", name: "Acme", slug: "acme", kind: "team", plan: "team", myRole: "owner", color: null, logoUrl: null }],
      currentOrg: { id: "org-1", name: "Acme", slug: "acme", kind: "team", plan: "team", myRole: "owner", color: null, logoUrl: null },
      initialCreateKey: null,
      navigation: {
        mineTreeRows: [],
        orgTreeRows: [],
        mineCount: 3,
        orgCount: 2,
        starredCount: 1,
        installedCount: 1,
        installedUpdateCount: 1,
        localUpdateCount: 0,
        archivedCount: 2,
      },
    }));
  });
  return container;
}

function clickByText(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  act(() => button.click());
}

describe("SecretsApp", () => {
  beforeEach(() => vi.clearAllMocks());

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  it("keeps the complete Skills navigation shell with Secrets selected", async () => {
    const container = await mount();
    const primary = container.querySelector('nav[aria-label="Primary"]') as HTMLElement;
    expect(primary.textContent).toContain("My Skills");
    expect(primary.textContent).toContain("Organization");
    expect(primary.textContent).toContain("Starred");
    expect(primary.textContent).toContain("Installed");
    expect(primary.textContent).toContain("Companion skills");
    expect(primary.textContent).toContain("Archived");
    expect(primary.querySelector('[aria-current="page"]')?.textContent).toContain("Secrets");
    expect(primary.querySelector('[aria-label="New personal folder"]')).toBeNull();
    expect(primary.querySelector('[title="1 update available"]')).not.toBeNull();
  });

  it("closes the shared mobile navigation with Escape", async () => {
    const container = await mount();
    const toggle = container.querySelector('.side__toggle') as HTMLButtonElement;
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".side-scrim")).not.toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".side-scrim")).toBeNull();
  });

  it("restores focus to the New secret trigger when the create drawer closes", async () => {
    const container = await mount();
    const trigger = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("New secret")) as HTMLButtonElement;
    trigger.focus();
    act(() => trigger.click());
    const close = container.querySelector('.sec-drawer button[aria-label="Close"]') as HTMLButtonElement;
    await act(async () => {
      close.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("discards an entered plaintext value when creation is cancelled", async () => {
    const container = await mount([]);
    clickByText(container, "New secret");
    const value = container.querySelector('.sec-form input[type="password"]') as HTMLInputElement;
    await act(async () => {
      value.value = "plaintext-that-must-be-discarded";
      value.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => (container.querySelector('.sec-drawer button[aria-label="Close"]') as HTMLButtonElement).click());
    clickByText(container, "New secret");
    expect((container.querySelector('.sec-form input[type="password"]') as HTMLInputElement).value).toBe("");
  });

  it("separates owned and shared secrets and renders all audience labels", async () => {
    const container = await mount();
    expect(container.textContent).toContain("Owned");
    expect(container.textContent).toContain("Shared with me");
    expect(container.textContent).toContain("Personal");
    expect(container.textContent).toContain("Selected members");
    expect(container.textContent).toContain("Organization");
  });

  it("never renders a reveal or copy action in the metadata drawer", async () => {
    const container = await mount();
    clickByText(container, "Personal key");
    expect(container.textContent).toContain("Value protected");
    expect(container.textContent).toContain("never reveals or copies");
    const actions = Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim().toLowerCase());
    expect(actions).not.toContain("reveal");
    expect(actions).not.toContain("copy");
  });

  it("requires an explicit named confirmation before deleting a secret", async () => {
    rpc.deleteSecret.mockResolvedValue(undefined);
    const container = await mount();
    clickByText(container, "Personal key");
    clickByText(container, "Delete");
    expect(rpc.deleteSecret).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Delete “Personal key”?');
    expect(container.textContent).toContain("This cannot be undone");

    await act(async () => clickByText(container, "Delete permanently"));
    expect(rpc.deleteSecret).toHaveBeenCalledWith("org-1", "00000000-0000-4000-8000-000000000011");
  });

  it("exposes modal semantics, closes on Escape, and removes the closed drawer from navigation", async () => {
    const container = await mount();
    clickByText(container, "Personal key");
    const drawer = container.querySelector(".sec-drawer") as HTMLElement;
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(drawer.getAttribute("aria-hidden")).toBe("false");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(drawer.getAttribute("aria-hidden")).toBe("true");
    expect(drawer.inert).toBe(true);
  });

  it("discards access changes when editing is cancelled", async () => {
    const container = await mount();
    clickByText(container, "Personal key");
    clickByText(container, "Edit");
    let select = container.querySelector(".sec-access-edit select") as HTMLSelectElement;
    await act(async () => {
      select.value = "organization";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    clickByText(container, "Cancel");
    clickByText(container, "Edit");
    select = container.querySelector(".sec-access-edit select") as HTMLSelectElement;
    expect(select.value).toBe("personal");
  });

  it("shows the member picker only for selected-member access", async () => {
    const container = await mount([]);
    clickByText(container, "New secret");
    const select = container.querySelector(".sec-form select") as HTMLSelectElement;
    expect(container.textContent).not.toContain("grace@example.com");
    await act(async () => {
      select.value = "restricted";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("grace@example.com");
    expect(container.textContent).toContain("Only you and selected members");
  });
});
