import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => {
  class ServerApiError extends Error {
    readonly status: number;
    readonly path: string;

    constructor(input: { status: number; path: string; message: string }) {
      super(input.message);
      this.status = input.status;
      this.path = input.path;
    }
  }

  return {
    ServerApiError,
    serverApiFetch: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("./apiServer", () => apiMocks);

import { loadServerAuth } from "./serverAuth";

function apiError(status: number) {
  return new apiMocks.ServerApiError({ status, path: "/v1/auth/whoami", message: `status ${status}` });
}

describe("loadServerAuth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMocks.serverApiFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats only a 401 as unauthenticated and does not retry it", async () => {
    apiMocks.serverApiFetch.mockRejectedValue(apiError(401));

    await expect(loadServerAuth()).resolves.toEqual({ status: "unauthenticated" });
    expect(apiMocks.serverApiFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the session when a transient failure recovers on retry", async () => {
    const user = { userId: "user-1" };
    apiMocks.serverApiFetch.mockRejectedValueOnce(apiError(503)).mockResolvedValueOnce(user);

    const result = loadServerAuth<typeof user>();
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual({ status: "authenticated", user });
    expect(apiMocks.serverApiFetch).toHaveBeenCalledTimes(2);
  });

  it("returns unavailable after both transient retries are exhausted", async () => {
    apiMocks.serverApiFetch.mockRejectedValue(apiError(503));

    const result = loadServerAuth();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual({ status: "unavailable" });
    expect(apiMocks.serverApiFetch).toHaveBeenCalledTimes(3);
  });
});
