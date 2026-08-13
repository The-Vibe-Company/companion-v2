import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractRuntimeRoleGrantBlock, resolveRuntimeRoleGrantsFile } from "../../src/migrate";
import {
  CompanionRuntimeTransitionError,
  CompanionShareForbiddenError,
  CompanionNotFoundError,
  claimCompanionRuntimeStart,
  claimCompanionRuntimeStop,
  inviteCompanionMember,
  listCompanionShares,
  recordCompanionPiProjection,
  revokeCompanionMember,
  updateCompanionMemberRole,
  updateCompanionObservation,
} from "@companion/core";
import { withTenantContext } from "@companion/db";
import {
  createIntegrationFixture,
  integrationSql,
  seedSkill,
  type IntegrationFixture,
} from "./testDatabase";

/**
 * Product promise: PostgreSQL enforces organization isolation for the non-bypass API role, while
 * creator-only personal-skill access remains an additional service-layer gate.
 *
 * Regression caught: dropping FORCE RLS or the organization predicate.
 *
 * Why integrated: table owners and mocked query builders cannot prove PostgreSQL policy behavior.
 *
 * Failure proof: removing the org predicate makes the cross-tenant query return the outsider's skill.
 */
describe("Skills Hub PostgreSQL isolation", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const apiRole = `companion_api_${suffix}`;
  const workerRole = `companion_worker_${suffix}`;
  let fixture: IntegrationFixture;
  let personalSlug: string;
  let orgSlug: string;
  let otherOrgSlug: string;
  const companionId = randomUUID();

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    personalSlug = `private-${fixture.suffix}`;
    orgSlug = `org-${fixture.suffix}`;
    otherOrgSlug = `other-${fixture.suffix}`;
    await seedSkill({ orgId: fixture.orgA, creator: fixture.owner, slug: personalSlug, scope: "personal" });
    await seedSkill({ orgId: fixture.orgA, creator: fixture.owner, slug: orgSlug, scope: "org" });
    await seedSkill({ orgId: fixture.orgB, creator: fixture.outsider, slug: otherOrgSlug, scope: "org" });
    await integrationSql`
      insert into companions (id, org_id, owner_id, name)
      values (${companionId}, ${fixture.orgA}, ${fixture.owner.id}, 'RLS companion')
    `;
    await integrationSql.unsafe(`create role ${apiRole} login nosuperuser nobypassrls noinherit`);
    await integrationSql.unsafe(`create role ${workerRole} login nosuperuser nobypassrls noinherit`);
    const grants = extractRuntimeRoleGrantBlock(await readFile(await resolveRuntimeRoleGrantsFile(), "utf8"));
    await integrationSql.begin(async (tx) => {
      await tx`select set_config('companion.api_role', ${apiRole}, true)`;
      await tx`select set_config('companion.worker_role', ${workerRole}, true)`;
      await tx.unsafe(grants);
    });
  });

  afterAll(async () => {
    await integrationSql`delete from companions where id = ${companionId}`;
    await fixture.cleanup();
    await integrationSql.unsafe(`drop owned by ${apiRole}`);
    await integrationSql.unsafe(`drop owned by ${workerRole}`);
    await integrationSql.unsafe(`drop role ${apiRole}`);
    await integrationSql.unsafe(`drop role ${workerRole}`);
  });

  async function visibleSlugs(orgId: string, userId: string): Promise<string[]> {
    return integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${orgId}, true), set_config('app.user_id', ${userId}, true)`;
      const rows = await tx<Array<{ slug: string }>>`select slug from skills order by slug`;
      return rows.map((row) => row.slug);
    });
  }

  it("shows an owner their personal and org skills but hides both from other tenants", async () => {
    expect(await visibleSlugs(fixture.orgA, fixture.owner.id)).toEqual([orgSlug, personalSlug].sort());
    expect(await visibleSlugs(fixture.orgB, fixture.outsider.id)).toEqual([otherOrgSlug]);
  });

  it("enforces Companion member and workspace ACL roles in PostgreSQL", async () => {
    const initiallyVisible = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      return tx<Array<{ id: string }>>`select id from companions`;
    });
    expect(initiallyVisible).toEqual([]);

    await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.owner.id}, true)`;
      await tx`
        insert into companion_member_access (
          org_id, companion_id, user_id, owner_id, role, granted_by
        ) values (
          ${fixture.orgA}, ${companionId}, ${fixture.admin.id}, ${fixture.owner.id}, 'viewer',
          ${fixture.owner.id}
        )
      `;
      await tx`
        insert into companion_transcript_entries (
          org_id, companion_id, event_id, ordinal, role, content
        ) values (
          ${fixture.orgA}, ${companionId}, 'event-1', 0, 'assistant', 'Control-plane message'
        )
      `;
      await tx`
        insert into companion_threads (org_id, companion_id, next_ordinal)
        values (${fixture.orgA}, ${companionId}, 1)
      `;
    });

    const viewerResult = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      const visible = await tx<Array<{ id: string }>>`select id from companions`;
      const transcript = await tx<Array<{ content: string }>>`
        select content from companion_transcript_entries where companion_id = ${companionId}
      `;
      const thread = await tx<Array<{ next_ordinal: number }>>`
        select next_ordinal from companion_threads where companion_id = ${companionId}
      `;
      const threadWrite = await tx<Array<{ companion_id: string }>>`
        update companion_threads set next_ordinal = 9 where companion_id = ${companionId}
        returning companion_id
      `;
      const updated = await tx<Array<{ id: string }>>`
        update companions set runtime_state = 'running' where id = ${companionId} returning id
      `;
      return { visible, transcript, thread, threadWrite, updated };
    });
    expect(viewerResult.visible).toEqual([{ id: companionId }]);
    expect(viewerResult.transcript).toEqual([{ content: "Control-plane message" }]);
    // A Viewer reads the thread read model but cannot advance the ordinals a send would consume.
    expect(viewerResult.thread).toEqual([{ next_ordinal: 1 }]);
    expect(viewerResult.threadWrite).toEqual([]);
    expect(viewerResult.updated).toEqual([]);

    await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.owner.id}, true)`;
      await tx`
        update companion_member_access set role = 'editor'
        where companion_id = ${companionId} and user_id = ${fixture.admin.id}
      `;
      await tx`
        insert into companion_workspace_access (
          org_id, companion_id, owner_id, role, granted_by
        ) values (
          ${fixture.orgA}, ${companionId}, ${fixture.owner.id}, 'editor', ${fixture.owner.id}
        )
      `;
    });

    const editorUpdate = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      return tx<Array<{ id: string }>>`
        update companions set runtime_state = 'running' where id = ${companionId} returning id
      `;
    });
    expect(editorUpdate).toEqual([{ id: companionId }]);

    const editorThreadWrite = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      return tx<Array<{ next_ordinal: number }>>`
        update companion_threads set next_ordinal = 2 where companion_id = ${companionId}
        returning next_ordinal
      `;
    });
    expect(editorThreadWrite).toEqual([{ next_ordinal: 2 }]);

    const workspaceEditorUpdate = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.developer.id}, true)`;
      return tx<Array<{ id: string }>>`
        update companions set runtime_state = 'stopped' where id = ${companionId} returning id
      `;
    });
    expect(workspaceEditorUpdate).toEqual([{ id: companionId }]);

    await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.owner.id}, true)`;
      await tx`
        update companion_member_access set role = 'viewer'
        where companion_id = ${companionId} and user_id = ${fixture.admin.id}
      `;
    });
    const overriddenViewerUpdate = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      return tx<Array<{ id: string }>>`
        update companions set runtime_state = 'running' where id = ${companionId} returning id
      `;
    });
    expect(overriddenViewerUpdate).toEqual([]);
    await expect(integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      await tx`
        insert into companion_transcript_entries (
          org_id, companion_id, event_id, ordinal, role, content
        ) values (
          ${fixture.orgA}, ${companionId}, 'viewer-write', 1, 'user', 'must be rejected'
        )
      `;
    })).rejects.toThrow();

    const outsiderVisible = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgB}, true), set_config('app.user_id', ${fixture.outsider.id}, true)`;
      const companionRows = await tx<Array<{ id: string }>>`select id from companions`;
      const threadRows = await tx<Array<{ companion_id: string }>>`select companion_id from companion_threads`;
      return { companionRows, threadRows };
    });
    expect(outsiderVisible.companionRows).toEqual([]);
    expect(outsiderVisible.threadRows).toEqual([]);
  });

  it("lets admins manage provider ciphertext while members see metadata only within the tenant", async () => {
    await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      await tx`
        insert into companion_provider_connections (
          org_id, provider_id, auth_method, ciphertext, iv, auth_tag,
          wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
        ) values (
          ${fixture.orgA}, 'anthropic', 'api_key', 'ciphertext', 'iv', 'tag',
          'dek', 'wrap-iv', 'wrap-tag', 'key-id', ${fixture.admin.id}
        )
      `;
    });

    const developerVisible = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.developer.id}, true)`;
      return tx<Array<{ provider_id: string; auth_method: string }>>`
        select provider_id, auth_method from companion_provider_connections
      `;
    });
    expect(developerVisible).toEqual([{ provider_id: "anthropic", auth_method: "api_key" }]);

    await expect(integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.developer.id}, true)`;
      await tx`
        insert into companion_provider_connections (
          org_id, provider_id, auth_method, ciphertext, iv, auth_tag,
          wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
        ) values (
          ${fixture.orgA}, 'zai', 'api_key', 'ciphertext', 'iv', 'tag',
          'dek', 'wrap-iv', 'wrap-tag', 'key-id', ${fixture.developer.id}
        )
      `;
    })).rejects.toThrow();

    const outsiderVisible = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgB}, true), set_config('app.user_id', ${fixture.outsider.id}, true)`;
      return tx<Array<{ provider_id: string }>>`select provider_id from companion_provider_connections`;
    });
    expect(outsiderVisible).toEqual([]);
  });

  it("enforces owner-only invite, role change, and revoke services", async () => {
    const ownerInput = {
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
    };
    const invited = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => inviteCompanionMember({
        ...ownerInput,
        email: fixture.admin.email,
        role: "editor",
        database,
      }),
    );
    expect(invited.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: fixture.admin.id, role: "editor" }),
    ]));

    const changed = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => updateCompanionMemberRole({
        ...ownerInput,
        userId: fixture.admin.id,
        role: "viewer",
        database,
      }),
    );
    expect(changed.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: fixture.admin.id, role: "viewer" }),
    ]));

    await expect(withTenantContext(
      { orgId: fixture.orgA, userId: fixture.admin.id },
      (database) => listCompanionShares({
        actor: fixture.admin,
        orgId: fixture.orgA,
        companionId,
        database,
      }),
    )).rejects.toBeInstanceOf(CompanionShareForbiddenError);

    await expect(withTenantContext(
      { orgId: fixture.orgB, userId: fixture.outsider.id },
      (database) => listCompanionShares({
        actor: fixture.outsider,
        orgId: fixture.orgB,
        companionId,
        database,
      }),
    )).rejects.toBeInstanceOf(CompanionNotFoundError);

    const revoked = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => revokeCompanionMember({
        ...ownerInput,
        userId: fixture.admin.id,
        database,
      }),
    );
    expect(revoked.members).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: fixture.admin.id }),
    ]));
  });

  it("CAS-claims lifecycle transitions and keeps live observations from clobbering them", async () => {
    await integrationSql`
      update companions
      set box_id = 'bx_23456789', runtime_state = 'stopped', daemon_state = 'stopped'
      where id = ${companionId}
    `;
    const input = {
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
    };

    const started = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => claimCompanionRuntimeStart({ ...input, database }),
    );
    expect(started.runtime.state).toBe("provisioning");
    await expect(withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => claimCompanionRuntimeStart({ ...input, database }),
    )).rejects.toBeInstanceOf(CompanionRuntimeTransitionError);

    const observed = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => updateCompanionObservation({
        ...input,
        patch: {
          runtimeState: "stopped",
          daemonState: "stopped",
          desktopAvailable: false,
          observedAt: new Date(),
        },
        database,
      }),
    );
    expect(observed.runtime.state).toBe("provisioning");

    await integrationSql`
      update companions set runtime_state = 'running', daemon_state = 'running'
      where id = ${companionId}
    `;
    const stopped = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => claimCompanionRuntimeStop({ ...input, database }),
    );
    expect(stopped.runtime.state).toBe("stopping");
    await expect(withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => claimCompanionRuntimeStop({ ...input, database }),
    )).rejects.toBeInstanceOf(CompanionRuntimeTransitionError);
  });

  it("only rewinds the Pi log offset when Pi's log itself rewound", async () => {
    const project = (piLogOffset: number, piLogRewound?: boolean) => withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => recordCompanionPiProjection({
        actor: fixture.owner,
        orgId: fixture.orgA,
        companionId,
        entries: [],
        piLogOffset,
        piLogRewound,
        database,
      }),
    );
    const storedOffset = async () => {
      const [row] = await integrationSql<Array<{ pi_log_offset: string }>>`
        select pi_log_offset from companion_threads where companion_id = ${companionId}
      `;
      return Number(row?.pi_log_offset);
    };

    await project(4096);
    // A slower overlapping sync read less of the log; it must not make the next sync reproject it.
    await project(512);
    expect(await storedOffset()).toBe(4096);

    // A restarted Box truncates the log, so that read owns the offset and replays from the start.
    await project(128, true);
    expect(await storedOffset()).toBe(128);
  });
});
