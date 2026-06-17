import { describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";
import { apiTokenRowSchema, TEAM_BRAND_COLORS } from "@companion/contracts";
import {
  API_TOKEN_TTL_MS,
  addOrgAccessDomain,
  deleteTeam,
  issueApiToken,
  listApiTokens,
  removeOrgAccessDomain,
  updateOrg,
  updateTeam,
  updateUserProfile,
  type ActorContext,
} from "../src/services";

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";
const TEAM_1 = "00000000-0000-0000-0000-0000000000t1";
const TEAM_2 = "00000000-0000-0000-0000-0000000000t2";

const owner: ActorContext = { id: "user-owner", email: "owner@a.dev", name: "Olivia Owner" };
const admin: ActorContext = { id: "user-admin", email: "admin@a.dev", name: "Adam Admin" };
const developer: ActorContext = { id: "user-dev", email: "dev@a.dev", name: "Devon Dev" };
const stranger: ActorContext = { id: "user-stranger", email: "stranger@b.dev", name: "Sam Stranger" };

/**
 * Recursively scan a captured drizzle where-expression for a primitive value. drizzle wraps bound
 * values deep inside opaque `Param`/`SQL` chunk objects, so we walk every nested value rather than
 * relying on a public shape. Lets us assert that a query was (or was not) narrowed by `actor.id`.
 */
function whereMentions(expr: unknown, value: string): boolean {
  const seen = new Set<unknown>();
  const walk = (node: unknown): boolean => {
    if (node === value) return true;
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node)) return false;
    seen.add(node);
    return Object.values(node as Record<string, unknown>).some(walk);
  };
  return walk(expr);
}

/** True when a captured drizzle where-expression references a column with the given snake_case name. */
function whereTouchesColumn(expr: unknown, columnName: string): boolean {
  const seen = new Set<unknown>();
  const walk = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return false;
    if (seen.has(node)) return false;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (record.name === columnName && "columnType" in record) return true;
    return Object.values(record).some(walk);
  };
  return walk(expr);
}

interface FakeDbOptions {
  /** orgRole returned by `getOrgRole` for the (orgId, userId) lookup; `null` => non-member. */
  role?: "owner" | "admin" | "developer" | null;
  /** Result of the first `query.organizations.findFirst` (the org row under update). */
  org?: Record<string, unknown> | null;
  /** Result of the second `query.organizations.findFirst` (slug-conflict probe). */
  orgConflict?: Record<string, unknown> | null;
  /** Result of `query.teams.findFirst` (team slug-conflict / team lookup). */
  team?: Record<string, unknown> | null;
  /** Result of `query.teams.findFirst` used as a slug conflict (overrides `team` for the 2nd call). */
  teamConflict?: Record<string, unknown> | null;
  /** Result of `query.teamMemberships.findFirst` (the actor's team role; `null` => not on the team). */
  teamMembership?: Record<string, unknown> | null;
  /** Number of teams in the org (deleteTeam last-team guard). */
  teamCount?: number;
  /** Rows returned for the `apiTokens` select (listApiTokens). */
  tokenRows?: Array<Record<string, unknown>>;
  /** Rows returned by an `insert(...).returning(...)`. */
  insertReturning?: Array<Record<string, unknown>>;
  /** Whether the actor's email is verified for domain-access mutations. */
  emailVerified?: boolean;
  /** Rows returned by an `update(...).returning(...)`. */
  updateReturning?: Array<Record<string, unknown>>;
  /** Skill share rows affected by deleteTeam. */
  teamSkillShares?: Array<{ skillId: string }>;
  /** Team-owned skill rows affected by deleteTeam's owner_team_id SET NULL. */
  teamOwnedSkills?: Array<{ skillId: string }>;
}

