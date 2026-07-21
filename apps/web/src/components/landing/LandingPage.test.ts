// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "./LandingPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

class MockIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }

  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

async function renderLanding(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(LandingPage));
  });
  return container;
}

function portal(container: HTMLElement): HTMLElement {
  const match = container.querySelector<HTMLElement>('[data-screen-label="portal-capture"]');
  if (!match) throw new Error("Portal capture not found");
  return match;
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
  return match;
}

function navButton(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll<HTMLButtonElement>(".v5-portal__navitem")).find(
    (candidate) => candidate.textContent?.trim().startsWith(label),
  );
  if (!match) throw new Error(`Portal navigation button not found: ${label}`);
  return match;
}

function row(container: HTMLElement, id: string): HTMLElement {
  const match = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
    (candidate) => candidate.querySelector(".v5-portal__name")?.textContent === id,
  );
  if (!match) throw new Error(`Portal row not found: ${id}`);
  return match;
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

describe("LandingPage portal preview", () => {
  it("models the canonical personal and organization libraries without retired stars or teams", async () => {
    const container = await renderLanding();
    const capture = portal(container);

    expect(capture.querySelectorAll(".v5-portal__crow")).toHaveLength(5);
    expect(navButton(capture, "Organization").getAttribute("aria-current")).toBe("true");
    expect(capture.textContent).not.toContain("Starred");
    expect(capture.textContent).not.toContain("Team picks");
    expect(capture.textContent).not.toContain("Teams");
    expect(capture.textContent).toContain("click around: filter, pick a skill.");

    await act(async () => navButton(capture, "My Skills").click());

    expect(capture.querySelectorAll(".v5-portal__crow")).toHaveLength(1);
    expect(row(capture, "weekly-report").getAttribute("aria-pressed")).toBe("true");
    expect(capture.querySelector(".v6-pdrawer__title")?.textContent).toBe("weekly-report");

    const clearLibrary = capture.querySelector<HTMLButtonElement>('[aria-label="Clear library filter"]');
    if (!clearLibrary) throw new Error("Clear library filter button not found");
    await act(async () => clearLibrary.click());
    expect(navButton(capture, "Organization").getAttribute("aria-current")).toBe("true");
    expect(capture.querySelectorAll(".v5-portal__crow")).toHaveLength(5);

    await act(async () => navButton(capture, "My Skills").click());
    await act(async () => button(capture, "Recently updated").click());

    expect(capture.querySelectorAll(".v5-portal__crow")).toHaveLength(0);
    expect(capture.textContent).toContain("No recently updated skills in My Skills.");
    expect(capture.textContent).toContain("No skill selected.");
  });

  it("supports mouse and keyboard selection and keeps installation feedback in the focused control", async () => {
    const container = await renderLanding();
    const capture = portal(container);
    const debug = row(capture, "debug-my-setup");

    await act(async () => debug.click());
    expect(debug.getAttribute("aria-pressed")).toBe("true");
    expect(capture.querySelector(".v6-pdrawer__title")?.textContent).toBe("debug-my-setup");

    const sales = row(capture, "sales-research");

    sales.focus();
    await act(async () => {
      sales.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(sales.getAttribute("aria-pressed")).toBe("true");
    expect(capture.querySelector(".v6-pdrawer__title")?.textContent).toBe("sales-research");

    const install = button(capture, "Use this skill");
    install.focus();
    await act(async () => install.click());

    expect(document.activeElement).toBe(install);
    expect(install.disabled).toBe(false);
    expect(install.getAttribute("aria-disabled")).toBe("true");
    expect(install.getAttribute("aria-pressed")).toBe("true");
    expect(install.textContent?.trim()).toBe("Added");

    const brandVoice = row(capture, "brand-voice");
    await act(async () => {
      brandVoice.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    expect(brandVoice.getAttribute("aria-pressed")).toBe("true");
  });

  it("uses native links for navigation and avoids absolute data-residency promises", async () => {
    const container = await renderLanding();
    const share = Array.from(container.querySelectorAll("a")).find(
      (candidate) => candidate.textContent?.trim() === "Share a skill",
    );
    const howItWorks = Array.from(container.querySelectorAll("a")).find(
      (candidate) => candidate.textContent?.trim() === "See how it works",
    );
    const github = Array.from(container.querySelectorAll("a")).find(
      (candidate) => candidate.textContent?.trim() === "GitHub ↗",
    );

    expect(share?.getAttribute("href")).toBe("/login");
    expect(howItWorks?.getAttribute("href")).toBe("#problem");
    expect(github?.getAttribute("href")).toBe("https://github.com/The-Vibe-Company/companion");
    expect(github?.getAttribute("target")).toBe("_blank");
    expect(container.textContent).toContain("governance stays on infrastructure you control");
    expect(container.textContent).not.toContain("your data never leave the building");
  });
});
