import { describe, expect, it } from "vitest";
import { emailIdempotencyKey } from "../src";

describe("emailIdempotencyKey", () => {
  it("normalizes retry keys", () => {
    expect(emailIdempotencyKey(["Invite", " Acme ", "USER@EXAMPLE.COM"])).toBe(
      "invite:acme:user@example.com",
    );
  });
});
