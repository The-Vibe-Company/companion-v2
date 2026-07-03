import { schema, type Db } from "@companion/db";
import type { TenantRunner } from "../src/agents";

/**
 * A hand-rolled fake database for the agents suites ONLY (never shared with the skill fakeDbs —
 * see the project rule about fakeDb fragility). It stores plain rows per table and answers the
 * exact query shapes `src/agents.ts` issues, filtering rows generically: every scalar bound in a
 * drizzle condition that matches a DISTINGUISHING value of the table (ids, slugs, keys) must match
 * the row; params nothing in the table distinguishes on (e.g. the org id every row shares) are
 * ignored.
 */

export type FakeAgentRow = typeof schema.agents.$inferSelect;
export type FakeAgentSkillRow = typeof schema.agentSkills.$inferSelect;
export type FakeAgentSecretRow = typeof schema.agentSecrets.$inferSelect;

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

export type FakeProviderConnectionRow = typeof schema.userProviderConnections.$inferSelect;

export interface FakeStore {
  role: "owner" | "admin" | "developer" | null;
  agents: FakeAgentRow[];
  agentSkills: FakeAgentSkillRow[];
  agentSecrets: FakeAgentSecretRow[];
  skills: FakeSkillRow[];
  skillVersions: FakeSkillVersionRow[];
  providerConnections: FakeProviderConnectionRow[];
  audit: Array<Record<string, unknown>>;
}

