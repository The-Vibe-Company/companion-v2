// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigationMocks = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigationMocks.refresh }),
}));

import { SessionKeepAlive, SESSION_KEEPALIVE_THROTTLE_MS } from "./SessionKeepAlive";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SessionKeepAlive", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00Z"));
    navigationMocks.refresh.mockReset();
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("refreshes on mount and throttles visible-tab refreshes for five minutes", async () => {
    await act(async () => root.render(createElement(SessionKeepAlive)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/v1/auth/whoami", {
      cache: "no-store",
      credentials: "same-origin",
    });

    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + SESSION_KEEPALIVE_THROTTLE_MS);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes the server-rendered route when the session is authoritatively revoked", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    await act(async () => {
      root.render(createElement(SessionKeepAlive));
      await Promise.resolve();
    });

    expect(navigationMocks.refresh).toHaveBeenCalledTimes(1);
  });
});