function fakeDb(options: FakeDbOptions = {}) {
  const calls = {
    /** every `update(table)` call, in order, with the eventual `.set` patch and `.where` expr. */
    updates: [] as Array<{ table: unknown; patch?: Record<string, unknown>; where?: unknown }>,
    /** every `delete(table)` call. */
    deletes: [] as Array<{ table: unknown; where?: unknown }>,
    /** ordered "update"/"delete" markers emitted inside `transaction(...)` (deleteTeam ordering). */
    txSequence: [] as string[],
    /** the most recent `.set` patch applied inside `transaction(...)`. */
    txPatch: undefined as Record<string, unknown> | undefined,
    /** the `.where` expr captured from the most recent token select. */
    tokenWhere: undefined as unknown,
    /** every `insert(table).values(...)` call, in order. */
    inserts: [] as Array<{ table: unknown; values?: Record<string, unknown> }>,
  };
  // `query.teams.findFirst` may be called twice (slug-conflict probe then guard lookup). We pop
  // through configured results: first `teamConflict` (if set) else `team`, then `team`.
  const teamFindResults: Array<Record<string, unknown> | null | undefined> = [];
  if (options.teamConflict !== undefined) teamFindResults.push(options.teamConflict);
  teamFindResults.push(options.team ?? null);

  const orgFindResults: Array<Record<string, unknown> | null | undefined> = [
    options.org === undefined
      ? { id: ORG_A, name: "Acme", slug: "acme", kind: "team", domain: null, domainAutoJoin: false }
      : options.org,
  ];
  if (options.orgConflict !== undefined) orgFindResults.push(options.orgConflict);

  const defaultOrgUpdateRow = {
    id: ORG_A,
    name: "Acme",
    slug: "acme",
    domain: null as string | null,
    domainAutoJoin: false,
    color: null as string | null,
    logoUrl: null as string | null,
  };

  const updateBuilder = (table: unknown) => {
    const record: { table: unknown; patch?: Record<string, unknown>; where?: unknown } = { table };
    calls.updates.push(record);
    const api = {
      set(patch: Record<string, unknown>) {
        record.patch = patch;
        return api;
      },
      where(expr: unknown) {
        record.where = expr;
        return api;
      },
      returning() {
        return Promise.resolve(
          options.updateReturning ?? [{ ...defaultOrgUpdateRow }],
        );
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(undefined).then(resolve);
      },
    };
    return api;
  };

  const deleteBuilder = (table: unknown) => {
    const record: { table: unknown; where?: unknown } = { table };
    calls.deletes.push(record);
    return {
      where(expr: unknown) {
        record.where = expr;
        return Promise.resolve(undefined);
      },
    };
  };

  let skillSelectCalls = 0;
  const selectBuilder = (cols: Record<string, unknown>) => {
    const isCount = "value" in cols;
    const isSkillShareSelect = "skillId" in cols;
    const skillRows = () => {
      skillSelectCalls += 1;
      return skillSelectCalls === 1 ? (options.teamSkillShares ?? []) : (options.teamOwnedSkills ?? []);
    };
    const builder: Record<string, unknown> = {
      from() {
        return builder;
      },
      innerJoin() {
        return builder;
      },
      where(expr: unknown) {
        if (!isCount && !isSkillShareSelect) calls.tokenWhere = expr;
        return builder;
      },
      orderBy() {
        if (isCount) return Promise.resolve([{ value: options.teamCount ?? 1 }]);
        if (isSkillShareSelect) return Promise.resolve(skillRows());
        return Promise.resolve(options.tokenRows ?? []);
      },
      then(resolve: (v: unknown) => unknown) {
        const rows = isCount
          ? [{ value: options.teamCount ?? 1 }]
          : isSkillShareSelect
            ? skillRows()
            : (options.tokenRows ?? []);
        return Promise.resolve(rows).then(resolve);
      },
    };
    return builder;
  };

  const insertBuilder = (table: unknown) => {
    const record: { table: unknown; values?: Record<string, unknown> } = { table };
    calls.inserts.push(record);
    const api = {
      values(values: Record<string, unknown>) {
        record.values = values;
        return api;
      },
      onConflictDoNothing: vi.fn(() => api),
      returning() {
        return Promise.resolve(options.insertReturning ?? [{ id: "token-id" }]);
      },
    };
    return api;
  };

  // The transaction handle records an ordered marker sequence so the deleteTeam tests can assert
  // skill visibility metadata is touched before the team row deletion when shares are affected.
  const txUpdate = vi.fn(() => {
    calls.txSequence.push("update");
    const api = {
      set(patch: Record<string, unknown>) {
        calls.txPatch = patch;
        return api;
      },
      where() {
        return api;
      },
      returning() {
        return Promise.resolve(options.updateReturning ?? [{ ...defaultOrgUpdateRow }]);
      },
    };
    return api;
  });
  const txDelete = vi.fn(() => {
    calls.txSequence.push("delete");
    return { where: () => Promise.resolve(undefined) };
  });
  // deleteTeam now takes an advisory lock and counts teams INSIDE the transaction, so the tx
  // handle must also answer execute()/select() (the count reuses the same select builder).
  const txHandle = { update: txUpdate, delete: txDelete, select: vi.fn(selectBuilder), execute: vi.fn(async () => undefined) };

  const database = {
    query: {
      memberships: {
        findFirst: vi.fn(async () => (options.role === undefined || options.role === null ? null : { orgRole: options.role })),
      },
      organizations: {
        findFirst: vi.fn(async () => (orgFindResults.length ? orgFindResults.shift() ?? null : null)),
      },
      user: {
        findFirst: vi.fn(async () => ({ emailVerified: options.emailVerified ?? true })),
      },
      teams: {
        findFirst: vi.fn(async () => (teamFindResults.length ? teamFindResults.shift() ?? null : options.team ?? null)),
      },
      teamMemberships: {
        findFirst: vi.fn(async () => options.teamMembership ?? null),
      },
    },
    insert: vi.fn(insertBuilder),
    update: vi.fn(updateBuilder),
    delete: vi.fn(deleteBuilder),
    select: vi.fn(selectBuilder),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txHandle)),
  };

  return { database: database as unknown as Db, calls, txHandle };
}

