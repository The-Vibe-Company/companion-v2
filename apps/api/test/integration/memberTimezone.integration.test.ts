import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getUserTimezone, updateUserProfile } from "@companion/core/services";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
} from "./testDatabase";

describe("member timezone over the real database", () => {
  let fixture: IntegrationFixture;

  beforeEach(async () => {
    fixture = await createIntegrationFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  afterAll(async () => {
    await integrationSql.end();
  });

  it("persists one personal timezone across workspace membership without changing identity", async () => {
    await expect(getUserTimezone({ actor: fixture.developer, database: integrationDb }))
      .resolves.toBeNull();

    const updated = await updateUserProfile({
      actor: fixture.developer,
      timezone: "Pacific/Auckland",
      database: integrationDb,
    });
    expect(updated).toMatchObject({
      id: fixture.developer.id,
      name: fixture.developer.name,
      timezone: "Pacific/Auckland",
    });
    await expect(getUserTimezone({ actor: fixture.developer, database: integrationDb }))
      .resolves.toBe("Pacific/Auckland");
  });
});
