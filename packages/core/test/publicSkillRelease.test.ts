import { describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  clearSkillPublicVersion,
  setSkillPublicVersion,
  SkillPublicReleaseConflictError,
  SkillPublicReleaseForbiddenError,
} from "../src/services";

const actor = { id: "user-1", email: "ada@example.test", name: "Ada" };
const transport = { packageChecksum: `sha256:${"c".repeat(64)}`, packageSizeBytes: 321 };

function publicReleaseDb(input: {
  role?: "owner" | "admin" | "developer" | null;
  creatorId?: string;
  scope?: "org" | "personal";
  currentVersionId?: string;
  publicVersionId?: string | null;
  publicPackageChecksum?: string | null;
  publicPackageSizeBytes?: number | null;
  archived?: boolean;
  version?: string;
  versionName?: string;
  updateRows?: unknown[];
}) {
  const skill = {
    id: "skill-1",
    orgId: "org-1",
    slug: "review",
    shareToken: "share-token-1",
    creatorId: input.creatorId ?? actor.id,
    scope: input.scope ?? "org",
    currentVersionId: input.currentVersionId ?? "version-2",
    publicVersionId: input.publicVersionId ?? null,
    publicPackageChecksum:
      input.publicPackageChecksum !== undefined
        ? input.publicPackageChecksum
        : input.publicVersionId
          ? `sha256:${"a".repeat(64)}`
          : null,
    publicPackageSizeBytes:
      input.publicPackageSizeBytes !== undefined
        ? input.publicPackageSizeBytes
        : input.publicVersionId
          ? 111
          : null,
    publicReleasedAt: input.publicVersionId ? new Date("2026-07-01T00:00:00Z") : null,
    archivedAt: input.archived ? new Date() : null,
  };
  const targetVersion = {
    id: "version-2",
    orgId: "org-1",
    skillId: "skill-1",
    version: input.version ?? "2.0.0",
    frontmatter: JSON.stringify({ name: input.versionName ?? skill.slug, description: "Review", metadata: {} }),
  };
  const priorVersion = { ...targetVersion, id: skill.publicVersionId ?? "version-1", version: "1.0.0" };
  let versionLookup = 0;
  const returning = vi.fn(async () => input.updateRows ?? [{ id: skill.id }]);
  const values = vi.fn(async () => undefined);
  const updatePatches: Record<string, unknown>[] = [];
  const whereClauses: SQL[] = [];
  const database: Record<string, unknown> = {
    query: {
      memberships: { findFirst: vi.fn(async () => input.role === null ? undefined : ({ orgRole: input.role ?? "developer" })) },
      skills: { findFirst: vi.fn(async () => skill) },
      skillVersions: {
        findFirst: vi.fn(async () => versionLookup++ === 0 ? targetVersion : priorVersion),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        updatePatches.push(patch);
        return {
          where: vi.fn((clause: SQL) => {
            whereClauses.push(clause);
            return { returning };
          }),
        };
      }),
    })),
    insert: vi.fn(() => ({ values })),
  };
  database.transaction = vi.fn(async (fn: (tx: Db) => Promise<unknown>) => fn(database as unknown as Db));
  return { database: database as unknown as Db, returning, values, updatePatches, whereClauses };
}

