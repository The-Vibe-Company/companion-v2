import { schema, type Db } from "@companion/db";

/**
 * A hand-rolled fake database for the provider-connection and skill-run suites ONLY (never shared
 * with the skill fakeDbs — see the project rule about fakeDb fragility). It stores plain rows per
 * table and answers the exact query shapes the services issue, filtering rows generically: every
 * scalar bound in a drizzle condition that matches a DISTINGUISHING value of the table (ids, slugs,
 * keys) must match the row; params nothing in the table distinguishes on (e.g. the org id every row
 * shares) are ignored.
 */

export type FakeProviderConnectionRow = typeof schema.userProviderConnections.$inferSelect;
export type FakeOrgProviderConnectionRow = typeof schema.orgProviderConnections.$inferSelect;

export interface FakeSkillRow {
  id: string;
  orgId: string;
  slug: string;
  scope: "personal" | "org";
  creatorId: string;
  archivedAt: Date | null;
  currentVersionId: string | null;
}

export interface FakeSkillVersionRow {
  id: string;
  orgId: string;
  skillId: string;
  version: string;
  frontmatter: string;
  storagePath: string;
  createdAt: Date;
}

export interface FakeStore {
  role: "owner" | "admin" | "developer" | null;
  skills: FakeSkillRow[];
  skillVersions: FakeSkillVersionRow[];
  providerConnections: FakeProviderConnectionRow[];
  orgProviderConnections: FakeOrgProviderConnectionRow[];
  audit: Array<Record<string, unknown>>;
}

export function emptyStore(overrides: Partial<FakeStore> = {}): FakeStore {
  return {
    role: "developer",
    skills: [],
    skillVersions: [],
    providerConnections: [],
    orgProviderConnections: [],
    audit: [],
    ...overrides,
  };
}

/** Recursively collect bound scalar params from a drizzle condition tree. */
function conditionParams(cond: unknown, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (cond === null || typeof cond !== "object" || seen.has(cond)) return out;
  seen.add(cond);
  const record = cond as Record<string, unknown>;
  // Drizzle Param chunks carry { value, encoder }; columns carry { name, table } — skip columns.
  if ("value" in record && "encoder" in record) {
    const value = record.value;
    if (Array.isArray(value)) out.push(...value);
    else out.push(value);
    return out;
  }
  if ("table" in record && "name" in record && "columnType" in record) return out;
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) for (const item of value) conditionParams(item, out, seen);
    else if (value !== null && typeof value === "object") conditionParams(value, out, seen);
  }
  return out;
}

function matches(rowValues: unknown[], distinct: Set<unknown>, cond: unknown): boolean {
  const params = conditionParams(cond).filter((p) => distinct.has(p));
  if (params.length === 0) return true;
  const values = new Set(rowValues);
  return params.some((p) => values.has(p));
}

function distinctOf(rows: Array<Record<string, unknown>>, keys: string[]): Set<unknown> {
  const out = new Set<unknown>();
  for (const row of rows) for (const key of keys) if (row[key] != null) out.add(row[key]);
  return out;
}

const SKILL_KEYS = ["id", "slug"];
const SKILL_VERSION_KEYS = ["skillId", "id"];
const PROVIDER_CONN_KEYS = ["userId", "provider"];
const ORG_PROVIDER_CONN_KEYS = ["provider"];

