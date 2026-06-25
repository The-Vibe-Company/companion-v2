import { describe, expect, it, vi } from "vitest";
import type { Db } from "@companion/db";
import { TEAM_BRAND_COLORS } from "@companion/contracts";
import { completeOnboarding, getOnboardingContext, joinOrgByDomain, type CompleteOnboardingInput } from "../src/onboarding";

const actor = { id: "user-1", email: "owner@acme.test", name: "Owner" };

/**
 * Teams were removed product-wide (Org → User). Onboarding creates only the org + the owner
 * membership (+ optional domain-access + invitations); no team row is written.
 */
function input(patch: Partial<CompleteOnboardingInput> = {}): CompleteOnboardingInput {
  const base: CompleteOnboardingInput = {
    org: { name: "Acme", domain: "acme.test", autoJoin: false, color: null, logoUrl: null },
    invites: [],
  };
  return {
    org: { ...base.org, ...patch.org },
    invites: patch.invites ?? base.invites,
  };
}

describe("completeOnboarding", () => {
  it("rejects arbitrary org colors before writing", async () => {
    const database = { transaction: vi.fn() } as unknown as Db;

    await expect(
      completeOnboarding(
        actor,
        input({ org: { name: "Acme", color: "url(https://evil.test/x.png)" } }),
        database,
      ),
    ).rejects.toThrow("invalid org color");
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("accepts palette colors and creates only the org + owner membership (no team)", async () => {
    const color = TEAM_BRAND_COLORS[0]!;
    const tx = {
      execute: vi.fn(async () => undefined),
      insert: vi
        .fn()
        .mockReturnValueOnce({ values: () => ({ returning: async () => [{ id: "org-1" }] }) }) // organizations
        .mockReturnValueOnce({ values: () => undefined }), // owner membership
      update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    };
    const database = {
      transaction: vi.fn(async (cb: (txArg: typeof tx) => Promise<string>) => cb(tx)),
    } as unknown as Db;

    await expect(
      completeOnboarding(actor, input({ org: { name: "Acme", color } }), database),
    ).resolves.toEqual({ orgId: "org-1", inviteTokens: [] });

    // org + membership only — no team and no team membership inserts.
    expect(tx.insert).toHaveBeenCalledTimes(2);
  });

  it("creates a domain access row when the owner enables domain access", async () => {
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce({ values: () => ({ returning: async () => [{ id: "org-1" }] }) }) // organizations
        .mockReturnValueOnce({ values: () => ({ onConflictDoNothing: async () => undefined }) }) // organization domain
        .mockReturnValueOnce({ values: () => undefined }), // owner membership
      update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    };
    const database = {
      query: { user: { findFirst: vi.fn(async () => ({ emailVerified: true })) } },
      transaction: vi.fn(async (cb: (txArg: typeof tx) => Promise<string>) => cb(tx)),
    } as unknown as Db;

    await expect(completeOnboarding(actor, input({ org: { name: "Acme", autoJoin: true } }), database)).resolves.toEqual({
      orgId: "org-1",
      inviteTokens: [],
    });

    // organizations + organization domain + owner membership — still no team.
    expect(tx.insert).toHaveBeenCalledTimes(3);
  });
});

describe("domain onboarding context", () => {
  it("returns multiple organizations for the actor's corporate domain", async () => {
    const domainRows = [
      { orgId: "org-1", name: "Client A", domain: "acme.test" },
      { orgId: "org-2", name: "Client B", domain: "acme.test" },
    ];
    // One member-count query per matched org.
    const counts = [{ value: 2 }, { value: 4 }];
    const database = {
      select: vi.fn((cols: Record<string, unknown>) => {
        const rows = "orgId" in cols ? domainRows : [counts.shift() ?? { value: 0 }];
        const builder = {
          from: () => builder,
          innerJoin: () => builder,
          where: () => builder,
          orderBy: async () => rows,
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
        };
        return builder;
      }),
    } as unknown as Db;

    await expect(getOnboardingContext(actor, database)).resolves.toMatchObject({
      domain: "acme.test",
      matchedOrgs: [
        { id: "org-1", name: "Client A", memberCount: 2 },
        { id: "org-2", name: "Client B", memberCount: 4 },
      ],
    });
  });

  it("rejects joining a selected org that does not allow the actor's domain", async () => {
    const database = {
      query: { organizationDomains: { findFirst: vi.fn(async () => null) } },
      transaction: vi.fn(),
    } as unknown as Db;

    await expect(joinOrgByDomain(actor, "org-1", database)).rejects.toThrow("no organization to join for this email domain");
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("rejects domain joining for personal email domains", async () => {
    const database = { query: { organizationDomains: { findFirst: vi.fn() } } } as unknown as Db;

    await expect(
      joinOrgByDomain({ id: "user-2", email: "owner@gmail.com", name: "Owner" }, "org-1", database),
    ).rejects.toThrow("no organization to join for this email domain");
  });
});
