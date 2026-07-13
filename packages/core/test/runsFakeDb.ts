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
export type FakeUserModelPreferencesRow = typeof schema.userModelPreferences.$inferSelect;
export type FakeOrgModelPreferencesRow = typeof schema.orgModelPreferences.$inferSelect;
export type FakeRunRow = typeof schema.skillRuns.$inferSelect;
export type FakeRunAttachmentRow = typeof schema.skillRunAttachments.$inferSelect;
export type FakeRunArtifactRow = typeof schema.skillRunArtifacts.$inferSelect;

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
  userModelPreferences: FakeUserModelPreferencesRow[];
  orgModelPreferences: FakeOrgModelPreferencesRow[];
  runs: FakeRunRow[];
  runAttachments: FakeRunAttachmentRow[];
  runArtifacts: FakeRunArtifactRow[];
  audit: Array<Record<string, unknown>>;
}

export function emptyStore(overrides: Partial<FakeStore> = {}): FakeStore {
  return {
    role: "developer",
    skills: [],
    skillVersions: [],
    providerConnections: [],
    orgProviderConnections: [],
    userModelPreferences: [],
    orgModelPreferences: [],
    runs: [],
    runAttachments: [],
    runArtifacts: [],
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
const USER_MODEL_PREF_KEYS = ["userId"];
// Nothing distinguishes org rows in a single-org fake (every row shares the org id) — empty keys
// mean match-all; the service's JS re-filter is the real guard.
const ORG_MODEL_PREF_KEYS: string[] = [];
const RUN_KEYS = ["id", "skillId", "creatorId"];
const RUN_ATTACHMENT_KEYS = ["runId", "id"];
const RUN_ARTIFACT_KEYS = ["runId", "id"];

function runDefaults(values: Record<string, unknown>): FakeRunRow {
  return {
    id: crypto.randomUUID(),
    skillVersion: null,
    status: "starting",
    statusDetail: null,
    sandboxName: null,
    sandboxId: null,
    sandboxDomain: null,
    goldenSnapshotId: null,
    opencodeVersion: null,
    opencodeSessionId: null,
    serverPasswordEnc: null,
    timeoutMs: 300000,
    transcript: [],
    warnings: [],
    transcriptEventSequence: 0,
    transcriptUpdatedAt: null,
    lastActiveAt: null,
    frozenAt: null,
    sandboxCleanedAt: null,
    cleanupLeaseOwner: null,
    cleanupLeaseExpiresAt: null,
    cleanupAttempt: 0,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...values,
  } as unknown as FakeRunRow;
}

export function fakeRunsDb(store: FakeStore): Db {
  function filterRows<T extends Record<string, unknown>>(rows: T[], keys: string[], cond: unknown): T[] {
    const distinct = distinctOf(rows, keys);
    return rows.filter((row) => matches(keys.map((k) => row[k]), distinct, cond));
  }

  function selectFrom(projection: Record<string, unknown> | undefined, table: unknown) {
    const resolveRows = async (cond: unknown): Promise<unknown[]> => {
      if (table === schema.skillRuns) {
        return filterRows(store.runs as unknown as Record<string, unknown>[], RUN_KEYS, cond);
      }
      if (table === schema.skillRunAttachments) {
        return filterRows(store.runAttachments as unknown as Record<string, unknown>[], RUN_ATTACHMENT_KEYS, cond);
      }
      if (table === schema.skillRunArtifacts) {
        return filterRows(store.runArtifacts as unknown as Record<string, unknown>[], RUN_ARTIFACT_KEYS, cond);
      }
      return resolveOtherRows(cond);
    };
    const chain = {
      innerJoin: () => chain,
      leftJoin: () => chain,
      // Selects on run tables support the trailing `.orderBy(...)` the service chains on.
      where: (cond: unknown) => {
        const promise = resolveRows(cond);
        return Object.assign(promise, {
          orderBy: () => promise,
        }) as Promise<unknown[]> & { orderBy: () => Promise<unknown[]> };
      },
    };
    async function resolveOtherRows(cond: unknown): Promise<unknown[]> {
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
        if (table === schema.userModelPreferences) {
          return filterRows(store.userModelPreferences as unknown as Record<string, unknown>[], USER_MODEL_PREF_KEYS, cond);
        }
        if (table === schema.orgModelPreferences) {
          return filterRows(store.orgModelPreferences as unknown as Record<string, unknown>[], ORG_MODEL_PREF_KEYS, cond);
        }
        throw new Error("fakeRunsDb: unexpected select target");
    }
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
        if (table === schema.skillRuns) {
          const rows = list.map((v) => runDefaults(v));
          store.runs.push(...rows);
          return {
            returning: async () => rows,
            then: (resolve: (value: unknown) => void) => resolve(rows),
          };
        }
        if (table === schema.skillRunAttachments) {
          store.runAttachments.push(
            ...list.map(
              (v) =>
                ({
                  id: crypto.randomUUID(),
                  createdAt: new Date(),
                  ...v,
                }) as FakeRunAttachmentRow,
            ),
          );
          return Promise.resolve();
        }
        if (table === schema.skillRunArtifacts) {
          store.runArtifacts.push(
            ...list.map(
              (v) =>
                ({
                  id: crypto.randomUUID(),
                  vanishId: null,
                  contentType: null,
                  expiresAt: null,
                  publishedAt: new Date(),
                  ...v,
                }) as FakeRunArtifactRow,
            ),
          );
          return Promise.resolve();
        }
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
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...v,
                  } as unknown as FakeProviderConnectionRow);
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
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...v,
                  } as unknown as FakeOrgProviderConnectionRow);
              }
            },
          };
        }
        if (table === schema.userModelPreferences) {
          return {
            onConflictDoUpdate: async (opts: { set: Record<string, unknown> }) => {
              for (const v of list) {
                const existing = store.userModelPreferences.find(
                  (r) => r.orgId === v.orgId && r.userId === v.userId,
                );
                if (existing) Object.assign(existing, opts.set);
                else
                  store.userModelPreferences.push({
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...v,
                  } as FakeUserModelPreferencesRow);
              }
            },
          };
        }
        if (table === schema.orgModelPreferences) {
          return {
            onConflictDoUpdate: async (opts: { set: Record<string, unknown> }) => {
              for (const v of list) {
                const existing = store.orgModelPreferences.find((r) => r.orgId === v.orgId);
                if (existing) Object.assign(existing, opts.set);
                else
                  store.orgModelPreferences.push({
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...v,
                  } as FakeOrgModelPreferencesRow);
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
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (cond: unknown) => {
          if (table === schema.skillRuns) {
            for (const row of filterRows(store.runs as unknown as Record<string, unknown>[], RUN_KEYS, cond)) {
              Object.assign(row, patch);
            }
            return;
          }
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

/** Passthrough tenant runner backed by the same fake db. */
export function fakeTenantRunner(database: Db): import("../src/skillRuns").TenantRunner {
  return async (_input, fn) => fn(database);
}
