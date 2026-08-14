import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCompanions } from "@companion/core";
import { withTenantContext } from "@companion/db";
import { integrationSql, type TestActor } from "./testDatabase";

/**
 * Product promise: a conversation list says what each thread's last word was, and it says it about
 * the right thread and the right organization. Tool runs and permission cards are not chat, so a
 * Companion whose newest transcript entry is a shell command still previews the last thing a person
 * or Pi actually said — a list row can never carry a command, a path, or an unanswered question to a
 * reader who has not opened the thread.
 *
 * Why integrated: the projection is one `DISTINCT ON` over the transcript with a role filter and an
 * organization scope. Which row survives per Companion, whether the enum filter binds, and whether
 * the scope holds against a second organization are all PostgreSQL facts; a mocked query builder
 * asserts the query that was written, not the rows it returns.
 */
describe("Companion last-message projection", () => {
  const suffix = randomUUID();
  const owner: TestActor = {
    id: `preview-owner-${suffix}`,
    email: `preview-owner-${suffix}@example.test`,
    name: "Preview Owner",
  };
  const org = randomUUID();
  const otherOrg = randomUUID();
  const quiet = randomUUID();
  const busy = randomUUID();
  const elsewhere = randomUUID();

  const asOwner = <T>(
    fn: (database: Parameters<Parameters<typeof withTenantContext>[1]>[0]) => Promise<T>,
  ) => withTenantContext({ orgId: org, userId: owner.id }, fn);

  async function entry(input: {
    companionId: string;
    orgId: string;
    ordinal: number;
    role: string;
    content: string;
    authorId?: string | null;
    tool?: unknown;
  }) {
    await integrationSql`
      insert into companion_transcript_entries
        (org_id, companion_id, event_id, ordinal, role, content, author_id, tool)
      values (
        ${input.orgId},
        ${input.companionId},
        ${`e-${input.companionId}-${input.ordinal}`},
        ${input.ordinal},
        ${input.role}::companion_transcript_role,
        ${input.content},
        ${input.authorId ?? null},
        ${input.tool ? JSON.stringify(input.tool) : null}
      )
    `;
  }

  beforeAll(async () => {
    await integrationSql`
      insert into "user" (id, name, email, email_verified)
      values (${owner.id}, ${owner.name}, ${owner.email}, true)
    `;
    await integrationSql`
      insert into profiles (id, name, email, initials, onboarded_at)
      values (${owner.id}, ${owner.name}, ${owner.email}, 'PO', now())
    `;
    for (const [id, slug] of [[org, `preview-org-${suffix}`], [otherOrg, `preview-other-${suffix}`]]) {
      await integrationSql`
        insert into organizations (id, name, slug, kind)
        values (${id!}, 'Preview org', ${slug!}, 'team')
      `;
      await integrationSql`
        insert into memberships (org_id, user_id, org_role) values (${id!}, ${owner.id}, 'owner')
      `;
    }
    for (const [id, orgId, name] of [
      [quiet, org, "Quiet"],
      [busy, org, "Busy"],
      [elsewhere, otherOrg, "Elsewhere"],
    ]) {
      await integrationSql`
        insert into companions (id, org_id, owner_id, name)
        values (${id!}, ${orgId!}, ${owner.id}, ${name!})
      `;
    }

    await entry({
      companionId: busy,
      orgId: org,
      ordinal: 0,
      role: "user",
      content: "Ship the launch note",
      authorId: owner.id,
    });
    await entry({
      companionId: busy,
      orgId: org,
      ordinal: 1,
      role: "assistant",
      content: "Drafted the launch note.\nA second paragraph no row shows.",
    });
    // The newest entry on the thread, and the one a preview must not repeat.
    await entry({
      companionId: busy,
      orgId: org,
      ordinal: 2,
      role: "tool",
      content: "shell",
      tool: {
        call_id: "call-1",
        kind: "shell",
        name: "shell",
        title: "rm -rf /tmp/build --token=hunter2",
        status: "ok",
        detail: null,
        screenshot: null,
      },
    });
    await entry({
      companionId: elsewhere,
      orgId: otherOrg,
      ordinal: 0,
      role: "assistant",
      content: "Another workspace's business",
    });
  });

  afterAll(async () => {
    await integrationSql`delete from companions where org_id in (${org}, ${otherOrg})`;
    await integrationSql`delete from organizations where id in (${org}, ${otherOrg})`;
    await integrationSql`delete from "user" where id = ${owner.id}`;
  });

  it("previews the newest thing said, never the newest thing run", async () => {
    const companions = await asOwner((database) =>
      listCompanions({ actor: owner, orgId: org, database }));

    const preview = companions.find((item) => item.id === busy)?.last_message;
    expect(preview).toEqual({
      preview: "Drafted the launch note.",
      role: "assistant",
      author_id: null,
      author_name: null,
      created_at: expect.any(String),
    });
    expect(JSON.stringify(companions)).not.toContain("hunter2");
  });

  it("leaves a thread nobody has written in without a preview", async () => {
    const companions = await asOwner((database) =>
      listCompanions({ actor: owner, orgId: org, database }));

    expect(companions.find((item) => item.id === quiet)?.last_message).toBeNull();
  });

  it("keeps a preview inside the organization its thread belongs to", async () => {
    const companions = await asOwner((database) =>
      listCompanions({ actor: owner, orgId: org, database }));

    expect(companions.map((item) => item.id)).not.toContain(elsewhere);
    expect(JSON.stringify(companions)).not.toContain("Another workspace's business");
  });

  it("moves the preview forward as the thread does", async () => {
    await entry({
      companionId: quiet,
      orgId: org,
      ordinal: 0,
      role: "user",
      content: "  First   word  ",
      authorId: owner.id,
    });

    const first = await asOwner((database) =>
      listCompanions({ actor: owner, orgId: org, database }));
    expect(first.find((item) => item.id === quiet)?.last_message).toMatchObject({
      preview: "First word",
      role: "user",
      author_id: owner.id,
      author_name: owner.name,
    });

    await entry({
      companionId: quiet,
      orgId: org,
      ordinal: 1,
      role: "assistant",
      content: "x".repeat(400),
    });

    const second = await asOwner((database) =>
      listCompanions({ actor: owner, orgId: org, database }));
    const latest = second.find((item) => item.id === quiet)?.last_message;
    expect(latest?.role).toBe("assistant");
    expect(latest?.preview).toHaveLength(140);
  });
});