/* ---- updateOrg ------------------------------------------------------------- */

describe("updateOrg", () => {
  const roleCases: Array<["owner" | "admin" | "developer" | null, boolean]> = [
    ["owner", true],
    ["admin", true],
    ["developer", false],
    [null, false], // non-member
  ];
  it.each(roleCases)("role=%s -> allowed=%s", async (role, allowed) => {
    const { database } = fakeDb({
      role,
      updateReturning: [{ id: ORG_A, name: "Acme", slug: "acme", domain: null, domainAutoJoin: false }],
    });
    const run = updateOrg({ actor: role === null ? stranger : owner, orgId: ORG_A, name: "Acme", database });
    if (allowed) {
      await expect(run).resolves.toMatchObject({ id: ORG_A, name: "Acme", slug: "acme" });
    } else {
      await expect(run).rejects.toThrow("not allowed to update this organization");
    }
  });

  it("normalizes the slug before writing", async () => {
    const { database, calls } = fakeDb({
      role: "admin",
      orgConflict: null,
      updateReturning: [{ id: ORG_A, name: "Acme", slug: "new-acme" }],
    });
    await updateOrg({ actor: admin, orgId: ORG_A, slug: "New Acme!!", database });
    const orgUpdate = calls.updates.at(-1);
    expect(orgUpdate?.patch).toMatchObject({ slug: "new-acme" });
  });

  it("rejects a duplicate slug", async () => {
    const { database } = fakeDb({ role: "admin", orgConflict: { id: ORG_B } });
    await expect(updateOrg({ actor: admin, orgId: ORG_A, slug: "taken", database })).rejects.toThrow(
      "that workspace URL is already taken",
    );
  });

  it("rejects an empty patch with nothing to update", async () => {
    const { database } = fakeDb({ role: "owner" });
    await expect(updateOrg({ actor: owner, orgId: ORG_A, database })).rejects.toThrow("nothing to update");
  });

  it("denies a member of another org (cross-tenant)", async () => {
    // getOrgRole resolves to null because the stranger has no membership row in ORG_A.
    const { database } = fakeDb({ role: null });
    await expect(updateOrg({ actor: stranger, orgId: ORG_A, name: "Acme", database })).rejects.toThrow(
      "not allowed to update this organization",
    );
  });

  it("sets branding when no logo is configured yet", async () => {
    const color = TEAM_BRAND_COLORS[0]!;
    const logoUrl = "https://icon.horse/icon/acme.com";
    const { database, calls } = fakeDb({
      role: "admin",
      org: { id: ORG_A, name: "Acme", slug: "acme", kind: "team", domain: null, domainAutoJoin: false, logoUrl: null },
      updateReturning: [{ id: ORG_A, name: "Acme", slug: "acme", domain: null, domainAutoJoin: false, color, logoUrl }],
    });
    await expect(
      updateOrg({ actor: admin, orgId: ORG_A, color, logoUrl, database }),
    ).resolves.toMatchObject({ color, logoUrl });
    expect(calls.updates.at(-1)?.patch).toMatchObject({ color, logoUrl });
  });

  it("replaces branding when a logo is already configured", async () => {
    const logoUrl = "https://icon.horse/icon/other.com";
    const { database, calls } = fakeDb({
      role: "admin",
      org: {
        id: ORG_A,
        name: "Acme",
        slug: "acme",
        kind: "team",
        domain: null,
        domainAutoJoin: false,
        logoUrl: "https://icon.horse/icon/acme.com",
      },
      updateReturning: [{ id: ORG_A, name: "Acme", slug: "acme", domain: null, domainAutoJoin: false, color: null, logoUrl }],
    });
    await expect(updateOrg({ actor: admin, orgId: ORG_A, logoUrl, database })).resolves.toMatchObject({ logoUrl });
    expect(calls.updates.at(-1)?.patch).toMatchObject({ logoUrl });
  });

  it("clears the logo when logoUrl is null", async () => {
    const { database, calls } = fakeDb({
      role: "admin",
      org: {
        id: ORG_A,
        name: "Acme",
        slug: "acme",
        kind: "team",
        domain: null,
        domainAutoJoin: false,
        logoUrl: "https://icon.horse/icon/acme.com",
      },
      updateReturning: [{ id: ORG_A, name: "Acme", slug: "acme", domain: null, domainAutoJoin: false, color: null, logoUrl: null }],
    });
    await expect(updateOrg({ actor: admin, orgId: ORG_A, logoUrl: null, database })).resolves.toMatchObject({ logoUrl: null });
    expect(calls.updates.at(-1)?.patch).toMatchObject({ logoUrl: null });
  });
});

