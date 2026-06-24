import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import { shareSkill, type ActorContext } from "../src/services";

/**
 * Behavioral fakeDb for `shareSkill`. The Share action resolves the skill directly (findFirst), gates
 * on owner-only `canManagePersonalSkill`, then in one transaction flips `scope` personal → org, drops
 * the skill's personal-folder assignments, and writes an audit row. The fake captures each so we assert
 * the real transition + the owner gate (a non-owner / org-skill / non-member can never share).
 */
const ORG = "00000000-0000-0000-0000-0000000000aa";
const owner: ActorContext = { id: "user-owner", email: "o@example.com", name: "Owner" };
const other: ActorContext = { id: "user-other", email: "x@example.com", name: "Other" };

interface SkillRow {
  id: string;
  orgId: string;
  slug: string;
  scope: "personal" | "org";
  creatorId: string;
}

function fakeDb(opts: { role?: "owner" | "admin" | "developer" | null; skill?: SkillRow | null }) {
  const role = opts.role === undefined ? "developer" : opts.role;
  const skill = opts.skill === undefined ? null : opts.skill;
  const captured = {
    scopeSet: null as string | null,
    personalLabelsCleared: false,
    audit: null as Record<string, unknown> | null,
  };

  const txHandle = {
    update: (table: unknown) => ({
      set(patch: Record<string, unknown>) {
        if (table === schema.skills && "scope" in patch) captured.scopeSet = patch.scope as string;
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    delete: (table: unknown) => ({
      where() {
        if (table === schema.personalSkillLabels) captured.personalLabelsCleared = true;
        return Promise.resolve(undefined);
      },
    }),
    insert: (table: unknown) => ({
      values(v: Record<string, unknown>) {
        if (table === schema.auditLog) captured.audit = v;
        return Promise.resolve(undefined);
      },
    }),
  };

  const database = {
    query: {
      memberships: { findFirst: async () => (role === null ? null : { orgRole: role }) },
      skills: { findFirst: async () => skill ?? undefined },
    },
    transaction: async (cb: (tx: typeof txHandle) => unknown) => cb(txHandle),
  };

  return { database: database as unknown as Db, captured };
}

const personalSkill: SkillRow = { id: "skill-1", orgId: ORG, slug: "pdf-extractor", scope: "personal", creatorId: owner.id };

describe("shareSkill — move a personal skill into the org library", () => {
  it("flips scope personal → org, clears personal folders, and audits (owner)", async () => {
    const { database, captured } = fakeDb({ skill: personalSkill });
    const result = await shareSkill({ actor: owner, orgId: ORG, slug: "pdf-extractor", database });
    expect(result).toEqual({ scope: "org" });
    expect(captured.scopeSet).toBe("org");
    expect(captured.personalLabelsCleared).toBe(true);
    expect(captured.audit).toMatchObject({ action: "skill.share", targetId: "skill-1" });
  });

  it("denies a member who is not the owner (admins included — no override)", async () => {
    const { database, captured } = fakeDb({ role: "admin", skill: personalSkill });
    await expect(shareSkill({ actor: other, orgId: ORG, slug: "pdf-extractor", database })).rejects.toThrow(
      "only the owner can share a personal skill",
    );
    expect(captured.scopeSet).toBeNull(); // nothing mutated
  });

  it("rejects sharing an org skill (it is already shared)", async () => {
    const orgSkill: SkillRow = { ...personalSkill, scope: "org" };
    const { database } = fakeDb({ skill: orgSkill });
    await expect(shareSkill({ actor: owner, orgId: ORG, slug: "pdf-extractor", database })).rejects.toThrow(
      "only the owner can share a personal skill",
    );
  });

  it("throws when the skill does not exist", async () => {
    const { database } = fakeDb({ skill: null });
    await expect(shareSkill({ actor: owner, orgId: ORG, slug: "ghost", database })).rejects.toThrow("skill not found");
  });

  it("denies a non-member", async () => {
    const { database } = fakeDb({ role: null, skill: personalSkill });
    await expect(shareSkill({ actor: owner, orgId: ORG, slug: "pdf-extractor", database })).rejects.toThrow(
      "not a member of this organization",
    );
  });
});
