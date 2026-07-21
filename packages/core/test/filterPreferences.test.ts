import { describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";
import { skillFilterPreferencesInputSchema, skillFilterPreferencesSchema } from "@companion/contracts";
import { getSkillFilterPreferences, setSkillFilterPreferences, type ActorContext } from "../src/services";

const actor: ActorContext = { id: "user-1", email: "user@example.com", name: "User One" };
const ORG = "00000000-0000-0000-0000-000000000001";

function fakeDb(options: {
  member?: boolean;
  existing?: { activeFilters: unknown[]; groupBy?: unknown; sidebarOrder?: unknown } | null;
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

describe("skill filter preferences (status / deps / label / nolabel)", () => {
  it("validates filters and the persisted list grouping mode", () => {
    const parsed = skillFilterPreferencesSchema.parse({
      active_filters: [
        { type: "status", value: "valid" },
        { type: "deps", value: "has" },
        { type: "label", value: "marketing/seo" },
        { type: "nolabel", value: "true" },
      ],
    });
    expect(parsed.active_filters).toContainEqual({ type: "label", value: "marketing/seo" });
    expect(parsed.group_by).toBe("folder");
    expect(parsed.sidebar_order).toEqual({ mine: [], org: [] });
    // The saved-view axis is gone entirely.
    expect("custom_views" in parsed).toBe(false);
    expect(skillFilterPreferencesSchema.parse({})).toEqual({
      active_filters: [],
      group_by: "folder",
      sidebar_order: { mine: [], org: [] },
    });
    expect(skillFilterPreferencesSchema.parse({ group_by: "none" }).group_by).toBe("none");
    expect(skillFilterPreferencesInputSchema.parse({ active_filters: [], group_by: "none" })).toEqual({
      active_filters: [],
      group_by: "none",
    });
    expect(() => skillFilterPreferencesSchema.parse({ group_by: "team" })).toThrow();

    // Removed owner-era filter types no longer parse.
    expect(() => skillFilterPreferencesSchema.parse({ active_filters: [{ type: "visibility", value: "team" }] })).toThrow();
    expect(() => skillFilterPreferencesSchema.parse({ active_filters: [{ type: "owner", value: "user-42" }] })).toThrow();
    expect(() => skillFilterPreferencesSchema.parse({ active_filters: [{ type: "team", value: "platform" }] })).toThrow();
    expect(() => skillFilterPreferencesSchema.parse({ active_filters: [{ type: "unknown", value: "x" }] })).toThrow();
    expect(() => skillFilterPreferencesSchema.parse({ active_filters: [{ type: "starred", value: "true" }] })).toThrow();
    expect(() => skillFilterPreferencesSchema.parse({ active_filters: [{ type: "label", value: "Bad Path" }] })).toThrow();
    expect(() => skillFilterPreferencesSchema.parse({ sidebar_order: { mine: ["Bad Path"], org: [] } })).toThrow();
  });

  it("returns defaults when the user has no saved row", async () => {
    const { database } = fakeDb();
    await expect(getSkillFilterPreferences({ actor, orgId: ORG, database })).resolves.toEqual({
      active_filters: [],
      group_by: "folder",
      sidebar_order: { mine: [], org: [] },
    });
  });

  it("parses an existing preference row", async () => {
    const { database } = fakeDb({
      existing: { activeFilters: [{ type: "label", value: "marketing" }] },
    });
    await expect(getSkillFilterPreferences({ actor, orgId: ORG, database })).resolves.toEqual({
      active_filters: [{ type: "label", value: "marketing" }],
      group_by: "folder",
      sidebar_order: { mine: [], org: [] },
    });
  });

  it("drops retired persisted filters while preserving every remaining preference", async () => {
    const { database } = fakeDb({
      existing: {
        activeFilters: [
          { type: "scope", value: "public" },
          { type: "visibility", value: "team" },
          { type: "owner", value: "user-42" },
          { type: "team", value: "platform" },
          { type: "status", value: "valid" },
          { type: "starred", value: "true" },
          { type: "deps", value: "has" },
        ],
      },
    });
    await expect(getSkillFilterPreferences({ actor, orgId: ORG, database })).resolves.toEqual({
      active_filters: [
        { type: "status", value: "valid" },
        { type: "deps", value: "has" },
      ],
      group_by: "folder",
      sidebar_order: { mine: [], org: [] },
    });
  });

  it("upserts preferences for the current org and actor (no custom_views column)", async () => {
    const { database, state, onConflictDoUpdate } = fakeDb();
    await setSkillFilterPreferences({
      actor,
      orgId: ORG,
      database,
      preferences: {
        active_filters: [{ type: "label", value: "growth" }],
        group_by: "none",
        sidebar_order: { mine: ["drafts"], org: ["growth", "marketing"] },
      },
    });
    expect(state.inserted).toMatchObject({
      orgId: ORG,
      userId: actor.id,
      activeFilters: [{ type: "label", value: "growth" }],
      groupBy: "none",
      sidebarOrder: { mine: ["drafts"], org: ["growth", "marketing"] },
    });
    expect(state.inserted && "customViews" in state.inserted).toBe(false);
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it("preserves an existing sidebar order for a legacy two-field write", async () => {
    const { database, state } = fakeDb();
    await setSkillFilterPreferences({
      actor,
      orgId: ORG,
      database,
      preferences: {
        active_filters: [{ type: "status", value: "valid" }],
        group_by: "none",
      },
    });
    expect(state.inserted?.sidebarOrder).toEqual({ mine: [], org: [] });
    expect(state.conflict?.set).not.toHaveProperty("sidebarOrder");
  });

  it("rejects non-members", async () => {
    const { database } = fakeDb({ member: false });
    await expect(
      getSkillFilterPreferences({ actor, orgId: ORG, database }),
    ).rejects.toThrow("not a member of this organization");
    await expect(
      setSkillFilterPreferences({
        actor,
        orgId: ORG,
        database,
        preferences: { active_filters: [], group_by: "folder", sidebar_order: { mine: [], org: [] } },
      }),
    ).rejects.toThrow("not a member of this organization");
  });
});