/* ---- organization domains ------------------------------------------------ */

describe("organization access domains", () => {
  it("allows org admins to add a normalized access domain", async () => {
    const { database, calls } = fakeDb({
      role: "admin",
      org: { id: ORG_A, name: "Acme", slug: "acme", kind: "team", domain: null, domainAutoJoin: false },
      insertReturning: [{ id: "domain-1", domain: "a.dev", createdAt: new Date("2026-06-16T12:00:00.000Z") }],
    });

    await expect(addOrgAccessDomain({ actor: admin, orgId: ORG_A, domain: "@a.dev", database })).resolves.toEqual({
      id: "domain-1",
      domain: "a.dev",
      createdAt: "2026-06-16T12:00:00.000Z",
    });
    expect(calls.inserts.at(-1)?.values).toMatchObject({ orgId: ORG_A, domain: "a.dev", createdBy: admin.id });
  });

  it("rejects domains that do not match the admin's verified email domain", async () => {
    const { database } = fakeDb({
      role: "admin",
      org: { id: ORG_A, name: "Acme", slug: "acme", kind: "team", domain: null, domainAutoJoin: false },
    });

    await expect(addOrgAccessDomain({ actor: admin, orgId: ORG_A, domain: "client.dev", database })).rejects.toThrow(
      "you can only add your verified corporate email domain",
    );
  });

  it("requires a verified email before adding an access domain", async () => {
    const { database } = fakeDb({
      role: "admin",
      emailVerified: false,
      org: { id: ORG_A, name: "Acme", slug: "acme", kind: "team", domain: null, domainAutoJoin: false },
    });

    await expect(addOrgAccessDomain({ actor: admin, orgId: ORG_A, domain: "a.dev", database })).rejects.toThrow(
      "verify your email to add this domain",
    );
  });

  it("rejects invalid email-domain values", async () => {
    const { database } = fakeDb({
      role: "admin",
      org: { id: ORG_A, name: "Acme", slug: "acme", kind: "team", domain: null, domainAutoJoin: false },
    });

    await expect(addOrgAccessDomain({ actor: admin, orgId: ORG_A, domain: "a.dev:3000", database })).rejects.toThrow(
      "enter a valid email domain",
    );
  });

  it("denies developers when adding or removing access domains", async () => {
    const { database } = fakeDb({ role: "developer" });

    await expect(addOrgAccessDomain({ actor: developer, orgId: ORG_A, domain: "client.dev", database })).rejects.toThrow(
      "not allowed to manage workspace domains",
    );
    await expect(removeOrgAccessDomain({ actor: developer, orgId: ORG_A, domainId: "domain-1", database })).rejects.toThrow(
      "not allowed to manage workspace domains",
    );
  });

  it("allows org admins to remove an access domain scoped to their org", async () => {
    const { database, calls } = fakeDb({ role: "owner" });

    await expect(removeOrgAccessDomain({ actor: owner, orgId: ORG_A, domainId: "domain-1", database })).resolves.toBeUndefined();
    expect(calls.deletes).toHaveLength(1);
  });
});

