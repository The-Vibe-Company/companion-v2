// @vitest-environment happy-dom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPublicInstallPrompt, PublicSkillActions } from "./PublicSkillActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const release = {
  version: "2.3.4",
  checksum: `sha256:${"a".repeat(64)}`,
  size_bytes: 4096,
  released_at: "2026-07-21T10:00:00.000Z",
};

describe("buildPublicInstallPrompt", () => {
  it("pins Agent Auth, the exact release, and safe atomic extraction", () => {
    const prompt = buildPublicInstallPrompt({
      origin: "https://companion.example",
      token: "public-token",
      slug: "release-helper",
      release,
    });
    expect(prompt).toContain("@auth/agent-cli@0.5.1");
    expect(prompt).toContain("--url=https://companion.example");
    expect(prompt).toContain('connection "$agent_id"');
    expect(prompt).toContain('status "$agent_id"');
    expect(prompt.split('status "$agent_id"')).toHaveLength(4);
    expect(prompt).toContain('request "$agent_id" --capabilities public-skills:install');
    expect(prompt).toContain("--preferred-method device_authorization");
    expect(prompt).toContain('connect --provider https://companion.example --mode delegated');
    expect(prompt).toContain('status is exactly "active"');
    expect(prompt).toContain("agent_capability_grants contains public-skills:install");
    expect(prompt).toContain("agent is active but that active grant is absent");
    expect(prompt).toContain("live status is not active");
    expect(prompt).toContain("agent_not_found");
    expect(prompt).toContain("host_revoked or host_not_found");
    expect(prompt).toContain("fresh empty mode-0700 storage directory");
    expect(prompt).toContain("Do not copy the revoked host.json");
    expect(prompt.indexOf('connection "$agent_id"')).toBeLessThan(prompt.indexOf('status "$agent_id"'));
    expect(prompt.indexOf('status "$agent_id"')).toBeLessThan(prompt.indexOf('request "$agent_id"'));
    expect(prompt).not.toContain(" connections ");
    expect(prompt).toContain("public-skills:install");
    expect(prompt).toContain("release-helper@2.3.4");
    expect(prompt).toContain("public-token");
    expect(prompt).toContain(release.checksum);
    expect(prompt).toContain("4096 bytes");
    expect(prompt).toContain("Reject absolute paths, .. traversal");
    expect(prompt).toContain("atomically swap");
    expect(prompt).toContain("Never interpolate the ticket");
    expect(prompt).toContain("Pipe the captured JSON over stdin");
    expect(prompt).toContain("do not resolve dependencies, secrets, skill_installs, or scripts");
  });
});

describe("PublicSkillActions", () => {
  let root: Root;
  let host: HTMLDivElement;
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("copies an autonomous prompt and exposes a session download", async () => {
    await act(async () => {
      root.render(React.createElement(PublicSkillActions, {
        token: "public-token",
        slug: "release-helper",
        release,
        authenticated: true,
      }));
    });
    const copy = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Copy install prompt"));
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]?.[0]).toContain("release-helper@2.3.4");
    const download = host.querySelector<HTMLAnchorElement>('a[download]');
    expect(download?.getAttribute("href")).toBe("/v1/public/skills/public-token/versions/2.3.4/package");
  });

  it("returns signed-out users to the same public page before downloading", async () => {
    await act(async () => {
      root.render(React.createElement(PublicSkillActions, {
        token: "public-token",
        slug: "release-helper",
        release,
        authenticated: false,
      }));
    });
    const signIn = [...host.querySelectorAll("a")].find((anchor) => anchor.textContent?.includes("Sign in to download"));
    expect(signIn?.getAttribute("href")).toContain("%2Fs%2Fpublic-token%3Fdownload%3D1");
  });

  it("does not offer package actions for a metadata-only link", async () => {
    await act(async () => {
      root.render(React.createElement(PublicSkillActions, {
        token: "public-token",
        slug: "release-helper",
        release: null,
        authenticated: false,
      }));
    });
    expect(host.textContent).toContain("No public release");
    expect(host.querySelector('a[download]')).toBeNull();
    expect(host.textContent).not.toContain("Copy install prompt");
  });
});
