import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@companion/db";
import { COMPANION_LAST_MESSAGE_PREVIEW_MAX_CHARACTERS } from "@companion/contracts";
import {
  companionLastMessagePreview,
  listCompanions,
  loadCompanionLastMessages,
} from "../src/companions";
import type { ActorContext } from "../src/services";

const ORG = "00000000-0000-0000-0000-000000000001";
const LUNA = "11111111-1111-4111-8111-111111111111";
const MILO = "22222222-2222-4222-8222-222222222222";

type TranscriptRow = {
  companionId: string;
  role: string;
  content: string;
  authorId: string | null;
  authorName: string | null;
  createdAt: Date;
};

function fakeDb(rows: TranscriptRow[]) {
  const captured: { on?: unknown[]; where?: SQL; orderBy?: unknown[]; queries: number } = {
    queries: 0,
  };
  const builder = {
    from: () => builder,
    leftJoin: () => builder,
    where: (clause: SQL) => {
      captured.where = clause;
      return builder;
    },
    orderBy: (...order: unknown[]) => {
      captured.orderBy = order;
      return Promise.resolve(rows);
    },
  };
  const database = {
    selectDistinctOn: (on: unknown[]) => {
      captured.on = on;
      captured.queries += 1;
      return builder;
    },
  };
  return { database: database as unknown as Db, captured };
}

function renderWhere(clause: SQL | undefined) {
  if (!clause) throw new Error("the projection built no where clause");
  return new PgDialect().sqlToQuery(clause);
}

describe("companion last-message projection", () => {
  it("asks only for what a person or Pi said, inside one organization and id set", () => {
    const { database, captured } = fakeDb([]);
    void loadCompanionLastMessages(database, ORG, [LUNA, MILO]);

    const { sql, params } = renderWhere(captured.where);
    expect(sql).toContain('"role"');
    // Tool runs and permission cards are excluded in the query, so a Companion whose newest entry
    // is a shell command still previews the last thing that was actually said — and no command,
    // path, or pending question can reach a list row outside the thread it belongs to.
    expect(params).toContain("user");
    expect(params).toContain("assistant");
    expect(params).not.toContain("tool");
    expect(params).not.toContain("decision");
    expect(params).toContain(ORG);
    expect(params).toEqual(expect.arrayContaining([LUNA, MILO]));
  });

  it("takes one newest row per Companion", async () => {
    const { database, captured } = fakeDb([]);
    await loadCompanionLastMessages(database, ORG, [LUNA]);

    expect(captured.on).toHaveLength(1);
    const order = new PgDialect().sqlToQuery(captured.orderBy?.at(-1) as SQL);
    expect(order.sql).toContain("desc");
    expect(order.sql).toContain('"ordinal"');
  });

  it("reads nothing at all when there is no Companion to preview", async () => {
    const { database, captured } = fakeDb([]);
    expect(await loadCompanionLastMessages(database, ORG, [])).toEqual(new Map());
    expect(captured.queries).toBe(0);
  });

  it("projects the author, the role, and one bounded line per Companion", async () => {
    const { database } = fakeDb([
      {
        companionId: LUNA,
        role: "assistant",
        content: "Drafted the launch note.\nSecond paragraph nobody sees in a row.",
        authorId: null,
        authorName: null,
        createdAt: new Date("2026-08-14T09:05:00.000Z"),
      },
      {
        companionId: MILO,
        role: "user",
        content: "  Ship it   today  ",
        authorId: "user-2",
        authorName: "Ada Lovelace",
        createdAt: new Date("2026-08-14T08:00:00.000Z"),
      },
    ]);

    const previews = await loadCompanionLastMessages(database, ORG, [LUNA, MILO]);

    expect(previews.get(LUNA)).toEqual({
      preview: "Drafted the launch note.",
      role: "assistant",
      author_id: null,
      author_name: null,
      created_at: "2026-08-14T09:05:00.000Z",
    });
    expect(previews.get(MILO)).toEqual({
      preview: "Ship it today",
      role: "user",
      author_id: "user-2",
      author_name: "Ada Lovelace",
      created_at: "2026-08-14T08:00:00.000Z",
    });
  });

  it("drops a row whose role is not a chat role, however it reached the reader", async () => {
    // Belt to the query's braces: a projection that grew a role would still not put a tool title,
    // a system line, or a permission question on a conversation row.
    const { database } = fakeDb([
      {
        companionId: LUNA,
        role: "tool",
        content: "rm -rf /tmp/build",
        authorId: null,
        authorName: null,
        createdAt: new Date("2026-08-14T09:05:00.000Z"),
      },
    ]);

    expect(await loadCompanionLastMessages(database, ORG, [LUNA])).toEqual(new Map());
  });
});

