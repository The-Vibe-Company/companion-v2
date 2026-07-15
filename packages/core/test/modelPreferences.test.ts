import { describe, expect, it } from "vitest";
import {
  getActivatedModelSets,
  getActivatedModels,
  setOrgActivatedModels,
  setUserActivatedModels,
  type ActorContext,
} from "../src/services";
import { emptyStore, fakeRunsDb } from "./runsFakeDb";

const ORG = "00000000-0000-0000-0000-0000000000dd";
const me: ActorContext = { id: "user-me", email: "me@example.com", name: "Me" };

describe("activated models", () => {
  it("defaults to empty lists for a member with no saved preferences", async () => {
    const store = emptyStore();
    const database = fakeRunsDb(store);
    const activated = await getActivatedModels({ actor: me, orgId: ORG, database });
    expect(activated).toEqual({ personal: [], org: [] });
  });

  it("round-trips the personal list and replaces it wholesale on re-save (deduped + sorted)", async () => {
    const store = emptyStore();
    const database = fakeRunsDb(store);
    const first = await setUserActivatedModels({
      actor: me,
      orgId: ORG,
      models: ["openai/gpt-5.2", "anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"],
      database,
    });
    expect(first.personal).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5.2"]);
    const second = await setUserActivatedModels({ actor: me, orgId: ORG, models: ["openai/gpt-5.2"], database });
    expect(second.personal).toEqual(["openai/gpt-5.2"]);
    expect(store.userModelPreferences).toHaveLength(1);
  });

  it("denies non-members outright", async () => {
    const store = emptyStore({ role: null });
    const database = fakeRunsDb(store);
    await expect(getActivatedModels({ actor: me, orgId: ORG, database })).rejects.toThrow();
    await expect(setUserActivatedModels({ actor: me, orgId: ORG, models: [], database })).rejects.toThrow();
    await expect(setOrgActivatedModels({ actor: me, orgId: ORG, models: [], database })).rejects.toThrow();
  });

  it("blocks developers from the workspace list but lets owners/admins write it (+ audit)", async () => {
    const developerStore = emptyStore({ role: "developer" });
    await expect(
      setOrgActivatedModels({ actor: me, orgId: ORG, models: ["openai/gpt-5.2"], database: fakeRunsDb(developerStore) }),
    ).rejects.toThrow(/owners and admins/);
    expect(developerStore.orgModelPreferences).toHaveLength(0);

    const adminStore = emptyStore({ role: "admin" });
    const database = fakeRunsDb(adminStore);
    const activated = await setOrgActivatedModels({ actor: me, orgId: ORG, models: ["openai/gpt-5.2"], database });
    expect(activated.org).toEqual(["openai/gpt-5.2"]);
    expect(adminStore.audit.some((a) => a.action === "models.activate.org")).toBe(true);
  });

  it("returns both scopes so the effective set is personal ∪ org", async () => {
    const store = emptyStore({ role: "owner" });
    const database = fakeRunsDb(store);
    await setUserActivatedModels({ actor: me, orgId: ORG, models: ["anthropic/claude-sonnet-4-5"], database });
    await setOrgActivatedModels({ actor: me, orgId: ORG, models: ["openai/gpt-5.2"], database });
    const sets = await getActivatedModelSets({ database, orgId: ORG, userId: me.id });
    expect(sets).toEqual({ personal: ["anthropic/claude-sonnet-4-5"], org: ["openai/gpt-5.2"] });
  });

  it("never reads another member's personal list", async () => {
    const store = emptyStore();
    const database = fakeRunsDb(store);
    store.userModelPreferences.push({
      orgId: ORG,
      userId: "user-other",
      activatedModels: ["openai/gpt-5.2"],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const sets = await getActivatedModelSets({ database, orgId: ORG, userId: me.id });
    expect(sets.personal).toEqual([]);
  });
});
