import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import { TEAM_BRAND_COLORS } from "@companion/contracts";
import {
  isActorEmailVerified,
  listJoinableOrgsByDomain,
  normalizeAccessDomain,
  orgAllowsEmailDomain,
  requireVerifiedForDomainJoin,
  type DomainJoinableOrg,
} from "./domainAccess";
import { classifyEmailDomain } from "./email-domains";
import { uniqueSlug, type ActorContext } from "./services";
import { markSeatSyncPending } from "./billing";

export type OnboardingMatchedOrg = DomainJoinableOrg;

export interface OnboardingContextResult {
  email: string;
  domain: string | null;
  isPersonal: boolean;
  /** Domain-access orgs the actor can join; empty for personal domains or no match. */
  matchedOrgs: OnboardingMatchedOrg[];
}

export interface CompleteOnboardingInput {
  org: { name: string; domain?: string | null; autoJoin?: boolean; color?: string | null; logoUrl?: string | null };
  invites: string[];
}

function normalizeBrandColor(value: string | null | undefined, label: "org"): string | null {
  const color = value?.trim() ?? "";
  if (!color) return null;
  if (!(TEAM_BRAND_COLORS as readonly string[]).includes(color)) throw new Error(`invalid ${label} color`);
  return color;
}

/**
 * Classify the authenticated user's email domain and, for corporate domains, surface a matching
 * domain-access org list. The returned ids are still verified server-side by `joinOrgByDomain`.
 */
export async function getOnboardingContext(
  actor: ActorContext,
  database: Db = db,
): Promise<OnboardingContextResult> {
  const { domain, isPersonal } = classifyEmailDomain(actor.email);
  const base = { email: actor.email, domain, isPersonal, matchedOrgs: [] as OnboardingMatchedOrg[] };
  if (!domain || isPersonal) return base;
  return { ...base, matchedOrgs: await listJoinableOrgsByDomain(domain, actor.id, database) };
}

/**
 * Join a domain-access org for the actor's verified email domain. The org id is client-selected from
 * onboarding context, but the email-domain match is always re-derived and re-verified server-side.
 */
export async function joinOrgByDomain(actor: ActorContext, orgId: string, database: Db = db): Promise<{ orgId: string }> {
  const { domain, isPersonal } = classifyEmailDomain(actor.email);
  if (!domain || isPersonal) throw new Error("no organization to join for this email domain");

  if (!(await orgAllowsEmailDomain({ orgId, emailDomain: domain, database }))) {
    throw new Error("no organization to join for this email domain");
  }
  const org = await database.query.organizations.findFirst({
    where: eq(schema.organizations.id, orgId),
    columns: { kind: true },
  });
  if (!org || org.kind !== "team") throw new Error("no organization to join for this email domain");

  if (requireVerifiedForDomainJoin() && !(await isActorEmailVerified(actor.id, database))) {
    throw new Error("verify your email to join this organization");
  }

  await database.transaction(async (tx) => {
    await tx
      .insert(schema.memberships)
      .values({ orgId, userId: actor.id, orgRole: "developer" })
      .onConflictDoNothing();
    await tx
      .update(schema.profiles)
      .set({ onboardedAt: new Date() })
      .where(and(eq(schema.profiles.id, actor.id), isNull(schema.profiles.onboardedAt)));
    await markSeatSyncPending(orgId, tx as unknown as Db);
  });

  return { orgId };
}

/**
 * Atomically create the user's organization and invitations, and mark onboarding complete. Domain
 * access is only honored for the actor's own
 * (verified, when gated) work domain during onboarding.
 */
export async function completeOnboarding(
  actor: ActorContext,
  input: CompleteOnboardingInput,
  database: Db = db,
): Promise<{ orgId: string; inviteTokens: Array<{ email: string; token: string }> }> {
  const { domain: actorDomain, isPersonal } = classifyEmailDomain(actor.email);

  // A domain may only be enabled for the actor's own corporate domain during onboarding — this
  // stops a gmail user (or anyone) from squatting `bigcorp.com` and harvesting future signups.
  let orgDomain = input.org.domain ? normalizeAccessDomain(input.org.domain) : null;
  const ownsDomain = !!orgDomain && !isPersonal && orgDomain === actorDomain;
  if (orgDomain && !ownsDomain) orgDomain = null;

  const domainAccessEnabled = !!input.org.autoJoin && ownsDomain;
  if (domainAccessEnabled && requireVerifiedForDomainJoin() && !(await isActorEmailVerified(actor.id, database))) {
    throw new Error("verify your email to enable domain access");
  }

  const orgColor = normalizeBrandColor(input.org.color, "org");
  const inviteTokens: Array<{ email: string; token: string }> = [];

  const orgId = await database
    .transaction(async (tx) => {
      const [org] = await tx
        .insert(schema.organizations)
        .values({
          name: input.org.name,
          slug: uniqueSlug(input.org.name, crypto.randomUUID()),
          kind: "team",
          domain: orgDomain,
          domainAutoJoin: domainAccessEnabled,
          color: orgColor,
          logoUrl: input.org.logoUrl ?? null,
        })
        .returning();
      if (!org) throw new Error("could not create organization");

      if (orgDomain && domainAccessEnabled) {
        await tx
          .insert(schema.organizationDomains)
          .values({ orgId: org.id, domain: orgDomain, createdBy: actor.id })
          .onConflictDoNothing();
      }

      await tx.insert(schema.memberships).values({ orgId: org.id, userId: actor.id, orgRole: "owner" });

      const seen = new Set<string>();
      const self = actor.email.toLowerCase();
      for (const raw of input.invites) {
        const email = raw.trim().toLowerCase();
        if (!email || email === self || seen.has(email)) continue;
        seen.add(email);
        const token = crypto.randomUUID().replaceAll("-", "");
        const [row] = await tx
          .insert(schema.invitations)
          .values({
            orgId: org.id,
            email,
            orgRole: "developer",
            token,
            createdBy: actor.id,
            expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14),
          })
          .onConflictDoNothing()
          .returning({ id: schema.invitations.id });
        if (row) inviteTokens.push({ email, token });
      }

      await tx
        .update(schema.profiles)
        .set({ onboardedAt: new Date() })
        .where(and(eq(schema.profiles.id, actor.id), isNull(schema.profiles.onboardedAt)));

      return org.id;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw error;
    });

  return { orgId, inviteTokens };
}

/** Mark the user as onboarded (idempotent). Used by local seeding for pre-provisioned accounts. */
export async function markOnboarded(actor: ActorContext, database: Db = db): Promise<void> {
  await database
    .update(schema.profiles)
    .set({ onboardedAt: new Date() })
    .where(and(eq(schema.profiles.id, actor.id), isNull(schema.profiles.onboardedAt)));
}

/** Whether the user has finished onboarding (created/joined an org or accepted an invite). */
export async function getOnboardingState(actor: ActorContext, database: Db = db): Promise<{ onboarded: boolean }> {
  const row = await database.query.profiles.findFirst({
    where: eq(schema.profiles.id, actor.id),
    columns: { onboardedAt: true },
  });
  return { onboarded: row?.onboardedAt != null };
}