describe("companion last-message preview", () => {
  it("keeps the first line that says something, collapsed to one line", () => {
    expect(companionLastMessagePreview("\n\n  Hello   there \n rest")).toBe("Hello there");
    expect(companionLastMessagePreview("line\ttwo")).toBe("line two");
    expect(companionLastMessagePreview("   \n  ")).toBe("");
  });

  it("cuts a long line to the width the contract accepts", () => {
    const long = "x".repeat(400);
    const preview = companionLastMessagePreview(long);
    expect(preview).toHaveLength(COMPANION_LAST_MESSAGE_PREVIEW_MAX_CHARACTERS);
    expect(companionLastMessagePreview("short")).toBe("short");
  });
});

const actor: ActorContext = { id: "user-1", email: "ada@example.test", name: "Ada" };

function companionRow(overrides: Record<string, unknown>) {
  return {
    orgId: ORG,
    id: LUNA,
    name: "Luna",
    persona: null,
    modelId: "claude-opus-4-8",
    selectedSkillIds: [],
    canWriteSkills: false,
    selectedMcpAccountIds: [],
    ownerId: actor.id,
    runtimeState: "stopped",
    daemonState: "stopped",
    boxId: null,
    providerIds: ["anthropic"],
    providerCredentialGeneration: null,
    diskLayoutVersion: 6,
    desktopAvailable: false,
    lastError: null,
    lastObservedAt: null,
    lastStartedAt: null,
    lastStoppedAt: null,
    createdAt: new Date("2026-08-14T08:00:00.000Z"),
    updatedAt: new Date("2026-08-14T09:00:00.000Z"),
    ...overrides,
  };
}

function fakeListDb(input: {
  rows: ReturnType<typeof companionRow>[];
  workspaceRole?: string | null;
  previews: TranscriptRow[];
  /** Highest transcript ordinal per Companion, which THE-351 reads to decide the unread badge. */
  highest?: Array<{ companionId: string; highestOrdinal: number }>;
  memberState?: Array<{ companionId: string; pinnedAt: Date | null; hidden: boolean; lastReadOrdinal: number | null }>;
}) {
  const previewedIds: string[] = [];
  // The list makes three reads besides the roster: member state, the highest ordinal per thread, and
  // the preview projection. The first two ride along from THE-351 and are answered flatly here.
  const database = {
    query: {
      memberships: { findFirst: async () => ({ orgRole: "developer" }) },
      companionWorkspaceAccess: {
        findFirst: async () => (input.workspaceRole ? { role: input.workspaceRole } : null),
      },
    },
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          orderBy: async () => input.rows,
          groupBy: async () => input.highest ?? [],
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(fields ? input.memberState ?? [] : input.rows).then(resolve),
        }),
      }),
    }),
    selectDistinctOn: () => {
      const builder = {
        from: () => builder,
        leftJoin: () => builder,
        where: (clause: SQL) => {
          previewedIds.push(...new PgDialect().sqlToQuery(clause).params
            .filter((param): param is string => typeof param === "string"));
          return builder;
        },
        orderBy: async () => input.previews,
      };
      return builder;
    },
  };
  return { database: database as unknown as Db, previewedIds };
}

describe("companion list previews", () => {
  it("puts each thread's last word on its own row", async () => {
    const { database } = fakeListDb({
      rows: [companionRow({}), companionRow({ id: MILO, name: "Milo" })],
      previews: [{
        companionId: MILO,
        role: "user",
        content: "Ship it",
        authorId: actor.id,
        authorName: "Ada",
        createdAt: new Date("2026-08-14T09:30:00.000Z"),
      }],
    });

    const companions = await listCompanions({ actor, orgId: ORG, database });

    expect(companions.find((item) => item.id === MILO)?.last_message).toEqual({
      preview: "Ship it",
      role: "user",
      author_id: actor.id,
      author_name: "Ada",
      created_at: "2026-08-14T09:30:00.000Z",
    });
    // A thread nobody has written in yet says so, rather than borrowing another Companion's line.
    expect(companions.find((item) => item.id === LUNA)?.last_message).toBeNull();
  });

  it("never previews a Companion the reader cannot open", async () => {
    const { database, previewedIds } = fakeListDb({
      // Someone else's Companion with no workspace grant: invisible, so it is not even asked about.
      rows: [companionRow({ id: MILO, name: "Milo", ownerId: "user-9" })],
      workspaceRole: null,
      previews: [],
    });

    expect(await listCompanions({ actor, orgId: ORG, database })).toEqual([]);
    expect(previewedIds).not.toContain(MILO);
  });

  it("gives a Viewer the same preview it gives a runner", async () => {
    const { database } = fakeListDb({
      rows: [companionRow({ id: MILO, name: "Milo", ownerId: "user-9" })],
      workspaceRole: "viewer",
      previews: [{
        companionId: MILO,
        role: "assistant",
        content: "Drafted the launch note.",
        authorId: null,
        authorName: null,
        createdAt: new Date("2026-08-14T09:30:00.000Z"),
      }],
    });

    const [companion] = await listCompanions({ actor, orgId: ORG, database });

    expect(companion?.access).toBe("viewer");
    expect(companion?.last_message?.preview).toBe("Drafted the launch note.");
    // The reading a Viewer must not get is the Box, and that redaction is unchanged by the preview.
    expect(companion?.runtime.box_id).toBeNull();
  });
});
