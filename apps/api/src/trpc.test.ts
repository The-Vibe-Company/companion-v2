import { describe, expect, it } from "vitest";

describe("appRouter", () => {
  it("exposes the greenfield API tRPC procedures", async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://companion:companion@127.0.0.1:5432/companion";
    const { appRouter } = await import("./trpc");
    expect(Object.keys(appRouter._def.procedures).sort()).toEqual([
      "me",
      "notifications",
      "notificationsUnreadCount",
      "orgs",
      "skillVersions",
      "skills",
    ]);
  });
});
