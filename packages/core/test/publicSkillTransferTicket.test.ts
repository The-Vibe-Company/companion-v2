import { describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";
import {
  consumeSkillPackageTransferTicket,
  consumePublicSkillTransferTicket,
  createPublicSkillTransferTicket,
  PUBLIC_SKILL_TRANSFER_TICKET_PREFIX,
  preflightSkillPackageTransferTicket,
  revalidateAgentTransferTicket,
} from "../src/services";

function executeDb(rows: unknown[]) {
  const execute = vi.fn(async (_query: unknown) => rows);
  return { database: { execute } as unknown as Db, execute };
}

describe("public skill transfer ticket service", () => {
  it("returns plaintext once while delegating only a hash-at-rest insert to Postgres", async () => {
    const expires = new Date(Date.now() + 30_000).toISOString();
    const { database, execute } = executeDb([{
      ticket_id: "ticket-id",
      org_id: "org-1",
      skill_id: "skill-1",
      skill_version_id: "version-1",
      version: "1.0.0",
      checksum: `sha256:${"a".repeat(64)}`,
      size_bytes: 123,
      expires_at: expires,
    }]);

    const result = await createPublicSkillTransferTicket({
      token: " share-token ",
      version: " 1.0.0 ",
      userId: "user-1",
      agentId: "agent-1",
      agentGrantId: "grant-1",
      database,
    });

    expect(result.ticket).toMatch(new RegExp(`^${PUBLIC_SKILL_TRANSFER_TICKET_PREFIX}[0-9a-f]{64}$`));
    expect(result).toMatchObject({ version: "1.0.0", checksum: `sha256:${"a".repeat(64)}`, size_bytes: 123 });
    expect(execute).toHaveBeenCalledOnce();
    // Drizzle keeps bound values in query chunks; serializing the SQL object must never contain the
    // random raw ticket or even its random prefix. Only the SHA-256 digest is bound.
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).not.toContain(result.ticket);
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).not.toContain(result.ticket.slice(0, 20));
  });

  it("rejects malformed ticket prefixes before touching Postgres", async () => {
    const { database, execute } = executeDb([]);
    await expect(consumePublicSkillTransferTicket({
      ticket: "not-a-transfer-ticket",
      token: "share-token",
      version: "1.0.0",
      database,
    })).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns the exact descriptor selected by the atomic consume function", async () => {
    const { database } = executeDb([{
      org_id: "org-1",
      skill_id: "skill-1",
      skill_version_id: "version-1",
      slug: "review",
      version: "1.0.0",
      storage_path: "skills/review/1.0.0.tar.gz",
      checksum: `sha256:${"b".repeat(64)}`,
      size_bytes: 456,
      user_id: "user-1",
      agent_id: "agent-1",
      agent_grant_id: "grant-1",
    }]);

    await expect(consumePublicSkillTransferTicket({
      ticket: `${PUBLIC_SKILL_TRANSFER_TICKET_PREFIX}${"c".repeat(64)}`,
      token: "share-token",
      version: "1.0.0",
      database,
    })).resolves.toEqual({
      orgId: "org-1",
      slug: "review",
      version: "1.0.0",
      checksum: `sha256:${"b".repeat(64)}`,
      sizeBytes: 456,
    });
  });

  it("keeps private ticket failures pre-tenant and maps the delegated actor only after atomic consumption", async () => {
    const { database, execute } = executeDb([{
      ticket_id: "ticket-private",
      org_id: "org-1",
      user_id: "user-1",
      user_email: "user@example.test",
      user_name: "User One",
      agent_id: "agent-1",
      agent_grant_id: "grant-1",
      action: "skill_package.upload",
      skill_id: null,
      skill_version_id: null,
      skill_slug: "fresh-skill",
      version: "1.0.0",
      checksum: `sha256:${"d".repeat(64)}`,
      size_bytes: 789,
      expires_at: new Date(Date.now() + 30_000).toISOString(),
    }]);

    await expect(consumeSkillPackageTransferTicket({
      ticket: `${PUBLIC_SKILL_TRANSFER_TICKET_PREFIX}${"e".repeat(64)}`,
      action: "skill_package.upload",
      slug: "fresh-skill",
      version: "1.0.0",
      checksum: `sha256:${"d".repeat(64)}`,
      sizeBytes: 789,
      database,
    })).resolves.toMatchObject({
      ticketId: "ticket-private",
      orgId: "org-1",
      actor: { id: "user-1", email: "user@example.test", name: "User One" },
      expectedSkillId: null,
      action: "skill_package.upload",
      slug: "fresh-skill",
      version: "1.0.0",
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects a malformed private transfer ticket before querying cross-tenant state", async () => {
    const { database, execute } = executeDb([]);
    await expect(consumeSkillPackageTransferTicket({
      ticket: "wrong-prefix",
      action: "skill_package.download",
      slug: "skill",
      version: "1.0.0",
      database,
    })).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("preflights an upload ticket by hash before any package bytes are accepted", async () => {
    const { database, execute } = executeDb([{ authorized: true }]);
    const ticket = `${PUBLIC_SKILL_TRANSFER_TICKET_PREFIX}${"1".repeat(64)}`;

    await expect(preflightSkillPackageTransferTicket({
      ticket,
      action: "skill_package.upload",
      slug: "fresh-skill",
      version: "1.0.0",
      database,
    })).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).not.toContain(ticket);

    const malformed = executeDb([]);
    await expect(preflightSkillPackageTransferTicket({
      ticket: "wrong-prefix",
      action: "skill_package.upload",
      slug: "fresh-skill",
      version: "1.0.0",
      database: malformed.database,
    })).resolves.toBe(false);
    expect(malformed.execute).not.toHaveBeenCalled();
  });

  it("revalidates a consumed ticket by hash without trusting caller-supplied identity fields", async () => {
    const { database, execute } = executeDb([{ authorized: true }]);
    const ticket = `${PUBLIC_SKILL_TRANSFER_TICKET_PREFIX}${"f".repeat(64)}`;

    await expect(revalidateAgentTransferTicket({ ticket, database })).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).not.toContain(ticket);

    const malformed = executeDb([]);
    await expect(revalidateAgentTransferTicket({ ticket: "not-a-transfer-ticket", database: malformed.database }))
      .resolves.toBe(false);
    expect(malformed.execute).not.toHaveBeenCalled();
  });
});
