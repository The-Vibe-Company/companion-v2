import { describe, expect, it } from "vitest";
import { refreshTokenResponseSchema } from "../src/token";

describe("refreshTokenResponseSchema", () => {
  it("accepts metadata-only current responses", () => {
    const parsed = refreshTokenResponseSchema.parse({
      status: "current",
      scopes: ["skills:read", "skills:write"],
      expires_at: "2026-08-01T00:00:00.000Z",
    });
    expect(parsed.status).toBe("current");
    expect(parsed).not.toHaveProperty("token");
  });

  it("requires the one-time plaintext only for rotated responses", () => {
    expect(
      refreshTokenResponseSchema.parse({
        status: "rotated",
        id: "token-2",
        token: "cmp_pat_replacement",
        prefix: "cmp_pat_replac",
        scopes: ["skills:read"],
        expires_at: "2026-10-19T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "rotated", token: "cmp_pat_replacement" });
    expect(() =>
      refreshTokenResponseSchema.parse({
        status: "rotated",
        id: "token-2",
        prefix: "cmp_pat_replac",
        scopes: ["skills:read"],
        expires_at: "2026-10-19T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
