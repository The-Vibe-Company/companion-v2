/**
 * Product promise:
 * Declared Skill Databases preserve state across requests, evolve additively, keep personal realms
 * member-private, serialize concurrent writers, and become read-only when a skill is archived.
 *
 * Regression caught:
 * A publication could accept destructive schema drift, two writes could lose an object generation,
 * or an organization admin could read another member's personal SQLite realm.
 *
 * Why this test is integrated:
 * The guarantee spans real PostgreSQL declaration metadata and advisory locks, the Core access
 * service, conditional object semantics, and the SQLite WASM worker.
 *
 * Failure proof:
 * Removing the compatibility gate, realm owner key, advisory transaction lock, or conditional put
 * makes the incompatible-publication, personal-isolation, or concurrent row-count assertion fail.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SkillDatabaseDeclaration } from "@companion/contracts";
import {
  claimSkillDatabaseObjectDeletions,
  completeSkillDatabaseObjectDeletion,
  describeSkillDatabase,
  executeSkillDatabaseStatement,
  getSkillDatabaseShares,
  persistSkillDatabaseDeclarations,
  setSkillDatabaseShares,
  type SkillDatabaseRuntime,
  type SkillDatabaseStorage,
} from "@companion/core";
import { schema, withTenantContext } from "@companion/db";
import { SqliteWasmSkillDatabaseRuntime } from "@companion/skilldb";
import { skillDatabaseKey } from "@companion/storage";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  seedSkill,
  type IntegrationFixture,
  type SeededSkill,
  type TestActor,
} from "./testDatabase";

class ConditionalMemoryStorage implements SkillDatabaseStorage {
  private readonly objects = new Map<string, { body: Buffer; etag: string }>();
  private generation = 0;

  async get(key: string) {
    const value = this.objects.get(key);
    return value ? { body: Buffer.from(value.body), etag: value.etag } : null;
  }

  async put(
    key: string,
    body: Buffer,
    condition: { ifMatch?: string; ifNoneMatch?: "*" },
  ) {
    const current = this.objects.get(key);
    if (condition.ifNoneMatch === "*" && current) throw new Error("precondition failed");
    if (condition.ifMatch !== undefined && current?.etag !== condition.ifMatch) {
      throw new Error("precondition failed");
    }
    const etag = `"generation-${++this.generation}"`;
    this.objects.set(key, { body: Buffer.from(body), etag });
    return { etag };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  has(key: string) {
    return this.objects.has(key);
  }
}

const initialDeclaration: SkillDatabaseDeclaration = {
  tables: {
    shared_notes: {
      audience: "organization",
      columns: {
        id: { type: "integer", nullable: false },
        body: { type: "text", nullable: false },
      },
      primary_key: ["id"],
      unique: [],
    },
    private_notes: {
      audience: "personal",
      columns: {
        id: { type: "integer", nullable: false },
        body: { type: "text", nullable: false },
      },
      primary_key: ["id"],
      unique: [],
    },
  },
};

function frontmatter(slug: string, declaration?: SkillDatabaseDeclaration): string {
  return JSON.stringify({
    name: slug,
    description: "Skill Database integration fixture",
    metadata: {},
    ...(declaration ? { companion: { database: declaration } } : {}),
  });
}

describe("Skill Database lifecycle", () => {
  let fixture: IntegrationFixture;
  let skill: SeededSkill;
  let undeclared: SeededSkill;
  let priorFeatureFlag: string | undefined;
  const storage = new ConditionalMemoryStorage();
  const runtime = new SqliteWasmSkillDatabaseRuntime(2);

  beforeAll(async () => {
    priorFeatureFlag = process.env.COMPANION_SKILL_DATABASES_ENABLED;
    process.env.COMPANION_SKILL_DATABASES_ENABLED = "true";
    fixture = await createIntegrationFixture();
    skill = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `database-${fixture.suffix}`,
      scope: "org",
    });
    undeclared = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `database-undeclared-${fixture.suffix}`,
      scope: "org",
    });
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => persistSkillDatabaseDeclarations({
        orgId: fixture.orgA,
        skillId: skill.id,
        frontmatter: frontmatter(skill.slug, initialDeclaration),
        database,
      }),
    );
  });

  afterAll(async () => {
    await runtime.close();
    if (fixture) await fixture.cleanup();
    await integrationSql.end();
    if (priorFeatureFlag === undefined) delete process.env.COMPANION_SKILL_DATABASES_ENABLED;
    else process.env.COMPANION_SKILL_DATABASES_ENABLED = priorFeatureFlag;
  });

  function statement(
    actor: TestActor,
    audience: "organization" | "personal",
    sql: string,
    params: Array<string | number | boolean | null>,
    mode: "read" | "write",
  ) {
    return executeSkillDatabaseStatement({
      actor,
      orgId: fixture.orgA,
      slug: skill.slug,
      statement: { audience, sql, params },
      mode,
      runtime,
      storage,
      storageKey: skillDatabaseKey,
    });
  }

  it("preserves organization state and serializes concurrent writers", async () => {
    await statement(
      fixture.owner,
      "organization",
      "INSERT INTO shared_notes(body) VALUES (?)",
      ["first"],
      "write",
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        statement(
          fixture.admin,
          "organization",
          "INSERT INTO shared_notes(body) VALUES (?)",
          [`concurrent-${index}`],
          "write",
        )
      ),
    );

    await expect(
      statement(
        fixture.developer,
        "organization",
        "SELECT COUNT(*) AS total FROM shared_notes",
        [],
        "read",
      ),
    ).resolves.toMatchObject({ rows: [[9]], read_only: true });
  });

  it("gives every member a distinct personal realm without an admin override", async () => {
    await statement(
      fixture.owner,
      "personal",
      "INSERT INTO private_notes(body) VALUES (?)",
      ["owner-only"],
      "write",
    );
    await expect(
      statement(
        fixture.admin,
        "personal",
        "SELECT body FROM private_notes ORDER BY id",
        [],
        "read",
      ),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      statement(
        fixture.owner,
        "personal",
        "SELECT body FROM private_notes ORDER BY id",
        [],
        "read",
      ),
    ).resolves.toMatchObject({ rows: [["owner-only"]] });
  });

  it("shares one personal realm read-write, hides it from third members, and revokes future access", async () => {
    const before = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => getSkillDatabaseShares({
        actor: fixture.owner,
        orgId: fixture.orgA,
        slug: skill.slug,
        database,
      }),
    );
    expect(before.members.find((member) => member.user_id === fixture.admin.id)?.shared).toBe(false);

    const shared = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => setSkillDatabaseShares({
        actor: fixture.owner,
        orgId: fixture.orgA,
        slug: skill.slug,
        userIds: [fixture.admin.id],
        storageKey: skillDatabaseKey,
        database,
      }),
    );
    expect(shared.realm_id).toMatch(/[0-9a-f-]{36}/);

    const adminDescription = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.admin.id },
      (database) => describeSkillDatabase({
        actor: fixture.admin,
        orgId: fixture.orgA,
        slug: skill.slug,
        database,
      }),
    );
    expect(adminDescription.realms).toContainEqual(expect.objectContaining({
      id: shared.realm_id,
      audience: "personal",
      access: "shared",
      owner: expect.objectContaining({ user_id: fixture.owner.id }),
    }));

    const sharedStatement = (
      actor: TestActor,
      sqlText: string,
      params: Array<string | number | boolean | null>,
      mode: "read" | "write",
      statementStorage: SkillDatabaseStorage = storage,
    ) => executeSkillDatabaseStatement({
      actor,
      orgId: fixture.orgA,
      slug: skill.slug,
      statement: {
        audience: "personal",
        realm_id: shared.realm_id!,
        sql: sqlText,
        params,
      },
      mode,
      runtime,
      storage: statementStorage,
      storageKey: skillDatabaseKey,
    });

    await expect(sharedStatement(
      fixture.admin,
      "SELECT body FROM private_notes ORDER BY id",
      [],
      "read",
    )).resolves.toMatchObject({ rows: [["owner-only"]] });
    await sharedStatement(
      fixture.admin,
      "INSERT INTO private_notes(body) VALUES (?)",
      ["written-by-admin"],
      "write",
    );
    await expect(statement(
      fixture.owner,
      "personal",
      "SELECT body FROM private_notes ORDER BY id",
      [],
      "read",
    )).resolves.toMatchObject({ rows: [["owner-only"], ["written-by-admin"]] });
    await expect(sharedStatement(
      fixture.developer,
      "SELECT body FROM private_notes",
      [],
      "read",
    )).rejects.toMatchObject({ code: "skill_database_no_realm" });

    let announceGet!: () => void;
    const getStarted = new Promise<void>((resolve) => {
      announceGet = resolve;
    });
    let releaseGet!: () => void;
    const getReleased = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    const blockedStorage: SkillDatabaseStorage = {
      async get(key, signal) {
        announceGet();
        await getReleased;
        if (signal?.aborted) throw signal.reason;
        return storage.get(key);
      },
      put: storage.put.bind(storage),
      delete: storage.delete.bind(storage),
    };
    const inFlightRead = sharedStatement(
      fixture.admin,
      "SELECT body FROM private_notes ORDER BY id",
      [],
      "read",
      blockedStorage,
    );
    await getStarted;
    let revocationCompleted = false;
    const revocation = withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => setSkillDatabaseShares({
        actor: fixture.owner,
        orgId: fixture.orgA,
        slug: skill.slug,
        userIds: [],
        storageKey: skillDatabaseKey,
        database,
      }),
    ).then(() => {
      revocationCompleted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(revocationCompleted).toBe(false);
    releaseGet();
    await expect(inFlightRead).resolves.toMatchObject({
      rows: [["owner-only"], ["written-by-admin"]],
    });
    await revocation;
    await expect(sharedStatement(
      fixture.admin,
      "SELECT body FROM private_notes",
      [],
      "read",
    )).rejects.toMatchObject({ code: "skill_database_no_realm" });

    const auditRows = await integrationDb
      .select({ metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(and(
        eq(schema.auditLog.action, "skill.database.shares.set"),
        eq(schema.auditLog.targetId, shared.realm_id!),
      ));
    expect(auditRows.map((row) => row.metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({ added: [fixture.admin.id], removed: [] }),
      expect.objectContaining({ added: [], removed: [fixture.admin.id] }),
    ]));
  });

  it("rejects self, unknown, and cross-tenant share recipients", async () => {
    const setRecipients = (userIds: string[]) => withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => setSkillDatabaseShares({
        actor: fixture.owner,
        orgId: fixture.orgA,
        slug: skill.slug,
        userIds,
        storageKey: skillDatabaseKey,
        database,
      }),
    );
    await expect(setRecipients([fixture.owner.id]))
      .rejects.toMatchObject({ code: "skill_database_invalid_share" });
    await expect(setRecipients(["missing-member"]))
      .rejects.toMatchObject({ code: "skill_database_invalid_share" });
    await expect(setRecipients([fixture.outsider.id]))
      .rejects.toMatchObject({ code: "skill_database_invalid_share" });
  });

  it("never shares a realm belonging to a personal skill", async () => {
    const personal = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `database-personal-${fixture.suffix}`,
      scope: "personal",
    });
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => persistSkillDatabaseDeclarations({
        orgId: fixture.orgA,
        skillId: personal.id,
        frontmatter: frontmatter(personal.slug, initialDeclaration),
        database,
      }),
    );
    await expect(withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => setSkillDatabaseShares({
        actor: fixture.owner,
        orgId: fixture.orgA,
        slug: personal.slug,
        userIds: [fixture.admin.id],
        storageKey: skillDatabaseKey,
        database,
      }),
    )).rejects.toMatchObject({ code: "skill_database_sharing_unavailable" });
  });

  it("revokes recipients when publication removes the last active personal table", async () => {
    const retiring = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `database-retire-personal-${fixture.suffix}`,
      scope: "org",
    });
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => persistSkillDatabaseDeclarations({
        orgId: fixture.orgA,
        skillId: retiring.id,
        frontmatter: frontmatter(retiring.slug, {
          tables: { personal_state: initialDeclaration.tables.private_notes! },
        }),
        database,
      }),
    );
    const granted = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => setSkillDatabaseShares({
        actor: fixture.owner,
        orgId: fixture.orgA,
        slug: retiring.slug,
        userIds: [fixture.admin.id],
        storageKey: skillDatabaseKey,
        database,
      }),
    );
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => persistSkillDatabaseDeclarations({
        orgId: fixture.orgA,
        skillId: retiring.id,
        frontmatter: frontmatter(retiring.slug, { tables: {} }),
        database,
      }),
    );
    const remaining = await integrationDb
      .select()
      .from(schema.skillDatabaseRealmShares)
      .where(eq(schema.skillDatabaseRealmShares.realmId, granted.realm_id!));
    expect(remaining).toEqual([]);
  });

  it("applies additive migrations without losing rows and rejects destructive drift", async () => {
    const additive: SkillDatabaseDeclaration = {
      tables: {
        ...initialDeclaration.tables,
        shared_notes: {
          ...initialDeclaration.tables.shared_notes!,
          columns: {
            ...initialDeclaration.tables.shared_notes!.columns,
            category: { type: "text", nullable: true },
          },
        },
      },
    };
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => persistSkillDatabaseDeclarations({
        orgId: fixture.orgA,
        skillId: skill.id,
        frontmatter: frontmatter(skill.slug, additive),
        database,
      }),
    );
    await expect(
      statement(
        fixture.owner,
        "organization",
        "SELECT body, category FROM shared_notes WHERE body = ?",
        ["first"],
        "read",
      ),
    ).resolves.toMatchObject({ rows: [["first", null]], schema_generation: 2 });

    const incompatible: SkillDatabaseDeclaration = {
      tables: {
        ...additive.tables,
        shared_notes: {
          ...additive.tables.shared_notes!,
          columns: {
            ...additive.tables.shared_notes!.columns,
            body: { type: "integer", nullable: false },
          },
        },
      },
    };
    await expect(
      withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) => persistSkillDatabaseDeclarations({
          orgId: fixture.orgA,
          skillId: skill.id,
          frontmatter: frontmatter(skill.slug, incompatible),
          database,
        }),
      ),
    ).rejects.toThrow(/existing columns are immutable/);

    const requiredColumnRemoval: SkillDatabaseDeclaration = {
      tables: {
        ...additive.tables,
        shared_notes: {
          ...additive.tables.shared_notes!,
          columns: {
            id: additive.tables.shared_notes!.columns.id!,
            category: additive.tables.shared_notes!.columns.category!,
          },
        },
      },
    };
    await expect(
      withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) => persistSkillDatabaseDeclarations({
          orgId: fixture.orgA,
          skillId: skill.id,
          frontmatter: frontmatter(skill.slug, requiredColumnRemoval),
          database,
        }),
      ),
    ).rejects.toThrow(/required column without a default cannot be retired/);
  });

  it("serializes concurrent manifest projections before assigning schema generations", async () => {
    const category = {
      ...initialDeclaration,
      tables: {
        ...initialDeclaration.tables,
        shared_notes: {
          ...initialDeclaration.tables.shared_notes!,
          columns: {
            ...initialDeclaration.tables.shared_notes!.columns,
            category: { type: "text" as const, nullable: true },
          },
        },
      },
    };
    const priority = {
      ...category,
      tables: {
        ...category.tables,
        shared_notes: {
          ...category.tables.shared_notes!,
          columns: {
            ...category.tables.shared_notes!.columns,
            priority: { type: "integer" as const, nullable: true },
          },
        },
      },
    };
    const flagged = {
      ...priority,
      tables: {
        ...priority.tables,
        shared_notes: {
          ...priority.tables.shared_notes!,
          columns: {
            ...priority.tables.shared_notes!.columns,
            flagged: { type: "boolean" as const, nullable: true },
          },
        },
      },
    };
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });
    const first = withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      async (database) => {
        await database.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`skilldb-schema:${skill.id}`}, 0))`,
        );
        firstLocked();
        await release;
        await persistSkillDatabaseDeclarations({
          orgId: fixture.orgA,
          skillId: skill.id,
          frontmatter: frontmatter(skill.slug, priority),
          database,
        });
      },
    );
    await locked;
    const second = withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => persistSkillDatabaseDeclarations({
        orgId: fixture.orgA,
        skillId: skill.id,
        frontmatter: frontmatter(skill.slug, flagged),
        database,
      }),
    );
    releaseFirst();
    await Promise.all([first, second]);

    await expect(
      statement(
        fixture.owner,
        "organization",
        "SELECT category, priority, flagged FROM shared_notes WHERE body = ?",
        ["first"],
        "read",
      ),
    ).resolves.toMatchObject({
      rows: [[null, null, null]],
      schema_generation: 4,
    });
  });

  it("keeps publication from changing the schema snapshot while a realm is open", async () => {
    const coordinated = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `database-schema-snapshot-${fixture.suffix}`,
      scope: "org",
    });
    const first: SkillDatabaseDeclaration = {
      tables: {
        state: {
          audience: "organization",
          columns: { id: { type: "text", nullable: false } },
          primary_key: ["id"],
          unique: [],
        },
      },
    };
    const second: SkillDatabaseDeclaration = {
      tables: {
        state: {
          ...first.tables.state!,
          columns: {
            ...first.tables.state!.columns,
            note: { type: "text", nullable: true },
          },
        },
      },
    };
    const publish = (declaration: SkillDatabaseDeclaration) => withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => persistSkillDatabaseDeclarations({
        orgId: fixture.orgA,
        skillId: coordinated.id,
        frontmatter: frontmatter(coordinated.slug, declaration),
        database,
      }),
    );
    await publish(first);
    await executeSkillDatabaseStatement({
      actor: fixture.owner,
      orgId: fixture.orgA,
      slug: coordinated.slug,
      statement: {
        audience: "organization",
        sql: "INSERT INTO state(id) VALUES (?)",
        params: ["before-publish"],
      },
      mode: "write",
      runtime,
      storage,
      storageKey: skillDatabaseKey,
    });
    let announceGet!: () => void;
    const getStarted = new Promise<void>((resolve) => {
      announceGet = resolve;
    });
    let releaseGet!: () => void;
    const getReleased = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    const blockedStorage: SkillDatabaseStorage = {
      async get(key, signal) {
        announceGet();
        await getReleased;
        if (signal?.aborted) throw signal.reason;
        return storage.get(key);
      },
      put: storage.put.bind(storage),
      delete: storage.delete.bind(storage),
    };
    const opening = executeSkillDatabaseStatement({
      actor: fixture.owner,
      orgId: fixture.orgA,
      slug: coordinated.slug,
      statement: {
        audience: "organization",
        sql: "SELECT id FROM state",
        params: [],
      },
      mode: "read",
      runtime,
      storage: blockedStorage,
      storageKey: skillDatabaseKey,
    });
    await getStarted;
    let publicationCompleted = false;
    const publication = publish(second).then(() => {
      publicationCompleted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(publicationCompleted).toBe(false);
    releaseGet();
    await expect(opening).resolves.toMatchObject({
      rows: [["before-publish"]],
      schema_generation: 1,
    });
    await publication;
    await expect(executeSkillDatabaseStatement({
      actor: fixture.owner,
      orgId: fixture.orgA,
      slug: coordinated.slug,
      statement: {
        audience: "organization",
        sql: "SELECT note FROM state WHERE id = ?",
        params: ["before-publish"],
      },
      mode: "read",
      runtime,
      storage,
      storageKey: skillDatabaseKey,
    })).resolves.toMatchObject({
      rows: [[null]],
      schema_generation: 2,
    });
  });

  it("advances generation when restoring schema omitted from a newly created realm", async () => {
    const restorable = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `database-restore-${fixture.suffix}`,
      scope: "org",
    });
    const declared: SkillDatabaseDeclaration = {
      tables: {
        restored_state: {
          audience: "organization",
          columns: {
            id: { type: "text", nullable: false },
            note: { type: "text", nullable: true },
          },
          primary_key: ["id"],
          unique: [],
        },
      },
    };
    const withoutNote: SkillDatabaseDeclaration = {
      tables: {
        restored_state: {
          ...declared.tables.restored_state!,
          columns: { id: declared.tables.restored_state!.columns.id! },
        },
      },
    };
    const publish = (declaration: SkillDatabaseDeclaration) => withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => persistSkillDatabaseDeclarations({
        orgId: fixture.orgA,
        skillId: restorable.id,
        frontmatter: frontmatter(restorable.slug, declaration),
        database,
      }),
    );
    await publish(declared);
    await publish(withoutNote);
    await executeSkillDatabaseStatement({
      actor: fixture.owner,
      orgId: fixture.orgA,
      slug: restorable.slug,
      statement: {
        audience: "organization",
        sql: "INSERT INTO restored_state(id) VALUES (?)",
        params: ["created-while-retired"],
      },
      mode: "write",
      runtime,
      storage,
      storageKey: skillDatabaseKey,
    });
    await publish(declared);
    await expect(executeSkillDatabaseStatement({
      actor: fixture.owner,
      orgId: fixture.orgA,
      slug: restorable.slug,
      statement: {
        audience: "organization",
        sql: "SELECT note FROM restored_state WHERE id = ?",
        params: ["created-while-retired"],
      },
      mode: "read",
      runtime,
      storage,
      storageKey: skillDatabaseKey,
    })).resolves.toMatchObject({ rows: [[null]], schema_generation: 2 });
  });

  it("restores a retired table when unchanged columns are declared in a different JSON order", async () => {
    const restorable = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `database-table-order-${fixture.suffix}`,
      scope: "org",
    });
    const publish = (declaration: SkillDatabaseDeclaration) => withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => persistSkillDatabaseDeclarations({
        orgId: fixture.orgA,
        skillId: restorable.id,
        frontmatter: frontmatter(restorable.slug, declaration),
        database,
      }),
    );
    await publish({
      tables: {
        state: {
          audience: "organization",
          columns: {
            id: { type: "text", nullable: false },
            note: { type: "text", nullable: true },
          },
          primary_key: ["id"],
          unique: [],
        },
      },
    });
    await publish({ tables: {} });
    await expect(publish({
      tables: {
        state: {
          audience: "organization",
          columns: {
            note: { type: "text", nullable: true },
            id: { type: "text", nullable: false },
          },
          primary_key: ["id"],
          unique: [],
        },
      },
    })).resolves.toBeUndefined();

    const restored = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => database.query.skillDatabaseTables.findFirst({
        where: and(
          eq(schema.skillDatabaseTables.orgId, fixture.orgA),
          eq(schema.skillDatabaseTables.skillId, restorable.id),
          eq(schema.skillDatabaseTables.tableName, "state"),
        ),
      }),
    );
    expect(restored?.retiredAt).toBeNull();
    expect(restored?.columns.map((column) => column.name)).toEqual(["note", "id"]);
  });

  it("never reopens deleted personal realm bytes and durably queues their object", async () => {
    const oldRealm = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => database.query.skillDatabaseRealms.findFirst({
        where: and(
          eq(schema.skillDatabaseRealms.orgId, fixture.orgA),
          eq(schema.skillDatabaseRealms.skillId, skill.id),
          eq(schema.skillDatabaseRealms.ownerId, fixture.owner.id),
        ),
      }),
    );
    expect(oldRealm).toBeDefined();
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => database
        .delete(schema.skillDatabaseRealms)
        .where(eq(schema.skillDatabaseRealms.id, oldRealm!.id)),
    );
    await expect(
      statement(
        fixture.owner,
        "personal",
        "SELECT body FROM private_notes",
        [],
        "read",
      ),
    ).resolves.toMatchObject({ rows: [] });
    const replacement = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => database.query.skillDatabaseRealms.findFirst({
        where: and(
          eq(schema.skillDatabaseRealms.orgId, fixture.orgA),
          eq(schema.skillDatabaseRealms.skillId, skill.id),
          eq(schema.skillDatabaseRealms.ownerId, fixture.owner.id),
        ),
      }),
    );
    expect(replacement?.storageKey).not.toBe(oldRealm?.storageKey);
    const queued = await integrationDb.query.skillDatabaseObjectDeletions.findFirst({
      where: eq(schema.skillDatabaseObjectDeletions.storageKey, oldRealm!.storageKey),
    });
    expect(queued?.orgId).toBe(fixture.orgA);
    const claimed = (await claimSkillDatabaseObjectDeletions({ limit: 100 }))
      .find((deletion) => deletion.storageKey === oldRealm!.storageKey);
    expect(claimed?.claimToken).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      completeSkillDatabaseObjectDeletion({ deletion: claimed! }),
    ).resolves.toBe(true);
  });

  it("does not create a declaration anchor for a manifest without database tables", async () => {
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => persistSkillDatabaseDeclarations({
        orgId: fixture.orgA,
        skillId: undeclared.id,
        frontmatter: frontmatter(undeclared.slug),
        database,
      }),
    );
    const row = await integrationDb.query.skillDatabaseSchemas.findFirst({
      where: and(
        eq(schema.skillDatabaseSchemas.orgId, fixture.orgA),
        eq(schema.skillDatabaseSchemas.skillId, undeclared.id),
      ),
    });
    expect(row).toBeUndefined();
  });

  it("rejects declarations while the rolling-deployment gate is disabled", async () => {
    delete process.env.COMPANION_SKILL_DATABASES_ENABLED;
    try {
      await expect(
        withTenantContext(
          { orgId: fixture.orgA, userId: fixture.owner.id },
          (database) => persistSkillDatabaseDeclarations({
            orgId: fixture.orgA,
            skillId: undeclared.id,
            frontmatter: frontmatter(undeclared.slug, initialDeclaration),
            database,
          }),
        ),
      ).rejects.toMatchObject({ code: "skill_database_disabled" });
    } finally {
      process.env.COMPANION_SKILL_DATABASES_ENABLED = "true";
    }
  });

  it("keeps a durable realm row when S3 succeeds but the metadata transaction rolls back", async () => {
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => persistSkillDatabaseDeclarations({
        orgId: fixture.orgA,
        skillId: undeclared.id,
        frontmatter: frontmatter(undeclared.slug, initialDeclaration),
        database,
      }),
    );
    const invalidMetadataRuntime: SkillDatabaseRuntime = {
      async execute() {
        return {
          columns: [],
          rows: [],
          changes: 1,
          lastInsertRowid: null,
          readOnly: false,
          image: Buffer.from("uploaded-before-database-failure"),
          dbSizeBytes: -1,
        };
      },
    };
    await expect(executeSkillDatabaseStatement({
      actor: fixture.owner,
      orgId: fixture.orgA,
      slug: undeclared.slug,
      statement: {
        audience: "organization",
        sql: "INSERT INTO shared_notes(body) VALUES (?)",
        params: ["metadata-failure"],
      },
      mode: "write",
      runtime: invalidMetadataRuntime,
      storage,
      storageKey: skillDatabaseKey,
    })).rejects.toThrow();
    const realm = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => database.query.skillDatabaseRealms.findFirst({
        where: and(
          eq(schema.skillDatabaseRealms.orgId, fixture.orgA),
          eq(schema.skillDatabaseRealms.skillId, undeclared.id),
          eq(schema.skillDatabaseRealms.audience, "organization"),
        ),
      }),
    );
    expect(realm).toBeDefined();
    expect(storage.has(realm!.storageKey)).toBe(true);
    const recoveryRuntime: SkillDatabaseRuntime = {
      async execute(input) {
        return {
          columns: ["ok"],
          rows: [[1]],
          changes: 0,
          lastInsertRowid: null,
          readOnly: true,
          image: null,
          dbSizeBytes: input.image?.byteLength ?? 0,
        };
      },
    };
    await expect(executeSkillDatabaseStatement({
      actor: fixture.owner,
      orgId: fixture.orgA,
      slug: undeclared.slug,
      statement: {
        audience: "organization",
        sql: "SELECT 1",
        params: [],
      },
      mode: "read",
      runtime: recoveryRuntime,
      storage,
      storageKey: skillDatabaseKey,
    })).resolves.toMatchObject({ rows: [[1]] });
    const healed = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => database.query.skillDatabaseRealms.findFirst({
        where: eq(schema.skillDatabaseRealms.id, realm!.id),
      }),
    );
    expect(healed).toMatchObject({
      etag: expect.any(String),
      sizeBytes: Buffer.byteLength("uploaded-before-database-failure"),
      schemaGeneration: 1,
    });
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => database
        .delete(schema.skillDatabaseRealms)
        .where(eq(schema.skillDatabaseRealms.id, realm!.id)),
    );
    await expect(
      integrationDb.query.skillDatabaseObjectDeletions.findFirst({
        where: eq(schema.skillDatabaseObjectDeletions.storageKey, realm!.storageKey),
      }),
    ).resolves.toBeDefined();
  });

  it("keeps the realm registered until an in-flight object write commits", async () => {
    const racing = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `database-delete-race-${fixture.suffix}`,
      scope: "org",
    });
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => persistSkillDatabaseDeclarations({
        orgId: fixture.orgA,
        skillId: racing.id,
        frontmatter: frontmatter(racing.slug, initialDeclaration),
        database,
      }),
    );
    let announcePut!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      announcePut = resolve;
    });
    let releasePut!: () => void;
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const racingStorage: SkillDatabaseStorage = {
      get: storage.get.bind(storage),
      async put(key, body, condition) {
        announcePut();
        await putReleased;
        return storage.put(key, body, condition);
      },
      delete: storage.delete.bind(storage),
    };
    const imageRuntime: SkillDatabaseRuntime = {
      async execute() {
        return {
          columns: [],
          rows: [],
          changes: 1,
          lastInsertRowid: null,
          readOnly: false,
          image: Buffer.from("race-safe-image"),
          dbSizeBytes: 15,
        };
      },
    };
    const execution = executeSkillDatabaseStatement({
      actor: fixture.owner,
      orgId: fixture.orgA,
      slug: racing.slug,
      statement: {
        audience: "organization",
        sql: "INSERT INTO shared_notes(id, body) VALUES (?, ?)",
        params: [1, "race"],
      },
      mode: "write",
      runtime: imageRuntime,
      storage: racingStorage,
      storageKey: skillDatabaseKey,
    });
    await putStarted;
    // Use the independent integration connection so this race proof also runs with the application
    // pool capped at one: the statement intentionally holds that sole application connection.
    const realm = await integrationDb.query.skillDatabaseRealms.findFirst({
      where: and(
        eq(schema.skillDatabaseRealms.orgId, fixture.orgA),
        eq(schema.skillDatabaseRealms.skillId, racing.id),
      ),
    });
    expect(realm).toBeDefined();
    let deletionCompleted = false;
    const deletion = integrationDb
      .delete(schema.skillDatabaseRealms)
      .where(eq(schema.skillDatabaseRealms.id, realm!.id))
      .then(() => {
      deletionCompleted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deletionCompleted).toBe(false);

    releasePut();
    await execution;
    await deletion;
    expect(storage.has(realm!.storageKey)).toBe(true);
    const queued = await integrationDb.query.skillDatabaseObjectDeletions.findFirst({
      where: eq(schema.skillDatabaseObjectDeletions.storageKey, realm!.storageKey),
    });
    expect(queued).toBeDefined();
    await storage.delete(realm!.storageKey);
    const claimed = (await claimSkillDatabaseObjectDeletions({ limit: 100 }))
      .find((candidate) => candidate.storageKey === realm!.storageKey);
    expect(claimed).toBeDefined();
    await expect(completeSkillDatabaseObjectDeletion({ deletion: claimed! })).resolves.toBe(true);
    expect(storage.has(realm!.storageKey)).toBe(false);
  });

  it("bounds per-member rate accounting to the current minute", async () => {
    const staleWindow = new Date(Date.now() - 120_000);
    staleWindow.setSeconds(0, 0);
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => database
        .insert(schema.skillDatabaseRateWindows)
        .values({
          orgId: fixture.orgA,
          userId: fixture.owner.id,
          windowStart: staleWindow,
          queryCount: 1,
        })
        .onConflictDoNothing(),
    );
    await statement(fixture.owner, "organization", "SELECT 1", [], "read");
    const stale = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => database.query.skillDatabaseRateWindows.findFirst({
        where: and(
          eq(schema.skillDatabaseRateWindows.orgId, fixture.orgA),
          eq(schema.skillDatabaseRateWindows.userId, fixture.owner.id),
          eq(schema.skillDatabaseRateWindows.windowStart, staleWindow),
        ),
      }),
    );
    expect(stale).toBeUndefined();
  });

  it("releases the realm transaction when object storage stalls", async () => {
    const priorTimeout = process.env.COMPANION_SKILL_DB_STORAGE_TIMEOUT_MS;
    process.env.COMPANION_SKILL_DB_STORAGE_TIMEOUT_MS = "25";
    const stalledStorage: SkillDatabaseStorage = {
      get(_key, signal) {
        return new Promise((_resolve, reject) => {
          const abort = () => reject(signal?.reason ?? new Error("storage aborted"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
      put: storage.put.bind(storage),
      delete: storage.delete.bind(storage),
    };
    try {
      await expect(executeSkillDatabaseStatement({
        actor: fixture.owner,
        orgId: fixture.orgA,
        slug: skill.slug,
        statement: { audience: "organization", sql: "SELECT 1", params: [] },
        mode: "read",
        runtime,
        storage: stalledStorage,
        storageKey: skillDatabaseKey,
      })).rejects.toMatchObject({ code: "storage_unavailable" });
    } finally {
      if (priorTimeout === undefined) delete process.env.COMPANION_SKILL_DB_STORAGE_TIMEOUT_MS;
      else process.env.COMPANION_SKILL_DB_STORAGE_TIMEOUT_MS = priorTimeout;
    }
    await expect(
      statement(fixture.owner, "organization", "SELECT COUNT(*) FROM shared_notes", [], "read"),
    ).resolves.toMatchObject({ rows: [[9]] });
  });

  it("fails closed when an initialized realm object is missing", async () => {
    const missingObject = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `database-missing-object-${fixture.suffix}`,
      scope: "org",
    });
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => persistSkillDatabaseDeclarations({
        orgId: fixture.orgA,
        skillId: missingObject.id,
        frontmatter: frontmatter(missingObject.slug, initialDeclaration),
        database,
      }),
    );
    const execute = (sqlText: string, mode: "read" | "write") => executeSkillDatabaseStatement({
      actor: fixture.owner,
      orgId: fixture.orgA,
      slug: missingObject.slug,
      statement: {
        audience: "organization" as const,
        sql: sqlText,
        params: mode === "write" ? [1, "durable"] : [],
      },
      mode,
      runtime,
      storage,
      storageKey: skillDatabaseKey,
    });
    await execute("INSERT INTO shared_notes(id, body) VALUES (?, ?)", "write");
    const realm = await integrationDb.query.skillDatabaseRealms.findFirst({
      where: and(
        eq(schema.skillDatabaseRealms.orgId, fixture.orgA),
        eq(schema.skillDatabaseRealms.skillId, missingObject.id),
      ),
    });
    expect(realm).toMatchObject({
      schemaGeneration: 1,
      sizeBytes: expect.any(Number),
      etag: expect.any(String),
    });
    await storage.delete(realm!.storageKey);

    await expect(execute("SELECT body FROM shared_notes", "read"))
      .rejects.toMatchObject({ code: "storage_unavailable" });
    expect(storage.has(realm!.storageKey)).toBe(false);
  });

  it("allows archived reads but rejects archived writes", async () => {
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => setSkillDatabaseShares({
        actor: fixture.owner,
        orgId: fixture.orgA,
        slug: skill.slug,
        userIds: [fixture.developer.id],
        storageKey: skillDatabaseKey,
        database,
      }),
    );
    await integrationDb
      .update(schema.skills)
      .set({ archivedAt: new Date() })
      .where(and(eq(schema.skills.orgId, fixture.orgA), eq(schema.skills.id, skill.id)));

    await expect(
      statement(
        fixture.owner,
        "organization",
        "SELECT COUNT(*) FROM shared_notes",
        [],
        "read",
      ),
    ).resolves.toMatchObject({ rows: [[9]] });
    await expect(
      statement(
        fixture.owner,
        "organization",
        "DELETE FROM shared_notes",
        [],
        "write",
      ),
    ).rejects.toMatchObject({
      code: "skill_database_archived",
    });
    await expect(withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => setSkillDatabaseShares({
        actor: fixture.owner,
        orgId: fixture.orgA,
        slug: skill.slug,
        userIds: [fixture.developer.id, fixture.admin.id],
        storageKey: skillDatabaseKey,
        database,
      }),
    )).rejects.toMatchObject({ code: "skill_database_archived" });
    await expect(withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => setSkillDatabaseShares({
        actor: fixture.owner,
        orgId: fixture.orgA,
        slug: skill.slug,
        userIds: [],
        storageKey: skillDatabaseKey,
        database,
      }),
    )).resolves.toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({ user_id: fixture.developer.id, shared: false }),
      ]),
    });
  });
});