/* ---- updateTeam ------------------------------------------------------------ */

describe("updateTeam", () => {
  it("allows an org admin (not on the team)", async () => {
    const { database } = fakeDb({
      role: "admin",
      team: { id: TEAM_1, orgId: ORG_A },
      updateReturning: [{ id: TEAM_1, name: "Platform", slug: "platform", description: null }],
    });
    await expect(updateTeam({ actor: admin, orgId: ORG_A, teamId: TEAM_1, name: "Platform", database })).resolves.toEqual(
      { id: TEAM_1, name: "Platform", slug: "platform", description: null },
    );
  });

  it("allows a team admin who is not an org admin", async () => {
    // org role "developer" + team role "admin" => assertCanManageTeam passes.
    const { database } = fakeDb({
      role: "developer",
      team: { id: TEAM_1, orgId: ORG_A },
      teamMembership: { teamRole: "admin" },
      updateReturning: [{ id: TEAM_1, name: "Platform", slug: "platform", description: null }],
    });
    await expect(
      updateTeam({ actor: developer, orgId: ORG_A, teamId: TEAM_1, name: "Platform", database }),
    ).resolves.toMatchObject({ id: TEAM_1 });
  });

  it("denies a developer who is not a team admin", async () => {
    const { database } = fakeDb({
      role: "developer",
      team: { id: TEAM_1, orgId: ORG_A },
      teamMembership: { teamRole: "editor" },
    });
    await expect(
      updateTeam({ actor: developer, orgId: ORG_A, teamId: TEAM_1, name: "Platform", database }),
    ).rejects.toThrow("not allowed to manage team members");
  });

  it("rejects a per-org duplicate slug", async () => {
    const { database } = fakeDb({
      role: "admin",
      team: { id: TEAM_1, orgId: ORG_A },
      teamConflict: { id: TEAM_2 },
    });
    await expect(
      updateTeam({ actor: admin, orgId: ORG_A, teamId: TEAM_1, slug: "taken", database }),
    ).rejects.toThrow("that team URL is already taken");
  });

  it("collapses an empty description to null", async () => {
    const { database, calls } = fakeDb({
      role: "admin",
      team: { id: TEAM_1, orgId: ORG_A },
      updateReturning: [{ id: TEAM_1, name: "Platform", slug: "platform", description: null }],
    });
    await updateTeam({ actor: admin, orgId: ORG_A, teamId: TEAM_1, description: "   ", database });
    const teamUpdate = calls.updates.at(-1);
    expect(teamUpdate?.patch).toMatchObject({ description: null });
  });

  it("rejects an invalid team color", async () => {
    const { database } = fakeDb({
      role: "admin",
      team: { id: TEAM_1, orgId: ORG_A },
    });
    await expect(
      updateTeam({ actor: admin, orgId: ORG_A, teamId: TEAM_1, color: "url(https://evil.test/x.png)", database }),
    ).rejects.toThrow("invalid team color");
  });

  it("accepts a palette team color", async () => {
    const color = TEAM_BRAND_COLORS[0]!;
    const { database } = fakeDb({
      role: "admin",
      team: { id: TEAM_1, orgId: ORG_A },
      updateReturning: [{ id: TEAM_1, name: "Platform", slug: "platform", description: null, color, icon: null }],
    });
    await expect(updateTeam({ actor: admin, orgId: ORG_A, teamId: TEAM_1, color, database })).resolves.toMatchObject({
      color,
    });
  });

  it("throws when the team is not found", async () => {
    const { database } = fakeDb({ role: "admin", team: null });
    await expect(
      updateTeam({ actor: admin, orgId: ORG_A, teamId: TEAM_1, name: "Platform", database }),
    ).rejects.toThrow("team not found");
  });
});

/* ---- deleteTeam ------------------------------------------------------------ */

