import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPANION_REASONING_MAX_CHARACTERS } from "@companion/contracts";
import { getCompanionThread, recordCompanionPiProjection } from "@companion/core";
import { withTenantContext } from "@companion/db";
import { integrationSql, type TestActor } from "./testDatabase";

/**
 * Product promise:
 * A reply can say why it happened. The thinking a turn produced is stored beside the reply and comes
 * back with it, and it belongs to that reply alone: nothing else in the transcript may carry
 * reasoning, and no single row may carry more of it than the contract allows.
 *
 * Regression caught:
 * THE-364 added the `reasoning` column. Both ends of the path are individually deletable — dropping
 * it from the projection insert, or from the read model's select or mapping, makes Pi's reasoning
 * vanish from every thread while every unit test stays green. The two CHECK constraints are the only
 * thing standing between a drifting projection and reasoning attached to a member's message, or a
 * poll that quietly turns into a large read.
 *
 * Why this test is integrated:
 * A CHECK constraint is a database fact, not a TypeScript one, and the round trip crosses the write,
 * the column, and the read model — three places a mocked query builder cannot hold together.
 *
 * Failure proof:
 * Removing `reasoning` from either the insert in `recordCompanionPiProjection` or the select in
 * `readCompanionTranscript` fails the round-trip case; dropping either constraint from
 * `0081_companion_transcript_reasoning.sql` makes one of the rejection cases resolve.
 */
describe("Companion transcript reasoning", () => {
  const suffix = randomUUID();
  const owner: TestActor = {
    id: `reasoning-owner-${suffix}`,
    email: `reasoning-owner-${suffix}@example.test`,
    name: "Reasoning Owner",
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
      values (${owner.id}, ${owner.name}, ${owner.email}, 'RO', now())
    `;
    await integrationSql`
      insert into organizations (id, name, slug, kind)
      values (${org}, 'Reasoning org', ${`reasoning-org-${suffix}`}, 'team')
    `;
    await integrationSql`
      insert into memberships (org_id, user_id, org_role) values (${org}, ${owner.id}, 'owner')
    `;
    await integrationSql`
      insert into companions (id, org_id, owner_id, name)
      values (${companionId}, ${org}, ${owner.id}, 'Reasoning Companion')
    `;
  });

  afterAll(async () => {
    await integrationSql`delete from companions where org_id = ${org}`;
    await integrationSql`delete from organizations where id = ${org}`;
    await integrationSql`delete from "user" where id = ${owner.id}`;
  });

  it("returns the thinking a reply was produced with, and nothing where there was none", async () => {
    await asOwner((database) => recordCompanionPiProjection({
      actor: owner,
      orgId: org,
      companionId,
      entries: [
        {
          eventId: "pi:reasoned",
          role: "assistant",
          content: "Two services timed out.",
          reasoning: "I checked the incident log before writing the summary.",
          createdAt: new Date("2026-08-12T12:00:00.000Z"),
        },
        {
          eventId: "pi:plain",
          role: "assistant",
          content: "Nothing else to report.",
          createdAt: new Date("2026-08-12T12:00:01.000Z"),
        },
      ],
      database,
    }));

    const thread = await asOwner((database) =>
      getCompanionThread({ actor: owner, orgId: org, companionId, database }));
    const byId = new Map(thread.entries.map((entry) => [entry.event_id, entry]));

    expect(byId.get("pi:reasoned")?.reasoning)
      .toBe("I checked the incident log before writing the summary.");
    // A turn that produced no thinking reads back as a reply with nothing to disclose, not as one
    // whose disclosure went missing.
    expect(byId.get("pi:plain")?.reasoning).toBeNull();
  });

  it("refuses reasoning on anything that is not a reply", async () => {
    await expect(integrationSql`
      insert into companion_transcript_entries (
        org_id, companion_id, event_id, ordinal, role, content, reasoning
      ) values (
        ${org}, ${companionId}, 'msg:not-a-reply', 900, 'user', 'Ship it', 'thinking'
      )
    `).rejects.toThrow(/companion_transcript_entries_reasoning_role_check/);
  });

  it("refuses more reasoning than the contract caps a row at", async () => {
    // The column's byte bound is the backstop for the projection's character cap; a projection that
    // stopped truncating must not be able to turn every poll into a large read.
    await expect(integrationSql`
      insert into companion_transcript_entries (
        org_id, companion_id, event_id, ordinal, role, content, reasoning
      ) values (
        ${org}, ${companionId}, 'pi:too-long', 901, 'assistant', 'Answered',
        ${"t".repeat(COMPANION_REASONING_MAX_CHARACTERS * 5)}
      )
    `).rejects.toThrow(/companion_transcript_entries_reasoning_size_check/);
  });
});
