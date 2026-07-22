import { beforeEach, describe, expect, it, vi } from "vitest";

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));

vi.mock("@companion/db", () => ({ sql: sqlMock }));

import { postgresAgentAuthStorage } from "./postgres-secondary-storage";

describe("PostgreSQL Agent Auth secondary storage", () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  it("atomically consumes live values when postgres.js returns timestamptz as a string", async () => {
    sqlMock.mockResolvedValueOnce([{
      value: "one-time-value",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }]);

    await expect(postgresAgentAuthStorage.getAndDelete("otp:key")).resolves.toBe("one-time-value");
    expect(sqlMock).toHaveBeenCalledOnce();
  });

  it("does not return expired or malformed timestamp values", async () => {
    sqlMock
      .mockResolvedValueOnce([{ value: "expired", expires_at: new Date(Date.now() - 1_000).toISOString() }])
      .mockResolvedValueOnce([{ value: "malformed", expires_at: "not-a-timestamp" }]);

    await expect(postgresAgentAuthStorage.getAndDelete("otp:expired")).resolves.toBeNull();
    await expect(postgresAgentAuthStorage.getAndDelete("otp:malformed")).resolves.toBeNull();
  });
});