describe("deleteTeam", () => {
  it("allows an org admin", async () => {
    const { database, txHandle } = fakeDb({ role: "admin", team: { id: TEAM_1, orgId: ORG_A }, teamCount: 2 });
    await expect(deleteTeam({ actor: admin, orgId: ORG_A, teamId: TEAM_1, database })).resolves.toBeUndefined();
    expect(txHandle.update).not.toHaveBeenCalled();
    expect(txHandle.delete).toHaveBeenCalled();
  });

  it("denies a developer", async () => {
    const { database } = fakeDb({ role: "developer", team: { id: TEAM_1, orgId: ORG_A }, teamCount: 2 });
    await expect(deleteTeam({ actor: developer, orgId: ORG_A, teamId: TEAM_1, database })).rejects.toThrow(
      "not allowed to delete teams",
    );
  });

  it("denies a member of another org (cross-tenant)", async () => {
    const { database } = fakeDb({ role: null, team: { id: TEAM_1, orgId: ORG_A }, teamCount: 2 });
    await expect(deleteTeam({ actor: stranger, orgId: ORG_A, teamId: TEAM_1, database })).rejects.toThrow(
      "not allowed to delete teams",
    );
  });

  it("rejects deleting the last team (<= 1 team guard)", async () => {
    const { database, txHandle } = fakeDb({ role: "admin", team: { id: TEAM_1, orgId: ORG_A }, teamCount: 1 });
    await expect(deleteTeam({ actor: admin, orgId: ORG_A, teamId: TEAM_1, database })).rejects.toThrow(
      "organization must keep at least one team",
    );
    expect(txHandle.delete).not.toHaveBeenCalled();
  });

  it("deletes the team without touching skills when it has no skill shares", async () => {
    const { database, calls } = fakeDb({ role: "owner", team: { id: TEAM_1, orgId: ORG_A }, teamCount: 3 });

    await deleteTeam({ actor: owner, orgId: ORG_A, teamId: TEAM_1, database });

    expect(calls.txSequence).toEqual(["delete"]);
    expect(calls.txPatch).toBeUndefined();
  });

  it("touches affected skills before deleting a team whose shares cascade", async () => {
    const { database, calls } = fakeDb({
      role: "owner",
      team: { id: TEAM_1, orgId: ORG_A },
      teamCount: 3,
      teamSkillShares: [{ skillId: "skill-1" }],
    });

    await deleteTeam({ actor: owner, orgId: ORG_A, teamId: TEAM_1, database });

    expect(calls.txSequence).toEqual(["update", "delete"]);
    expect(calls.txPatch?.updatedAt).toBeInstanceOf(Date);
  });

  it("touches affected skills before deleting their owner team", async () => {
    const { database, calls } = fakeDb({
      role: "owner",
      team: { id: TEAM_1, orgId: ORG_A },
      teamCount: 3,
      teamOwnedSkills: [{ skillId: "skill-owned-by-team" }],
    });

    await deleteTeam({ actor: owner, orgId: ORG_A, teamId: TEAM_1, database });

    expect(calls.txSequence).toEqual(["update", "update", "delete"]);
    expect(calls.txPatch?.updatedAt).toBeInstanceOf(Date);
    expect(calls.txPatch?.ownerTeamId).toBeNull();
  });

  it("throws when the team is not found", async () => {
    const { database } = fakeDb({ role: "admin", team: null, teamCount: 2 });
    await expect(deleteTeam({ actor: admin, orgId: ORG_A, teamId: TEAM_1, database })).rejects.toThrow(
      "team not found",
    );
  });
});

/* ---- issueApiToken --------------------------------------------------------- */

