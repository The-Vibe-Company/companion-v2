import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimCompanionDelivery,
  getCompanionThread,
  listPendingCompanionMessages,
  releaseCompanionDelivery,
  sendCompanionMessage,
} from "@companion/core";
import { withTenantContext } from "@companion/db";
import { integrationSql, type TestActor } from "./testDatabase";

/**
 * Product promise (THE-320, THE-337): one send is one turn. A send names the message it is creating,
 * and the control plane stores that name once, so the same send reaching the API twice — a retried
 * request, a replayed one, a client that submitted twice — leaves one user message in the transcript
 * and one message waiting for Pi. A message that is durable but undelivered stays pending, because a
 * resend must be able to complete a delivery without duplicating the turn.
 *
 * Why integrated: the guarantee is a database fact. The transcript's `(companion_id, event_id)`
 * primary key is what makes a second write impossible, and the ordinal allocation, the pending
 * watermark, and the conflicting insert only behave this way against real PostgreSQL — including two
 * sends racing each other, which no mocked query builder can express.
 */
describe("Companion message send idempotence", () => {
  const suffix = randomUUID();
  const owner: TestActor = {
    id: `send-owner-${suffix}`,
    email: `send-owner-${suffix}@example.test`,
    name: "Send Owner",
  };
  const org = randomUUID();
  const companionId = randomUUID();

  const asOwner = <T>(
    fn: (database: Parameters<Parameters<typeof withTenantContext>[1]>[0]) => Promise<T>,
  ) => withTenantContext({ orgId: org, userId: owner.id }, fn);

  beforeAll(async () => {
    await integrationSql`
      insert into "user" (id, name, email, email_verified)
      values (${owner.id}, ${owner.name}, ${owner.email}, true)
    `;
    await integrationSql`
      insert into profiles (id, name, email, initials, onboarded_at)
      values (${owner.id}, ${owner.name}, ${owner.email}, 'SO', now())
    `;
    await integrationSql`
      insert into organizations (id, name, slug, kind)
      values (${org}, 'Send org', ${`send-org-${suffix}`}, 'team')
    `;
    await integrationSql`
      insert into memberships (org_id, user_id, org_role) values (${org}, ${owner.id}, 'owner')
    `;
    await integrationSql`
      insert into companions (id, org_id, owner_id, name)
      values (${companionId}, ${org}, ${owner.id}, 'Send Companion')
    `;
  });

  afterAll(async () => {
    await integrationSql`delete from companions where org_id = ${org}`;
    await integrationSql`delete from organizations where id = ${org}`;
    await integrationSql`delete from "user" where id = ${owner.id}`;
  });

  const send = (content: string, clientMessageId?: string) =>
    asOwner((database) => sendCompanionMessage({
      actor: owner,
      orgId: org,
      companionId,
      content,
      ...(clientMessageId ? { clientMessageId } : {}),
      database,
    }));

  it("persists one turn however many times the same send arrives", async () => {
    const clientMessageId = randomUUID();

    const first = await send("What year is it?", clientMessageId);
    const again = await send("What year is it?", clientMessageId);

    // The second request resolves to the turn the first one created, ordinal and all, rather than to
    // a turn of its own.
    expect(again.entry).toEqual(first.entry);

    const thread = await asOwner((database) =>
      getCompanionThread({ actor: owner, orgId: org, companionId, database }));
    expect(thread.entries.filter((entry) => entry.role === "user")).toEqual([first.entry]);
    // One message for Pi, so the reply cannot be produced twice either.
    expect(thread.pending_count).toBe(1);
  });

  it("persists one turn when the same send arrives twice at once", async () => {
    const clientMessageId = randomUUID();

    const [first, second] = await Promise.all([
      send("Two at once", clientMessageId),
      send("Two at once", clientMessageId),
    ]);

    expect(second.entry.event_id).toBe(first.entry.event_id);
    const stored = await integrationSql<{ count: string }[]>`
      select count(*)::text as count from companion_transcript_entries
      where companion_id = ${companionId} and content = 'Two at once'
    `;
    expect(stored[0]?.count).toBe("1");
  });

  it("keeps two different messages as two turns", async () => {
    const first = await send("First ask", randomUUID());
    const second = await send("Second ask", randomUUID());

    expect(first.entry.event_id).not.toBe(second.entry.event_id);
    expect(second.entry.ordinal).toBeGreaterThan(first.entry.ordinal);
    const pending = await asOwner((database) =>
      listPendingCompanionMessages({ actor: owner, orgId: org, companionId, database }));
    expect(pending.pending.map((entry) => entry.content)).toContain("First ask");
    expect(pending.pending.map((entry) => entry.content)).toContain("Second ask");
  });

  it("leaves an undelivered message pending so a resend can still reach Pi", async () => {
    const clientMessageId = randomUUID();
    const sent = await send("Never delivered", clientMessageId);

    await send("Never delivered", clientMessageId);
    const pending = await asOwner((database) =>
      listPendingCompanionMessages({ actor: owner, orgId: org, companionId, database }));

    // Still waiting, and waiting once: a resend has to be able to complete a delivery that failed
    // without queueing the same prompt for Pi a second time.
    expect(pending.pending.filter((entry) => entry.content === "Never delivered"))
      .toEqual([sent.entry]);
    expect(pending.deliveredOrdinal).toBeNull();
  });

  it("serializes delivery for one Companion across database connections", async () => {
    const firstClaimId = randomUUID();
    const secondClaimId = randomUUID();
    const claim = (claimId: string) => asOwner((database) => claimCompanionDelivery({
      actor: owner,
      orgId: org,
      companionId,
      claimId,
      leaseSeconds: 60,
      database,
    }));
    const release = (claimId: string) => asOwner((database) => releaseCompanionDelivery({
      actor: owner,
      orgId: org,
      companionId,
      claimId,
      database,
    }));

    const [firstClaimed, secondClaimed] = await Promise.all([
      claim(firstClaimId),
      claim(secondClaimId),
    ]);
    expect([firstClaimed, secondClaimed].filter(Boolean)).toHaveLength(1);

    const winner = firstClaimed ? firstClaimId : secondClaimId;
    const loser = firstClaimed ? secondClaimId : firstClaimId;
    expect(await release(winner)).toBe(true);
    expect(await claim(loser)).toBe(true);
    expect(await release(loser)).toBe(true);
  });
});