export function fakeRunsDb(store: FakeStore): Db {
  function filterRows<T extends Record<string, unknown>>(rows: T[], keys: string[], cond: unknown): T[] {
    const distinct = distinctOf(rows, keys);
    return rows.filter((row) => matches(keys.map((k) => row[k]), distinct, cond));
  }

  function selectFrom(projection: Record<string, unknown> | undefined, table: unknown) {
    const chain = {
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: async (cond: unknown): Promise<unknown[]> => {
        if (table === schema.skillVersions) {
          const rows = filterRows(store.skillVersions as unknown as Record<string, unknown>[], SKILL_VERSION_KEYS, cond);
          return rows.map((r) => ({
            skillId: r.skillId,
            version: r.version,
            frontmatter: r.frontmatter,
            storagePath: r.storagePath,
          }));
        }
        if (table === schema.skills) {
          const rows = filterRows(store.skills as unknown as Record<string, unknown>[], SKILL_KEYS, cond) as unknown as FakeSkillRow[];
          if (projection && Object.keys(projection).length === 1 && "id" in projection) {
            return rows.map((r) => ({ id: r.id }));
          }
          return rows.map((r) => {
            const current = r.currentVersionId ? store.skillVersions.find((v) => v.id === r.currentVersionId) : null;
            return {
              id: r.id,
              slug: r.slug,
              scope: r.scope,
              creatorId: r.creatorId,
              archivedAt: r.archivedAt,
              currentVersion: current?.version ?? null,
              frontmatter: current?.frontmatter ?? null,
              releasedAt: current?.createdAt ?? null,
            };
          });
        }
        if (table === schema.userProviderConnections) {
          const rows = filterRows(
            store.providerConnections as unknown as Record<string, unknown>[],
            PROVIDER_CONN_KEYS,
            cond,
          );
          if (projection && "provider" in projection && "keyName" in projection) {
            return rows.map((r) => ({ provider: r.provider, keyName: r.keyName, createdAt: r.createdAt }));
          }
          return rows;
        }
        if (table === schema.orgProviderConnections) {
          const rows = filterRows(
            store.orgProviderConnections as unknown as Record<string, unknown>[],
            ORG_PROVIDER_CONN_KEYS,
            cond,
          );
          if (projection && "provider" in projection && "keyName" in projection) {
            return rows.map((r) => ({ provider: r.provider, keyName: r.keyName, createdAt: r.createdAt }));
          }
          return rows;
        }
        throw new Error("fakeRunsDb: unexpected select target");
      },
    };
    return chain;
  }

  const handle = {
    query: {
      memberships: {
        findFirst: async () => (store.role === null ? undefined : { orgRole: store.role }),
      },
    },
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => selectFrom(projection, table),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        const list = Array.isArray(values) ? values : [values];
        if (table === schema.userProviderConnections) {
          return {
            onConflictDoUpdate: async (opts: { set: Record<string, unknown> }) => {
              for (const v of list) {
                const existing = store.providerConnections.find(
                  (r) => r.userId === v.userId && r.provider === v.provider,
                );
                if (existing) Object.assign(existing, opts.set);
                else
                  store.providerConnections.push({
                    keyVersion: 1,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...v,
                  } as FakeProviderConnectionRow);
              }
            },
          };
        }
        if (table === schema.orgProviderConnections) {
          return {
            onConflictDoUpdate: async (opts: { set: Record<string, unknown> }) => {
              for (const v of list) {
                const existing = store.orgProviderConnections.find((r) => r.provider === v.provider);
                if (existing) Object.assign(existing, opts.set);
                else
                  store.orgProviderConnections.push({
                    keyVersion: 1,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...v,
                  } as FakeOrgProviderConnectionRow);
              }
            },
          };
        }
        if (table === schema.auditLog) {
          store.audit.push(...list);
          return Promise.resolve();
        }
        throw new Error("fakeRunsDb: unexpected insert target");
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          throw new Error("fakeRunsDb: unexpected update target");
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (cond: unknown) => {
        if (table === schema.userProviderConnections) {
          const doomed = filterRows(
            store.providerConnections as unknown as Record<string, unknown>[],
            PROVIDER_CONN_KEYS,
            cond,
          ) as unknown as FakeProviderConnectionRow[];
          store.providerConnections = store.providerConnections.filter((r) => !doomed.includes(r));
          return;
        }
        if (table === schema.orgProviderConnections) {
          const doomed = filterRows(
            store.orgProviderConnections as unknown as Record<string, unknown>[],
            ORG_PROVIDER_CONN_KEYS,
            cond,
          ) as unknown as FakeOrgProviderConnectionRow[];
          store.orgProviderConnections = store.orgProviderConnections.filter((r) => !doomed.includes(r));
          return;
        }
        throw new Error("fakeRunsDb: unexpected delete target");
      },
    }),
  };

  return handle as unknown as Db;
}