describe("issueApiToken", () => {
  function tokenInsertValues(calls: ReturnType<typeof fakeDb>["calls"]): Record<string, unknown> {
    const insert = calls.inserts.find((entry) => entry.values && "tokenHash" in entry.values);
    if (!insert?.values) throw new Error("api token insert not captured");
    return insert.values;
  }

  it("defaults issued tokens to at least 90 days", async () => {
    const { database, calls } = fakeDb({ role: "developer" });
    const before = Date.now();

    const issued = await issueApiToken({
      actor: developer,
      orgId: ORG_A,
      scopes: ["skills:read", "skills:write"],
      database,
    });

    const values = tokenInsertValues(calls);
    expect(values).toMatchObject({ orgId: ORG_A, userId: developer.id, scopes: ["skills:read", "skills:write"] });
    expect(values.tokenHash).toEqual(expect.any(String));
    expect(values.tokenHash).not.toBe(issued.token);
    expect(values.expiresAt).toBeInstanceOf(Date);
    expect((values.expiresAt as Date).getTime()).toBeGreaterThanOrEqual(before + API_TOKEN_TTL_MS);
    expect(issued.expiresAt).toBe(values.expiresAt);
  });

  it("honors an explicit ttlMs override", async () => {
    const { database, calls } = fakeDb({ role: "developer" });
    const ttlMs = 1000 * 60 * 5;
    const before = Date.now();

    await issueApiToken({
      actor: developer,
      orgId: ORG_A,
      scopes: ["skills:read"],
      ttlMs,
      database,
    });

    const expiresAt = tokenInsertValues(calls).expiresAt as Date;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttlMs);
    expect(expiresAt.getTime()).toBeLessThan(before + API_TOKEN_TTL_MS);
  });
});

/* ---- listApiTokens --------------------------------------------------------- */

describe("listApiTokens", () => {
  const tokenRow = {
    id: "tok-1",
    orgId: ORG_A,
    userId: developer.id,
    name: "ci token",
    tokenPrefix: "cmp_pat_abc123",
    scopes: ["skills:read"],
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    // a tokenHash would be a leak; intentionally present on the mock row to prove it is dropped.
    tokenHash: "SECRET-HASH-NEVER-RETURN",
  };

  it("denies a non-member", async () => {
    const { database } = fakeDb({ role: null });
    await expect(listApiTokens({ actor: stranger, orgId: ORG_A, database })).rejects.toThrow(
      "not a member of this organization",
    );
  });

  it("scopes a developer to their own tokens (where includes userId)", async () => {
    const { database, calls } = fakeDb({ role: "developer", tokenRows: [tokenRow] });
    await listApiTokens({ actor: developer, orgId: ORG_A, database });
    expect(whereMentions(calls.tokenWhere, developer.id)).toBe(true);
    expect(whereMentions(calls.tokenWhere, ORG_A)).toBe(true);
    // Revoked tokens are a soft delete; the list must filter them out (revoked_at IS NULL).
    expect(whereTouchesColumn(calls.tokenWhere, "revoked_at")).toBe(true);
  });

  it("scopes an org admin to their OWN tokens too (personal pane, not an org-wide view)", async () => {
    const { database, calls } = fakeDb({ role: "admin", tokenRows: [tokenRow] });
    await listApiTokens({ actor: admin, orgId: ORG_A, database });
    // The personal "Account › API keys" pane must never surface other members' keys, even to an admin.
    expect(whereMentions(calls.tokenWhere, admin.id)).toBe(true);
    expect(whereMentions(calls.tokenWhere, ORG_A)).toBe(true);
    expect(whereTouchesColumn(calls.tokenWhere, "revoked_at")).toBe(true);
  });

  it("maps rows to apiTokenRowSchema and never returns tokenHash", async () => {
    const { database } = fakeDb({ role: "admin", tokenRows: [tokenRow] });
    const rows = await listApiTokens({ actor: admin, orgId: ORG_A, database });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(rows)).not.toContain("SECRET-HASH-NEVER-RETURN");
    // The mapped shape must satisfy the shared contract.
    expect(() => apiTokenRowSchema.parse(row)).not.toThrow();
    expect(row).toMatchObject({ id: "tok-1", org_id: ORG_A, user_id: developer.id, prefix: "cmp_pat_abc123" });
  });
});

/* ---- updateUserProfile ----------------------------------------------------- */

describe("updateUserProfile", () => {
  it("trims the name and recomputes initials", async () => {
    const { database, calls } = fakeDb();
    await expect(
      updateUserProfile({ actor: developer, name: "  Devon  Dev  ", database }),
    ).resolves.toEqual({ id: developer.id, name: "Devon  Dev", initials: "DD" });
    const profileUpdate = calls.updates.at(-1);
    expect(profileUpdate?.patch).toMatchObject({ name: "Devon  Dev", initials: "DD" });
  });

  it("rejects an empty name", async () => {
    const { database } = fakeDb();
    await expect(updateUserProfile({ actor: developer, name: "   ", database })).rejects.toThrow("name is required");
  });
});
