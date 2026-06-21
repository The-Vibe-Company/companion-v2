import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import { emitSkillNotifications } from "../src/notifications";

/**
 * Verifies `emitSkillNotifications` turns resolved recipients into a single bulk insert with correctly
 * shaped rows, and inserts nothing when there are no recipients. The stub returns canned relationship
 * rows (keyed by table) and records every insert.
 */
const ORG = "00000000-0000-0000-0000-0000000000aa";
const SKILL = "00000000-0000-0000-0000-0000000000bb";

function fakeDb(data: { ownerId?: string | null; installers?: string[]; starrers?: string[] }) {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const allUsers = new Set<string>([
    ...(data.ownerId ? [data.ownerId] : []),
    ...(data.installers ?? []),
    ...(data.starrers ?? []),
  ]);
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.skills) return data.ownerId === null ? [] : [{ ownerId: data.ownerId ?? "u-owner" }];
    if (table === schema.skillInstalls) return (data.installers ?? []).map((userId) => ({ userId }));
    if (table === schema.skillStars) return (data.starrers ?? []).map((userId) => ({ userId }));
    // Every candidate is a current org member (membership filter is exercised in the resolver suite).
    if (table === schema.memberships) return [...allUsers].map((userId) => ({ userId }));
    return [];
  };
  const builder = () => {
    let rows: unknown[] = [];
    const b: Record<string, unknown> = {
      from(table: unknown) {
        rows = rowsFor(table);
        return b;
      },
      where: () => b,
      limit: () => b,
      then: (resolve: (value: unknown[]) => void) => resolve(rows),
    };
    return b;
  };
  const database = {
    select: () => builder(),
    selectDistinct: () => builder(),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        inserts.push({ table, values });
        return Promise.resolve();
      },
    }),
  } as unknown as Db;
  return { database, inserts };
}

describe("emitSkillNotifications", () => {
  it("bulk-inserts one notification row per recipient with the right shape", async () => {
    const { database, inserts } = fakeDb({ ownerId: "u-owner", installers: ["u-inst"], starrers: ["u-star"] });
    const recipients = await emitSkillNotifications({
      database,
      orgId: ORG,
      skillId: SKILL,
      actorId: "u-actor",
      type: "skill.version_published",
      targetType: "skill_version",
      targetId: "ver-1",
      metadata: { slug: "demo", version: "2.0.0" },
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe(schema.notifications);
    const rows = inserts[0]!.values as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    const byUser = Object.fromEntries(rows.map((r) => [r.recipientUserId, r]));
    expect(byUser["u-inst"]).toMatchObject({
      orgId: ORG,
      skillId: SKILL,
      actorId: "u-actor",
      type: "skill.version_published",
      reason: "installer",
      targetType: "skill_version",
      targetId: "ver-1",
      metadata: { slug: "demo", version: "2.0.0" },
    });
    expect(byUser["u-star"]!.reason).toBe("starrer");
    expect(byUser["u-owner"]!.reason).toBe("owner");
    expect(recipients).toHaveLength(3);
  });

  it("inserts nothing when the only candidate is the actor", async () => {
    const { database, inserts } = fakeDb({ ownerId: "u-actor", installers: ["u-actor"] });
    const recipients = await emitSkillNotifications({
      database,
      orgId: ORG,
      skillId: SKILL,
      actorId: "u-actor",
      type: "skill.version_published",
      targetType: "skill_version",
      targetId: "ver-1",
      metadata: { slug: "demo", version: "2.0.0" },
    });
    expect(inserts).toHaveLength(0);
    expect(recipients).toEqual([]);
  });
});