describe("public skill release lifecycle", () => {
  it("pins the current immutable version and audits the previous release", async () => {
    const fake = publicReleaseDb({ role: "developer", creatorId: actor.id, publicVersionId: "version-1" });

    await expect(setSkillPublicVersion({ actor, orgId: "org-1", slug: "review", version: "2.0.0", ...transport, database: fake.database }))
      .resolves.toEqual({ ok: true, public_version: "2.0.0", share_token: "share-token-1", changed: true });
    expect(fake.returning).toHaveBeenCalledOnce();
    expect(fake.values).toHaveBeenCalledWith(expect.objectContaining({
      action: "skill.public_version.set",
      metadata: expect.objectContaining({ version: "2.0.0", previousVersion: "1.0.0", changed: true }),
    }));
  });

  it("never allows a non-creator Developer to manage an org public release", async () => {
    const fake = publicReleaseDb({ role: "developer", creatorId: "someone-else" });

    await expect(setSkillPublicVersion({ actor, orgId: "org-1", slug: "review", version: "2.0.0", ...transport, database: fake.database }))
      .rejects.toBeInstanceOf(SkillPublicReleaseForbiddenError);
  });

  it("requires a personal skill to be shared before promotion", async () => {
    const fake = publicReleaseDb({ role: "owner", scope: "personal", creatorId: actor.id });

    await expect(setSkillPublicVersion({ actor, orgId: "org-1", slug: "review", version: "2.0.0", ...transport, database: fake.database }))
      .rejects.toThrow("share this personal skill");
  });

  it("requires the immutable current version identity to match the renamed skill", async () => {
    const fake = publicReleaseDb({ role: "admin", creatorId: "someone-else", versionName: "old-review-name" });

    await expect(setSkillPublicVersion({
      actor,
      orgId: "org-1",
      slug: "review",
      version: "2.0.0",
      ...transport,
      database: fake.database,
    })).rejects.toThrow('publish a new current version named "review"');
    expect(fake.returning).not.toHaveBeenCalled();
  });

  it("rejects archived promotion while preserving its existing pointer", async () => {
    const fake = publicReleaseDb({ role: "owner", archived: true, publicVersionId: "version-1" });

    await expect(setSkillPublicVersion({ actor, orgId: "org-1", slug: "review", version: "2.0.0", ...transport, database: fake.database }))
      .rejects.toThrow("restore the skill");
    expect(fake.returning).not.toHaveBeenCalled();
  });

  /**
   * Product promise: promotion stays bound to the slug whose immutable manifest was validated.
   * Regression caught: rename could commit first and promotion would still pin the old-name ZIP.
   * Why unit-level: Core owns the complete conditional UPDATE predicate.
   * Failure proof: removing the slug predicate fails the compiled-SQL assertion.
   */
  it("surfaces a 409-grade CAS conflict instead of promoting after a concurrent row change", async () => {
    const fake = publicReleaseDb({ role: "admin", creatorId: "someone-else", updateRows: [] });

    await expect(setSkillPublicVersion({ actor, orgId: "org-1", slug: "review", version: "2.0.0", ...transport, database: fake.database }))
      .rejects.toBeInstanceOf(SkillPublicReleaseConflictError);

    const compiled = new PgDialect().sqlToQuery(fake.whereClauses[0]!);
    expect(compiled.sql).toContain('"skills"."slug" =');
  });

  it("preserves the successful idempotent promotion response while taking the CAS fence", async () => {
    const fake = publicReleaseDb({
      role: "admin",
      creatorId: "someone-else",
      publicVersionId: "version-2",
      publicPackageChecksum: transport.packageChecksum,
      publicPackageSizeBytes: transport.packageSizeBytes,
    });

    await expect(setSkillPublicVersion({
      actor,
      orgId: "org-1",
      slug: "review",
      version: "2.0.0",
      ...transport,
      database: fake.database,
    })).resolves.toEqual({ ok: true, public_version: "2.0.0", share_token: "share-token-1", changed: false });
    expect(fake.returning).toHaveBeenCalledOnce();
    expect(fake.updatePatches).toEqual([{ publicVersionId: "version-2" }]);
  });

  /**
   * Product promise: retrying PUT is idempotent but cannot report stale success after a withdrawal.
   * Regression caught: the unchanged branch skipped UPDATE and returned the stale preflight state.
   * Why unit-level: Core owns the CAS decision and maps zero updated rows to its conflict error.
   * Failure proof: restoring the early no-op branch makes the RETURNING assertion fail.
   */
  it("still performs CAS when an idempotent promotion races a concurrent release change", async () => {
    const fake = publicReleaseDb({
      role: "admin",
      creatorId: "someone-else",
      publicVersionId: "version-2",
      publicPackageChecksum: transport.packageChecksum,
      publicPackageSizeBytes: transport.packageSizeBytes,
      updateRows: [],
    });

    await expect(setSkillPublicVersion({
      actor,
      orgId: "org-1",
      slug: "review",
      version: "2.0.0",
      ...transport,
      database: fake.database,
    })).rejects.toBeInstanceOf(SkillPublicReleaseConflictError);
    expect(fake.returning).toHaveBeenCalledOnce();
    expect(fake.updatePatches).toEqual([{ publicVersionId: "version-2" }]);
  });

  it("surfaces a CAS conflict when the prepared version became non-current before promotion", async () => {
    const fake = publicReleaseDb({
      role: "admin",
      creatorId: "someone-else",
      currentVersionId: "version-3",
    });

    await expect(setSkillPublicVersion({
      actor,
      orgId: "org-1",
      slug: "review",
      version: "2.0.0",
      expectedCurrentVersionId: "version-2",
      ...transport,
      database: fake.database,
    })).rejects.toBeInstanceOf(SkillPublicReleaseConflictError);
    expect(fake.returning).not.toHaveBeenCalled();
  });

  it("withdraws idempotently, retaining the stable token", async () => {
    const alreadyPrivate = publicReleaseDb({ role: "admin", creatorId: "someone-else", publicVersionId: null });
    await expect(clearSkillPublicVersion({ actor, orgId: "org-1", slug: "review", database: alreadyPrivate.database }))
      .resolves.toEqual({ ok: true, public_version: null, share_token: "share-token-1", changed: false });
    expect(alreadyPrivate.returning).toHaveBeenCalledOnce();
    expect(alreadyPrivate.updatePatches).toEqual([{ publicVersionId: null }]);

    const publicSkill = publicReleaseDb({ role: "admin", creatorId: "someone-else", publicVersionId: "version-1" });
    await expect(clearSkillPublicVersion({ actor, orgId: "org-1", slug: "review", database: publicSkill.database }))
      .resolves.toEqual({ ok: true, public_version: null, share_token: "share-token-1", changed: true });
    expect(publicSkill.returning).toHaveBeenCalledOnce();
  });

  /**
   * Product promise: retrying DELETE cannot say the skill is private when a promotion won the race.
   * Regression caught: the already-private branch skipped UPDATE and returned stale success.
   * Why unit-level: Core owns the CAS decision and its 409-equivalent conflict class.
   * Failure proof: restoring the early no-op branch makes the RETURNING assertion fail.
   */
  it("still performs CAS when an idempotent withdrawal races a concurrent promotion", async () => {
    const fake = publicReleaseDb({
      role: "admin",
      creatorId: "someone-else",
      publicVersionId: null,
      updateRows: [],
    });

    await expect(clearSkillPublicVersion({
      actor,
      orgId: "org-1",
      slug: "review",
      database: fake.database,
    })).rejects.toBeInstanceOf(SkillPublicReleaseConflictError);
    expect(fake.returning).toHaveBeenCalledOnce();
    expect(fake.updatePatches).toEqual([{ publicVersionId: null }]);
  });
});
