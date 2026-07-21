// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

const navigationMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  useRouter: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: navigationMocks.useRouter }));

import { AuthUnavailable } from "./WorkspaceLoadError";

describe("AuthUnavailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigationMocks.useRouter.mockReturnValue({ refresh: navigationMocks.refresh });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("keeps the session recoverable with a Retry action", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => root.render(React.createElement(AuthUnavailable)));
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Retry");
    expect(retry).toBeDefined();

    act(() => retry?.click());
    expect(navigationMocks.refresh).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });
});
