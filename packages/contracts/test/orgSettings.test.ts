import { describe, expect, it } from "vitest";
import { orgSettingsResponseSchema } from "../src/orgSettings";

const validPayload = {
  members: [
    {
      userId: "user_1",
      role: "owner",
      joined: "2026-06-08T12:00:00.000Z",
      pending: false,
      name: "Stan Girard",
      email: "stan@example.com",
      initials: "SG",
    },
  ],
  teams: [
    {
      id: "team_1",
      slug: "platform",
      name: "Platform",
      members: [
        {
          userId: "user_1",
          role: "admin",
          name: "Stan Girard",
          email: "stan@example.com",
          initials: "SG",
        },
      ],
    },
  ],
};

describe("orgSettingsResponseSchema", () => {
  it("parses a valid full payload unchanged", () => {
    expect(orgSettingsResponseSchema.parse(validPayload)).toEqual(validPayload);
  });

  it("defaults missing teams to an empty array", () => {
    const parsed = orgSettingsResponseSchema.parse({ members: validPayload.members });
    expect(parsed.teams).toEqual([]);
  });

  it("defaults missing team members to an empty array", () => {
    const parsed = orgSettingsResponseSchema.parse({
      members: validPayload.members,
      teams: [{ id: "team_1", slug: "platform", name: "Platform" }],
    });
    expect(parsed.teams[0]?.members).toEqual([]);
  });

  it("rejects a non-array members field", () => {
    expect(() => orgSettingsResponseSchema.parse({ members: {}, teams: [] })).toThrow();
  });

  it("rejects a non-array teams field", () => {
    expect(() => orgSettingsResponseSchema.parse({ members: [], teams: {} })).toThrow();
  });
});
