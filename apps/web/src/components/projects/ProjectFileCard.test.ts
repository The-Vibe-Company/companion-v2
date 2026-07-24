// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectFileVM } from "@/lib/projectsModel";
import { ProjectFileCard } from "./ProjectSessionView";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fileRpc = vi.hoisted(() => ({
  fetchProjectFileVersions: vi.fn(),
  projectFileVersionHref: vi.fn(
    (projectId: string, fileId: string, version: number, download: boolean) =>
      `/v1/projects/${projectId}/files/${fileId}/versions/${version}${download ? "?download=1" : ""}`,
  ),
}));

vi.mock("@/lib/projects", () => ({
  fetchProjectFileVersions: fileRpc.fetchProjectFileVersions,
  fetchProjectFiles: vi.fn(),
  fetchProjectSession: vi.fn(),
  projectFileHref: (projectId: string, fileId: string, download = false) =>
    `/v1/projects/${projectId}/files/${fileId}${download ? "?download=1" : ""}`,
  projectFileVersionHref: fileRpc.projectFileVersionHref,
  sendProjectPrompt: vi.fn(),
  stopProjectSession: vi.fn(),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FILE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-07-24T05:00:00.000Z";
const roots: Root[] = [];

function file(overrides: Partial<ProjectFileVM> = {}): ProjectFileVM {
  return {
    id: FILE_ID,
    path: "files/planning/calendar.md",
    name: "planning/calendar.md",
    version: 3,
    contentType: "text/markdown",
    byteSize: 1_024,
    conflictDetected: true,
    updatedAt: NOW,
    ...overrides,
  };
}

async function renderFile(projectFile: ProjectFileVM) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      React.createElement(ProjectFileCard, {
        projectId: PROJECT_ID,
        file: projectFile,
      }),
    );
    await Promise.resolve();
  });
  return container;
}

afterEach(() => {
  vi.clearAllMocks();
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

describe("ProjectFileCard", () => {
  it("loads retryable prior history and downloads an exact conflicted version", async () => {
    fileRpc.fetchProjectFileVersions
      .mockRejectedValueOnce(new Error("History unavailable"))
      .mockResolvedValueOnce([
        {
          projectId: PROJECT_ID,
          fileId: FILE_ID,
          path: "files/planning/calendar.md",
          version: 3,
          contentType: "text/markdown",
          byteSize: 1_024,
          checksum: "current",
          modifiedBySessionId: SESSION_ID,
          baseVersion: 2,
          conflictDetected: false,
          createdAt: NOW,
        },
        {
          projectId: PROJECT_ID,
          fileId: FILE_ID,
          path: "files/planning/calendar.md",
          version: 2,
          contentType: "text/markdown",
          byteSize: 900,
          checksum: "prior",
          modifiedBySessionId: SESSION_ID,
          baseVersion: 1,
          conflictDetected: true,
          createdAt: NOW,
        },
      ]);
    const container = await renderFile(file());

    expect(container.textContent).toContain("planning/calendar.md");
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((candidate) => candidate.textContent === "History")
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("History unavailable");

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((candidate) => candidate.textContent === "Retry")
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fileRpc.fetchProjectFileVersions).toHaveBeenLastCalledWith(
      PROJECT_ID,
      FILE_ID,
    );
    expect(container.textContent).toContain("Version 2");
    expect(container.textContent).not.toContain("Version 3");
    expect(container.textContent).toContain(
      "Conflict detected · based on version 1",
    );
    expect(
      container
        .querySelector<HTMLAnchorElement>(
          'a[aria-label="Download planning/calendar.md version 2"]',
        )
        ?.getAttribute("href"),
    ).toBe(`/v1/projects/${PROJECT_ID}/files/${FILE_ID}/versions/2?download=1`);
    expect(fileRpc.projectFileVersionHref).toHaveBeenCalledWith(
      PROJECT_ID,
      FILE_ID,
      2,
      true,
    );
  });

  it("does not offer history for a first version", async () => {
    const container = await renderFile(
      file({
        version: 1,
        conflictDetected: false,
      }),
    );

    expect(container.textContent).not.toContain("History");
    expect(fileRpc.fetchProjectFileVersions).not.toHaveBeenCalled();
  });
});
