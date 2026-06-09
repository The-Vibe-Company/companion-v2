import { describe, expect, it } from "vitest";
import { orgSettingsResponseSchema } from "../src/orgSettings";

const org = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  kind: "team" as const,
  plan: "team" as const,
  createdAt: "2026-06-01T12:00:00.000Z",
};

const validPayload = {
  org,
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
      description: null,
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
  invitations: [],
};

describe("orgSettingsResponseSchema", () => {
  it("parses a valid full payload unchanged", () => {
    expect(orgSettingsResponseSchema.parse(validPayload)).toEqual(validPayload);
  });

  it("defaults missing teams and invitations to empty arrays", () => {
    const parsed = orgSettingsResponseSchema.parse({ org, members: validPayload.members });
    expect(parsed.teams).toEqual([]);
    expect(parsed.invitations).toEqual([]);
  });

  it("defaults missing team members to an empty array and team description to null", () => {
    const parsed = orgSettingsResponseSchema.parse({
      org,
      members: validPayload.members,
      teams: [{ id: "team_1", slug: "platform", name: "Platform" }],
    });
    expect(parsed.teams[0]?.members).toEqual([]);
    expect(parsed.teams[0]?.description).toBeNull();
  });

  it("safeParse succeeds on a payload with org, invitations, and a team description", () => {
    const result = orgSettingsResponseSchema.safeParse({
      org,
      members: validPayload.members,
      teams: [
        {
          id: "team_1",
          slug: "platform",
          name: "Platform",
          description: "Owns the deployment control plane.",
          members: [],
        },
      ],
      invitations: [
        {
          id: "invite_1",
          email: "newbie@example.com",
          role: "developer",
          token: "tok_abc123",
          status: "pending",
          createdAt: "2026-06-08T12:00:00.000Z",
          expiresAt: "2026-06-22T12:00:00.000Z",
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.invitations[0]?.email).toBe("newbie@example.com");
    expect(result.success && result.data.teams[0]?.description).toBe("Owns the deployment control plane.");
  });

  it("rejects a payload missing the org identity", () => {
    expect(() => orgSettingsResponseSchema.parse({ members: validPayload.members, teams: [] })).toThrow();
  });

  it("rejects a non-array members field", () => {
    expect(() => orgSettingsResponseSchema.parse({ org, members: {}, teams: [] })).toThrow();
  });

  it("rejects a non-array teams field", () => {
    expect(() => orgSettingsResponseSchema.parse({ org, members: [], teams: {} })).toThrow();
  });
});
