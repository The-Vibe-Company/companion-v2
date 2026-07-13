// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillSecretConfiguration as Configuration } from "@companion/contracts";
import { SkillSecretConfiguration } from "./SkillSecretConfiguration";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rpc = vi.hoisted(() => ({
  acceptSkillSecretSuggestion: vi.fn(),
  fetchSkillSecretConfiguration: vi.fn(),
  removeSkillSecretBinding: vi.fn(),
  removeSkillSecretSuggestion: vi.fn(),
  setSkillSecretBinding: vi.fn(),
  setSkillSecretSuggestion: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/secrets", () => rpc);

const mine = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "My OpenRouter",
  key: "OPENROUTER_API_KEY",
  owner: { id: "user-1", name: "Ada", initials: "AL", avatar_url: null },
  audience: "personal" as const,
  personal: true,
};
const shared = {
  ...mine,
  id: "00000000-0000-4000-8000-000000000102",
  name: "Shared OpenRouter",
  owner: { id: "user-2", name: "Grace", initials: "GH", avatar_url: null },
  audience: "organization" as const,
  personal: false,
};

const config: Configuration = {
  skill_id: "00000000-0000-4000-8000-000000000201",
  slug: "demo-skill",
  version: "1.0.0",
  configured: false,
  blockers: 1,
  warnings: 1,
  slots: [
    { slot_id: "00000000-0000-4000-8000-000000000211", env_key: "MINE", description: "", required: true, status: "personal", binding: mine, suggestion: null, suggestion_confirmed: false, candidates: [mine] },
    { slot_id: "00000000-0000-4000-8000-000000000212", env_key: "SHARED", description: "", required: true, status: "shared", binding: shared, suggestion: null, suggestion_confirmed: false, candidates: [shared] },
    { slot_id: "00000000-0000-4000-8000-000000000213", env_key: "MISSING", description: "", required: true, status: "required", binding: null, suggestion: shared, suggestion_confirmed: false, candidates: [mine, shared] },
    { slot_id: "00000000-0000-4000-8000-000000000214", env_key: "OPTIONAL", description: "", required: false, status: "optional_missing", binding: null, suggestion: null, suggestion_confirmed: false, candidates: [] },
  ],
};

const roots: Root[] = [];
async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(SkillSecretConfiguration, { slug: "demo-skill", canSuggest: true }));
    await Promise.resolve();
  });
  return container;
}

describe("SkillSecretConfiguration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.fetchSkillSecretConfiguration.mockResolvedValue(config);
    rpc.acceptSkillSecretSuggestion.mockResolvedValue(config);
    rpc.removeSkillSecretSuggestion.mockResolvedValue(config);
  });

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = "";
  });

  it("uses user-facing language for every binding state", async () => {
    const container = await mount();
    expect(container.textContent).toContain("Using my key");
    expect(container.textContent).toContain("Using key shared by Grace");
    expect(container.textContent).toContain("Configuration required");
    expect(container.textContent).toContain("Optional secret absent");
    expect(container.textContent).not.toContain("slot_id");
  });

  it("accepts an accessible shared suggestion without exposing a value", async () => {
    const container = await mount();
    const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes("Use the key shared by Grace"));
    expect(button).toBeTruthy();
    await act(async () => {
      button!.click();
      await Promise.resolve();
    });
    expect(rpc.acceptSkillSecretSuggestion).toHaveBeenCalledWith("demo-skill", "00000000-0000-4000-8000-000000000213");
    expect(container.textContent).not.toContain("secret-value");
  });

  it("removes a shared suggestion when the empty option is selected", async () => {
    const container = await mount();
    const select = Array.from(container.querySelectorAll<HTMLSelectElement>(".sksec-share-default select"))
      .find((node) => node.value === shared.id);
    expect(select).toBeTruthy();
    await act(async () => {
      select!.value = "";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(rpc.removeSkillSecretSuggestion).toHaveBeenCalledWith("demo-skill", "00000000-0000-4000-8000-000000000213");
  });

  it("serializes slot mutations so older responses cannot overwrite newer state", async () => {
    let resolveMutation: (value: Configuration) => void = () => undefined;
    rpc.removeSkillSecretBinding.mockReturnValue(new Promise<Configuration>((resolve) => { resolveMutation = resolve; }));
    const container = await mount();
    const credentialSelects = Array.from(container.querySelectorAll<HTMLSelectElement>(".sksec-slot__controls select"));
    await act(async () => {
      credentialSelects[0]!.value = "";
      credentialSelects[0]!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(credentialSelects.every((select) => select.disabled)).toBe(true);
    await act(async () => {
      resolveMutation(config);
      await Promise.resolve();
    });
    expect(credentialSelects.every((select) => !select.disabled)).toBe(true);
  });
});