export function emptyStore(overrides: Partial<FakeStore> = {}): FakeStore {
  return {
    role: "developer",
    agents: [],
    agentSkills: [],
    agentSecrets: [],
    skills: [],
    skillVersions: [],
    providerConnections: [],
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

const AGENT_KEYS = ["id", "slug"];
const AGENT_SKILL_KEYS = ["agentId", "skillId"];
const AGENT_SECRET_KEYS = ["agentId", "key"];
const SKILL_KEYS = ["id", "slug"];
const SKILL_VERSION_KEYS = ["skillId", "id"];
const PROVIDER_CONN_KEYS = ["userId", "provider"];

export function fakeAgentsDb(store: FakeStore): Db {
  function filterRows<T extends Record<string, unknown>>(rows: T[], keys: string[], cond: unknown): T[] {
    const distinct = distinctOf(rows, keys);
    return rows.filter((row) => matches(keys.map((k) => row[k]), distinct, cond));
  }

  function selectFrom(projection: Record<string, unknown> | undefined, table: unknown) {
    const chain = {
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: async (cond: unknown): Promise<unknown[]> => {
        if (table === schema.agents) {
          return filterRows(store.agents as unknown as Record<string, unknown>[], AGENT_KEYS, cond);
        }
        if (table === schema.agentSecrets) {
          const rows = filterRows(store.agentSecrets as unknown as Record<string, unknown>[], AGENT_SECRET_KEYS, cond);
          if (projection && "key" in projection && Object.keys(projection).length === 1) {
            return rows.map((r) => ({ key: r.key }));
          }
          return rows;
        }
        if (table === schema.agentSkills) {
          const pins = filterRows(store.agentSkills as unknown as Record<string, unknown>[], AGENT_SKILL_KEYS, cond);
          return pins.map((pin) => {
            const skill = store.skills.find((s) => s.id === pin.skillId);
            const current = skill?.currentVersionId
              ? store.skillVersions.find((v) => v.id === skill.currentVersionId)
              : null;
            if (projection && "pin" in projection && !("slug" in projection)) {
              return { pin };
            }
            return { pin, slug: skill?.slug ?? "?", currentVersion: current?.version ?? null };
          });
        }
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
        throw new Error("fakeAgentsDb: unexpected select target");
      },
    };
    return chain;
  }

  function agentDefaults(values: Record<string, unknown>): FakeAgentRow {
    return {
      id: crypto.randomUUID(),
      clientLabel: null,
      groupLabel: null,
      instructions: "",
      region: "iad1",
      lifecycle: "provisioning",
      sandboxName: null,
      sandboxId: null,
      sandboxDomain: null,
      goldenSnapshotId: null,
      opencodeVersion: null,
      provisionAttempt: 1,
      provisionSteps: [],
      provisionError: null,
      pendingOp: null,
      serverPasswordEnc: null,
      sessionsCache: [],
      lastResumeMs: null,
      timeoutMs: 300000,
      lastActiveAt: null,
      pausedAt: null,
      createdAt: new Date("2026-07-01T00:00:00Z"),
      updatedAt: new Date("2026-07-01T00:00:00Z"),
      scope: "personal",
      ...values,
    } as unknown as FakeAgentRow;
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
        if (table === schema.agents) {
          const rows = list.map((v) => agentDefaults(v));
          store.agents.push(...rows);
          return {
            returning: async () => rows,
            onConflictDoUpdate: () => Promise.resolve(),
            then: (resolve: (value: unknown) => void) => resolve(rows),
          };
        }
        if (table === schema.agentSkills) {
          store.agentSkills.push(
            ...list.map(
              (v) =>
                ({
                  position: 0,
                  pushedAt: null,
                  createdAt: new Date(),
                  ...v,
                }) as FakeAgentSkillRow,
            ),
          );
          return Promise.resolve();
        }
        if (table === schema.agentSecrets) {
          const upsert = {
            onConflictDoUpdate: async (opts: { set: Record<string, unknown> }) => {
              for (const v of list) {
                const existing = store.agentSecrets.find((s) => s.agentId === v.agentId && s.key === v.key);
                if (existing) Object.assign(existing, opts.set);
                else
                  store.agentSecrets.push({
                    keyVersion: 1,
                    createdBy: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...v,
                  } as FakeAgentSecretRow);
              }
            },
            then: (resolve: (value: unknown) => void) => {
              store.agentSecrets.push(
                ...list.map(
                  (v) =>
                    ({
                      keyVersion: 1,
                      createdBy: null,
                      createdAt: new Date(),
                      updatedAt: new Date(),
                      ...v,
                    }) as FakeAgentSecretRow,
                ),
              );
              resolve(undefined);
            },
          };
          return upsert;
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
                    keyVersion: 1,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...v,
                  } as FakeProviderConnectionRow);
              }
            },
          };
        }
        if (table === schema.auditLog) {
          store.audit.push(...list);
          return Promise.resolve();
        }
        throw new Error("fakeAgentsDb: unexpected insert target");
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (cond: unknown) => {
          if (table === schema.agents) {
            for (const row of filterRows(store.agents as unknown as Record<string, unknown>[], AGENT_KEYS, cond)) {
              Object.assign(row, patch);
            }
            return;
          }
          if (table === schema.agentSkills) {
            for (const row of filterRows(
              store.agentSkills as unknown as Record<string, unknown>[],
              AGENT_SKILL_KEYS,
              cond,
            )) {
              Object.assign(row, patch);
            }
            return;
          }
          throw new Error("fakeAgentsDb: unexpected update target");
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (cond: unknown) => {
        if (table === schema.agents) {
          const gone = new Set(
            filterRows(store.agents as unknown as Record<string, unknown>[], AGENT_KEYS, cond).map(
              (r) => r.id as string,
            ),
          );
          store.agents = store.agents.filter((r) => !gone.has(r.id));
          store.agentSkills = store.agentSkills.filter((r) => !gone.has(r.agentId));
          store.agentSecrets = store.agentSecrets.filter((r) => !gone.has(r.agentId));
          return;
        }
        if (table === schema.agentSecrets) {
          const doomed = filterRows(
            store.agentSecrets as unknown as Record<string, unknown>[],
            AGENT_SECRET_KEYS,
            cond,
          ) as unknown as FakeAgentSecretRow[];
          store.agentSecrets = store.agentSecrets.filter((r) => !doomed.includes(r));
          return;
        }
        if (table === schema.userProviderConnections) {
          const doomed = filterRows(
            store.providerConnections as unknown as Record<string, unknown>[],
            PROVIDER_CONN_KEYS,
            cond,
          ) as unknown as FakeProviderConnectionRow[];
          store.providerConnections = store.providerConnections.filter((r) => !doomed.includes(r));
          return;
        }
        throw new Error("fakeAgentsDb: unexpected delete target");
      },
    }),
  };

  return handle as unknown as Db;
}

/** Passthrough tenant runner backed by the same fake db. */
export function fakeTenantRunner(database: Db): TenantRunner {
  return async (_input, fn) => fn(database);
}
