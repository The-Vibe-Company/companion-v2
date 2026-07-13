import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.RUN_SKILL_DB_INTEGRATION === "1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://companion:companion@127.0.0.1:5432/companion";

describe.skipIf(!enabled)("RunSkill PostgreSQL security and queue boundary", () => {
  const sql = postgres(databaseUrl, { max: 8 });
  const suffix = randomUUID();
  const orgA = randomUUID();
  const orgB = randomUUID();
  const skillId = randomUUID();
  const versionId = randomUUID();
  const configId = randomUUID();
  const runId = randomUUID();
  const terminalRunId = randomUUID();
  const cleanupRunId = randomUUID();
  const attachmentId = randomUUID();
  const artifactId = randomUUID();
  const owner = { id: `run-owner-${suffix}`, email: `run-owner-${suffix}@example.test` };
  const admin = { id: `run-admin-${suffix}`, email: `run-admin-${suffix}@example.test` };
  const outsider = { id: `run-outsider-${suffix}`, email: `run-outsider-${suffix}@example.test` };
  const rlsRole = `companion_run_rls_${suffix.replaceAll("-", "").slice(0, 20)}`;

  async function countsFor(orgId: string, userId: string): Promise<Record<string, number>> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      await tx`select set_config('app.org_id', ${orgId}, true), set_config('app.user_id', ${userId}, true)`;
      const tables = [
        "skill_run_configs",
        "skill_run_config_variables",
        "skill_runs",
        "skill_run_skills",
        "skill_run_secret_inputs",
        "skill_run_variable_inputs",
        "skill_run_jobs",
        "skill_run_prompts",
        "skill_run_events",
        "skill_run_attachments",
        "skill_run_artifacts",
      ] as const;
      const result: Record<string, number> = {};
      for (const table of tables) {
        const rows = await tx.unsafe<{ count: number }[]>(`select count(*)::int as count from "${table}"`);
        result[table] = rows[0]?.count ?? 0;
      }
      return result;
    });
  }

  async function claim(workerId: string, leaseSeconds = 30): Promise<Array<{ id: string; attempt: number }>> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ id: string; attempt: number }[]>`
        select id, attempt
        from companion_claim_skill_run_jobs(${workerId}, 1, ${leaseSeconds})
      `;
    });
  }

  async function claimCleanup(workerId: string, leaseSeconds = 30): Promise<Array<{
    runId: string;
    cleanupAttempt: number;
  }>> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ runId: string; cleanupAttempt: number }[]>`
        select run_id::text as "runId", cleanup_attempt as "cleanupAttempt"
        from companion_claim_skill_run_cleanups(${workerId}, 1, ${leaseSeconds})
      `;
    });
  }

  async function completeCleanup(workerId: string): Promise<boolean> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      const rows = await tx<{ completed: boolean }[]>`
        select companion_complete_skill_run_cleanup(
          ${orgA}::uuid,
          ${cleanupRunId}::uuid,
          ${workerId}
        ) as completed
      `;
      return rows[0]?.completed ?? false;
    });
  }

  beforeAll(async () => {
    await sql`
      insert into "user" (id, name, email, email_verified)
      values
        (${owner.id}, 'Run Owner', ${owner.email}, true),
        (${admin.id}, 'Run Admin', ${admin.email}, true),
        (${outsider.id}, 'Run Outsider', ${outsider.email}, true)
    `;
    await sql`
      insert into organizations (id, name, slug)
      values
        (${orgA}::uuid, 'Run integration A', ${`run-integration-a-${suffix}`}),
        (${orgB}::uuid, 'Run integration B', ${`run-integration-b-${suffix}`})
    `;
    await sql`
      insert into memberships (org_id, user_id, org_role)
      values
        (${orgA}::uuid, ${owner.id}, 'owner'),
        (${orgA}::uuid, ${admin.id}, 'admin'),
        (${orgB}::uuid, ${outsider.id}, 'owner')
    `;
    await sql`
      insert into skills (id, org_id, slug, description, creator_id, scope)
      values (${skillId}::uuid, ${orgA}::uuid, ${`run-test-${suffix}`}, 'Run test skill', ${owner.id}, 'org')
    `;
    await sql`
      insert into skill_versions
        (id, org_id, skill_id, version, frontmatter, body, size_bytes, checksum, storage_path, created_by)
      values
        (${versionId}::uuid, ${orgA}::uuid, ${skillId}::uuid, '1.0.0', '{}', '', 1,
         ${`sha256:${"a".repeat(64)}`}, ${`${orgA}/run-test/1.0.0.tar.gz`}, ${owner.id})
    `;
    await sql`update skills set current_version_id = ${versionId}::uuid where id = ${skillId}::uuid`;
    await sql`
      insert into skill_run_configs (id, org_id, skill_id, creator_id, name, model)
      values (${configId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, 'Private config', 'openai/gpt-5')
    `;
    await sql`
      insert into skill_run_config_variables (org_id, config_id, skill_id, env_key, value)
      values (${orgA}::uuid, ${configId}::uuid, ${skillId}::uuid, 'OUTPUT_FORMAT', 'json')
    `;
    for (const [id, idempotency, status, age] of [
      [runId, "integration-active", "queued", "0 hours"],
      [terminalRunId, "integration-terminal", "frozen", "25 hours"],
    ] as const) {
      await sql`
        insert into skill_runs
          (id, org_id, skill_id, creator_id, skill_version_id, skill_version, idempotency_key,
           payload_hash, model, prompt, status, phase, frozen_at, sandbox_cleaned_at, updated_at)
        values
          (${id}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, ${versionId}::uuid, '1.0.0',
           ${idempotency}, ${"b".repeat(64)}, 'openai/gpt-5', 'integration prompt', ${status}::skill_run_status,
           ${status === "frozen" ? "complete" : "queued"}::skill_run_phase,
           ${status === "frozen" ? sql`now() - interval '25 hours'` : null},
           ${status === "frozen" ? sql`now() - interval '25 hours'` : null},
           now() - ${age}::interval)
      `;
      await sql`
        insert into skill_run_events (org_id, run_id, sequence, type, payload, created_at)
        values (${orgA}::uuid, ${id}::uuid, 1, 'status', '{"state":"idle"}'::jsonb, now() - ${age}::interval)
      `;
    }
    await sql`
      insert into skill_runs
        (id, org_id, skill_id, creator_id, skill_version_id, skill_version, idempotency_key,
         payload_hash, model, prompt, status, phase, sandbox_name)
      values
        (${cleanupRunId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, ${versionId}::uuid,
         '1.0.0', 'integration-cleanup', ${"d".repeat(64)}, 'openai/gpt-5', 'cleanup prompt',
         'error', 'complete', ${`run-${cleanupRunId.slice(0, 8)}`})
    `;
    await sql`
      insert into skill_run_skills (org_id, run_id, skill_id, skill_version_id, is_root, mount_order)
      values (${orgA}::uuid, ${runId}::uuid, ${skillId}::uuid, ${versionId}::uuid, true, 0)
    `;
    await sql`
      insert into skill_run_secret_inputs
        (org_id, run_id, source_key, env_key, provenance, required)
      values (${orgA}::uuid, ${runId}::uuid, 'opencode-server-password', 'OPENCODE_SERVER_PASSWORD', 'runtime', true)
    `;
    await sql`
      insert into skill_run_variable_inputs (org_id, run_id, skill_id, env_key, value)
      values (${orgA}::uuid, ${runId}::uuid, ${skillId}::uuid, 'OUTPUT_FORMAT', 'json')
    `;
    await sql`
      insert into skill_run_jobs (org_id, run_id, creator_id)
      values (${orgA}::uuid, ${runId}::uuid, ${owner.id})
    `;
    await sql`
      insert into skill_run_prompts
        (org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id, prompt)
      values
        (${orgA}::uuid, ${runId}::uuid, 0, 'initial', 'integration-prompt', ${"c".repeat(64)}, ${randomUUID()}, 'prompt')
    `;
    await sql`
      insert into skill_run_attachments (id, org_id, run_id, file_name, content_type, byte_size, storage_key)
      values
        (${attachmentId}::uuid, ${orgA}::uuid, ${runId}::uuid, 'input.txt', 'text/plain', 1, ${`${orgA}/run-attachments/${attachmentId}`})
    `;
    await sql`
      insert into skill_run_artifacts (id, org_id, run_id, path, file_name, content_type, byte_size, url)
      values
        (${artifactId}::uuid, ${orgA}::uuid, ${runId}::uuid, 'result.txt', 'result.txt', 'text/plain', 1, 'https://example.test/result')
    `;

    await sql.unsafe(`create role ${rlsRole} nologin nosuperuser nobypassrls`);
    await sql.unsafe(`grant usage on schema public to ${rlsRole}`);
    await sql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${rlsRole}`);
    await sql.unsafe(`grant usage, select on all sequences in schema public to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_claim_skill_run_jobs(text, integer, integer) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_claim_skill_run_cleanups(text, integer, integer) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_complete_skill_run_cleanup(uuid, uuid, text) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_cleanup_skill_run_events(integer) to ${rlsRole}`);
  });

  afterAll(async () => {
    await sql`delete from organizations where id in (${orgA}::uuid, ${orgB}::uuid)`;
    await sql`delete from "user" where id in (${owner.id}, ${admin.id}, ${outsider.id})`;
    await sql.unsafe(`drop owned by ${rlsRole}`);
    await sql.unsafe(`drop role ${rlsRole}`);
    await sql.end();
  });

  it("keeps runs, configurations, and every child creator-only", async () => {
    const creator = await countsFor(orgA, owner.id);
    expect(Object.values(creator).every((count) => count >= 1)).toBe(true);
    expect(Object.values(await countsFor(orgA, admin.id)).every((count) => count === 0)).toBe(true);
    expect(Object.values(await countsFor(orgB, outsider.id)).every((count) => count === 0)).toBe(true);
  });

  it("claims a job once across workers and reclaims it only after lease expiry", async () => {
    const firstClaims = await Promise.all([claim("worker-a"), claim("worker-b")]);
    expect(firstClaims.flat()).toHaveLength(1);
    expect(firstClaims.flat()[0]).toMatchObject({ attempt: 1 });
    expect(await claim("worker-c")).toHaveLength(0);

    await sql`
      update skill_run_jobs
      set lease_expires_at = now() - interval '1 second', heartbeat_at = now() - interval '1 second'
      where org_id = ${orgA}::uuid and run_id = ${runId}::uuid
    `;
    const reclaimed = await claim("worker-c");
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ attempt: 2 });
  });

  it("leases terminal cleanup once and retries after a failed provider attempt", async () => {
    const firstClaims = await Promise.all([claimCleanup("cleanup-a"), claimCleanup("cleanup-b")]);
    expect(firstClaims.flat()).toEqual([{ runId: cleanupRunId, cleanupAttempt: 1 }]);
    expect(await completeCleanup("wrong-worker")).toBe(false);

    await sql`
      update skill_runs
      set cleanup_lease_expires_at = now() - interval '1 second'
      where org_id = ${orgA}::uuid and id = ${cleanupRunId}::uuid
    `;
    expect(await claimCleanup("cleanup-c")).toEqual([{ runId: cleanupRunId, cleanupAttempt: 2 }]);
    expect(await completeCleanup("cleanup-c")).toBe(true);

    const rows = await sql<{ cleaned: boolean; owner: string | null; attempt: number }[]>`
      select sandbox_cleaned_at is not null as cleaned,
             cleanup_lease_owner as owner,
             cleanup_attempt as attempt
      from skill_runs
      where org_id = ${orgA}::uuid and id = ${cleanupRunId}::uuid
    `;
    expect(rows).toEqual([{ cleaned: true, owner: null, attempt: 2 }]);
  });

  it("globally removes only terminal events older than 24 hours", async () => {
    const result = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      const rows = await tx<{ count: number }[]>`select companion_cleanup_skill_run_events(1000)::int as count`;
      const context = await tx<{ value: string }[]>`select current_setting('app.run_worker', true) as value`;
      return { count: rows[0]?.count ?? 0, context: context[0]?.value ?? "" };
    });
    expect(result).toEqual({ count: 1, context: "" });
    const events = await sql<{ runId: string }[]>`
      select run_id::text as "runId" from skill_run_events
      where org_id = ${orgA}::uuid order by run_id
    `;
    expect(events.map((event) => event.runId)).toEqual([runId]);
  });
});
