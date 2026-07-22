import { sql } from "@companion/db";

/**
 * Better Auth secondary storage backed by PostgreSQL.
 *
 * Agent Auth uses this store for JTI replay protection and JWKS TTLs. Better
 * Auth's rate limiter uses the same atomic counter implementation, which keeps
 * the limits effective across API replicas and in local development.
 *
 * The `agent_auth_ephemeral` table is deliberately separate from Better
 * Auth's identity tables: every row is short-lived infrastructure state and
 * can be removed once `expires_at` has passed.
 */
export const postgresAgentAuthStorage = {
  async get(key: string): Promise<string | null> {
    const rows = await sql<{ value: string }[]>`
      select value
      from agent_auth_ephemeral
      where key = ${key}
        and (expires_at is null or expires_at > now())
      limit 1
    `;
    return rows[0]?.value ?? null;
  },

  async getAndDelete(key: string): Promise<string | null> {
    const rows = await sql<{ value: string; expires_at: Date | string | null }[]>`
      delete from agent_auth_ephemeral
      where key = ${key}
      returning value, expires_at
    `;
    const row = rows[0];
    if (!row) return null;
    const expiresAt = row.expires_at instanceof Date
      ? row.expires_at.getTime()
      : row.expires_at == null
        ? null
        : new Date(row.expires_at).getTime();
    return expiresAt == null || (Number.isFinite(expiresAt) && expiresAt > Date.now()) ? row.value : null;
  },

  async set(key: string, value: string, ttl?: number): Promise<void> {
    const safeTtl = ttl && Number.isFinite(ttl) && ttl > 0 ? Math.ceil(ttl) : null;
    // JTI keys are intentionally unique, so expired values would otherwise
    // accumulate forever. The expiry index keeps this sweep bounded.
    await sql`delete from agent_auth_ephemeral where expires_at is not null and expires_at <= now()`;
    if (key.startsWith("agent-auth:jti:")) {
      // The plugin performs has()+add(). Make add itself an atomic claim so two API replicas cannot
      // both accept the same JTI in the gap between those calls. A conflict on a live row rejects the
      // second request; an expired row may be reclaimed.
      const claimed = await sql<{ key: string }[]>`
        insert into agent_auth_ephemeral (key, value, expires_at, updated_at)
        values (
          ${key},
          ${value},
          case when ${safeTtl}::integer is null then null else now() + (${safeTtl}::integer * interval '1 second') end,
          now()
        )
        on conflict (key) do update
        set value = excluded.value,
            expires_at = excluded.expires_at,
            updated_at = now()
        where agent_auth_ephemeral.expires_at is not null
          and agent_auth_ephemeral.expires_at <= now()
        returning key
      `;
      if (!claimed[0]) throw new Error("Agent Auth JTI was already consumed");
      return;
    }
    await sql`
      insert into agent_auth_ephemeral (key, value, expires_at, updated_at)
      values (
        ${key},
        ${value},
        case when ${safeTtl}::integer is null then null else now() + (${safeTtl}::integer * interval '1 second') end,
        now()
      )
      on conflict (key) do update
      set value = excluded.value,
          expires_at = excluded.expires_at,
          updated_at = now()
    `;
  },

  async increment(key: string, ttl: number): Promise<number> {
    const safeTtl = Number.isFinite(ttl) && ttl > 0 ? Math.ceil(ttl) : 1;
    const rows = await sql<{ value: string }[]>`
      insert into agent_auth_ephemeral (key, value, expires_at, updated_at)
      values (${key}, '1', now() + (${safeTtl}::integer * interval '1 second'), now())
      on conflict (key) do update
      set value = case
            when agent_auth_ephemeral.expires_at is not null
              and agent_auth_ephemeral.expires_at <= now()
            then '1'
            else ((agent_auth_ephemeral.value)::bigint + 1)::text
          end,
          expires_at = case
            when agent_auth_ephemeral.expires_at is not null
              and agent_auth_ephemeral.expires_at <= now()
            then excluded.expires_at
            else agent_auth_ephemeral.expires_at
          end,
          updated_at = now()
      returning value
    `;
    return Number.parseInt(rows[0]?.value ?? "1", 10);
  },

  async delete(key: string): Promise<void> {
    await sql`delete from agent_auth_ephemeral where key = ${key}`;
  },
};
