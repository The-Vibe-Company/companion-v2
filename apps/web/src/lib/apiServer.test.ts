import { beforeEach, describe, expect, it, vi } from "vitest";

const nextMocks = vi.hoisted(() => ({
  headers: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => nextMocks);

import { serverApiFetch } from "./apiServer";

describe("serverApiFetch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    nextMocks.headers.mockResolvedValue(new Headers({ cookie: "session=existing" }));
  });

  it("prevents server rendering from consuming the browser's rolling refresh", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ userId: "user-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(serverApiFetch("/v1/auth/whoami")).resolves.toEqual({ userId: "user-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/v1/auth/whoami"),
      expect.objectContaining({
        headers: expect.objectContaining({
          cookie: "session=existing",
          "x-companion-disable-session-refresh": "1",
        }),
      }),
    );
  });
});
