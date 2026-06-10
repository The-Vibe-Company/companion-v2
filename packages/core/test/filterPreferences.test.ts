import { describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";
import { skillFilterPreferencesSchema } from "@companion/contracts";
import { getSkillFilterPreferences, setSkillFilterPreferences, type ActorContext } from "../src/services";

const actor: ActorContext = { id: "user-1", email: "user@example.com", name: "User One" };

function fakeDb(options: {
  member?: boolean;
  existing?: { activeFilters: unknown[]; customViews: unknown[] } | null;
} = {}) {
  const state: {
    inserted?: Record<string, unknown>;
    conflict?: Record<string, unknown>;
  } = {};
  const onConflictDoUpdate = vi.fn(async (conflict: Record<string, unknown>) => {
    state.conflict = conflict;
  });
  const values = vi.fn((inserted: Record<string, unknown>) => {
    state.inserted = inserted;
    return { onConflictDoUpdate };
  });
  const database = {
    query: {
      memberships: {
        findFirst: vi.fn(async () => (options.member === false ? null : { orgRole: "developer" })),
      },
      skillFilterPreferences: {
        findFirst: vi.fn(async () => options.existing ?? null),
      },
    },
    insert: vi.fn(() => ({ values })),
  };
  return { database: database as unknown as Db, state, values, onConflictDoUpdate };
}

describe("skill filter preferences", () => {
  it("validates the shared preference contract", () => {
    const parsed = skillFilterPreferencesSchema.parse({
      active_filters: [
        { type: "visibility", value: "everyone" },
        { type: "status", value: "invalid" },
        { type: "starred", value: "true" },
        { type: "owner", value: "Alice Nardon" },
        { type: "team", value: "platform" },
      ],
      custom_views: [
        {
          id: "view-1",
          name: "Everyone",
          icon: "bookmark",
          custom: true,
          filters: [{ type: "visibility", value: "everyone" }],
        },
      ],
    });
    expect(parsed.active_filters).toContainEqual({ type: "visibility", value: "everyone" });
    expect(parsed.custom_views[0]?.id).toBe("view-1");
    expect(skillFilterPreferencesSchema.parse({})).toEqual({ active_filters: [], custom_views: [] });
    expect(() => skillFilterPreferencesSchema.parse({ active_filters: [{ type: "unknown", value: "everyone" }], custom_views: [] })).toThrow();
    expect(() => skillFilterPreferencesSchema.parse({ active_filters: [{ type: "visibility", value: "public" }], custom_views: [] })).toThrow();
    expect(() => skillFilterPreferencesSchema.parse({ active_filters: [{ type: "starred", value: "false" }], custom_views: [] })).toThrow();
  });

  it("returns defaults when the user has no saved row", async () => {
    const { database } = fakeDb();

    await expect(getSkillFilterPreferences({ actor, orgId: "00000000-0000-0000-0000-000000000001", database })).resolves.toEqual({
      active_filters: [],
      custom_views: [],
    });
  });

  it("parses an existing preference row", async () => {
    const { database } = fakeDb({
      existing: {
        activeFilters: [{ type: "visibility", value: "everyone" }],
        customViews: [
          {
            id: "view-1",
            name: "Everyone",
            icon: "bookmark",
            custom: true,
            filters: [{ type: "visibility", value: "everyone" }],
          },
        ],
      },
    });

    await expect(getSkillFilterPreferences({ actor, orgId: "00000000-0000-0000-0000-000000000001", database })).resolves.toEqual({
      active_filters: [{ type: "visibility", value: "everyone" }],
      custom_views: [
        {
          id: "view-1",
          name: "Everyone",
          icon: "bookmark",
          custom: true,
          filters: [{ type: "visibility", value: "everyone" }],
        },
      ],
    });
  });

  it("normalizes old persisted scope filters before parsing", async () => {
    const { database } = fakeDb({
      existing: {
        activeFilters: [{ type: "scope", value: "public" }],
        customViews: [
          {
            id: "view-1",
            name: "Team",
            icon: "users",
            custom: true,
            filters: [
              { type: "scope", value: "team" },
              { type: "status", value: "valid" },
            ],
          },
        ],
      },
    });

    await expect(getSkillFilterPreferences({ actor, orgId: "00000000-0000-0000-0000-000000000001", database })).resolves.toEqual({
      active_filters: [{ type: "visibility", value: "everyone" }],
      custom_views: [
        {
          id: "view-1",
          name: "Team",
          icon: "users",
          custom: true,
          filters: [
            { type: "visibility", value: "team" },
            { type: "status", value: "valid" },
          ],
        },
      ],
    });
  });

  it("upserts preferences for the current org and actor", async () => {
    const { database, state, onConflictDoUpdate } = fakeDb();
    const orgId = "00000000-0000-0000-0000-000000000001";

    await setSkillFilterPreferences({
      actor,
      orgId,
      database,
      preferences: {
        active_filters: [{ type: "team", value: "platform" }],
        custom_views: [],
      },
    });

    expect(state.inserted).toMatchObject({
      orgId,
      userId: actor.id,
      activeFilters: [{ type: "team", value: "platform" }],
      customViews: [],
    });
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it("rejects non-members", async () => {
    const { database } = fakeDb({ member: false });

    await expect(
      setSkillFilterPreferences({
        actor,
        orgId: "00000000-0000-0000-0000-000000000001",
        database,
        preferences: { active_filters: [], custom_views: [] },
      }),
    ).rejects.toThrow("not a member of this organization");
  });
});
