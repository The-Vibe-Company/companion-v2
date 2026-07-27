// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillVM } from "@/lib/types";
import { InstallDialog } from "./UploadDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const queryMocks = vi.hoisted(() => ({
  fetchSkillBySlug: vi.fn(() => new Promise(() => {})),
  fetchSkillDependencies: vi.fn().mockResolvedValue({ requires: [] }),
}));

vi.mock("@/lib/queries", () => ({
  apiBase: () => "http://127.0.0.1:3001",
  fetchSkillBySlug: queryMocks.fetchSkillBySlug,
  fetchSkillDependencies: queryMocks.fetchSkillDependencies,
  versionPackageUrl: vi.fn(),
}));

vi.mock("../secrets/SkillSecretConfiguration", () => ({
  SkillSecretConfiguration: () => null,
}));

const skill = {
  id: "research-agent",
  version: "1.2.3",
  installStatus: "none",
} as SkillVM;

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("InstallDialog", () => {
  it("selects OpenClaw and shows its managed global destination", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        React.createElement(InstallDialog, {
          skill,
          workspaceId: "org-1",
          onClose: vi.fn(),
          onReported: vi.fn(),
        }),
      );
    });

    const manual = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Download package"),
    );
    expect(manual).toBeTruthy();
    await act(async () => manual?.click());

    const openClaw = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]')).find((radio) =>
      radio.textContent?.includes("OpenClaw"),
    );
    expect(openClaw).toBeTruthy();
    await act(async () => openClaw?.click());

    expect(openClaw?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("~/.openclaw/skills/research-agent");
  });
});
