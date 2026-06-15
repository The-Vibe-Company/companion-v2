import { and, count, eq, isNull, sql } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import { TEAM_BRAND_COLORS } from "@companion/contracts";
import { classifyEmailDomain } from "./email-domains";
import { uniqueSlug, type ActorContext } from "./services";

export interface OnboardingMatchedOrg {
  name: string;
  domain: string;
  memberCount: number;
  teamCount: number;
}

export interface OnboardingContextResult {
  email: string;
  domain: string | null;
  isPersonal: boolean;
  /** A domain-auto-join org the actor can hop straight into; null for personal domains or no match. */
  matchedOrg: OnboardingMatchedOrg | null;
}

export interface CompleteOnboardingInput {
  org: { name: string; domain?: string | null; autoJoin?: boolean; color?: string | null; logoUrl?: string | null };
  team: { name: string; color?: string | null; icon?: string | null };
  invites: string[];
}

/**
 * Whether the domain-join path must require a verified email. Auto-join trusts the email domain, so
 * in production we require `emailVerified` to stop `attacker@bigcorp.com` from slipping into BigCorp.
 * Defaults to on in production; overridable with `COMPANION_REQUIRE_VERIFIED_DOMAIN_JOIN=true|false`
 * (off by default in dev, where email infra may be log-only).
 */
function requireVerifiedForDomainJoin(): boolean {
  const flag = process.env.COMPANION_REQUIRE_VERIFIED_DOMAIN_JOIN;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return process.env.NODE_ENV === "production";
}

function normalizeBrandColor(value: string | null | undefined, label: "org" | "team"): string | null {
  const color = value?.trim() ?? "";
  if (!color) return null;
  if (!(TEAM_BRAND_COLORS as readonly string[]).includes(color)) throw new Error(`invalid ${label} color`);
  return color;
}

async function isEmailVerified(actorId: string, database: Db): Promise<boolean> {
  const row = await database.query.user.findFirst({
    where: eq(schema.user.id, actorId),
    columns: { emailVerified: true },
  });
  return row?.emailVerified === true;
}

/** Find the org that auto-joins a given verified domain, if any. */
async function findAutoJoinOrg(domain: string, database: Db) {
  return database.query.organizations.findFirst({
    where: and(
      sql`lower(${schema.organizations.domain}) = ${domain}`,
      eq(schema.organizations.domainAutoJoin, true),
    ),
  });
}

/**
 * Classify the authenticated user's email domain and, for corporate domains, surface a matching
 * domain-auto-join org (name + coarse counts only — never the org id, to avoid cross-tenant leakage).
 */
export async function getOnboardingContext(
  actor: ActorContext,
  database: Db = db,
): Promise<OnboardingContextResult> {
  const { domain, isPersonal } = classifyEmailDomain(actor.email);
  const base = { email: actor.email, domain, isPersonal, matchedOrg: null as OnboardingMatchedOrg | null };
  if (!domain || isPersonal) return base;

  const org = await findAutoJoinOrg(domain, database);
  if (!org) return base;

  // Don't offer to join an org the user already belongs to.
  const existing = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.orgId, org.id), eq(schema.memberships.userId, actor.id)),
  });
  if (existing) return base;

  const [members] = await database
    .select({ value: count() })
    .from(schema.memberships)
    .where(eq(schema.memberships.orgId, org.id));
  const [teams] = await database
    .select({ value: count() })
    .from(schema.teams)
    .where(eq(schema.teams.orgId, org.id));

  return {
    ...base,
    matchedOrg: {
      name: org.name,
      domain: org.domain ?? domain,
      memberCount: Number(members?.value ?? 0),
      teamCount: Number(teams?.value ?? 0),
    },
  };
}

/**
 * Join the domain-auto-join org for the actor's verified email domain. The org is re-derived server-side
 * from the email (a client never supplies an org id), and joining requires a verified email when gated.
 */
export async function joinOrgByDomain(actor: ActorContext, database: Db = db): Promise<{ orgId: string }> {
  const { domain, isPersonal } = classifyEmailDomain(actor.email);
  if (!domain || isPersonal) throw new Error("no organization to join for this email domain");

  const org = await findAutoJoinOrg(domain, database);
  if (!org) throw new Error("no organization to join for this email domain");

  if (requireVerifiedForDomainJoin() && !(await isEmailVerified(actor.id, database))) {
    throw new Error("verify your email to join this organization");
  }

  await database.transaction(async (tx) => {
    await tx
      .insert(schema.memberships)
      .values({ orgId: org.id, userId: actor.id, orgRole: "developer" })
      .onConflictDoNothing();
    await tx
      .update(schema.profiles)
      .set({ onboardedAt: new Date() })
      .where(and(eq(schema.profiles.id, actor.id), isNull(schema.profiles.onboardedAt)));
  });

  return { orgId: org.id };
}

/**
 * Atomically create the user's organization, first team, and invitations, and mark onboarding complete.
 * Domain claiming + auto-join are only honored for the actor's own (verified, when gated) work domain.
 */
export async function completeOnboarding(
  actor: ActorContext,
  input: CompleteOnboardingInput,
  database: Db = db,
): Promise<{ orgId: string; inviteTokens: Array<{ email: string; token: string }> }> {
  const { domain: actorDomain, isPersonal } = classifyEmailDomain(actor.email);

  // A domain may only be claimed (and auto-join enabled) for the actor's own corporate domain — this
  // stops a gmail user (or anyone) from squatting `bigcorp.com` and harvesting future signups.
  let orgDomain = input.org.domain?.trim().toLowerCase() || null;
  const ownsDomain = !!orgDomain && !isPersonal && orgDomain === actorDomain;
  if (orgDomain && !ownsDomain) orgDomain = null;

  let domainAutoJoin = !!input.org.autoJoin && ownsDomain;
  if (domainAutoJoin && requireVerifiedForDomainJoin() && !(await isEmailVerified(actor.id, database))) {
    throw new Error("verify your email to enable domain auto-join");
  }

  const orgColor = normalizeBrandColor(input.org.color, "org");
  const teamColor = normalizeBrandColor(input.team.color, "team");
  const inviteTokens: Array<{ email: string; token: string }> = [];

  const orgId = await database
    .transaction(async (tx) => {
      if (orgDomain) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:org-domain:${orgDomain}`}))`);
      }

      const [org] = await tx
        .insert(schema.organizations)
        .values({
          name: input.org.name,
          slug: uniqueSlug(input.org.name, crypto.randomUUID()),
          kind: "team",
          plan: "team",
          domain: orgDomain,
          domainAutoJoin,
          color: orgColor,
          logoUrl: input.org.logoUrl ?? null,
        })
        .returning();
      if (!org) throw new Error("could not create organization");

      await tx.insert(schema.memberships).values({ orgId: org.id, userId: actor.id, orgRole: "owner" });

      const [team] = await tx
        .insert(schema.teams)
        .values({
          orgId: org.id,
          name: input.team.name,
          slug: uniqueSlug(input.team.name, crypto.randomUUID()),
          color: teamColor,
          icon: input.team.icon ?? null,
        })
        .returning();
      if (!team) throw new Error("could not create team");
      await tx
        .insert(schema.teamMemberships)
        .values({ orgId: org.id, teamId: team.id, userId: actor.id, teamRole: "admin" });

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
      if (message.includes("organizations_domain_uq")) {
        throw new Error("an organization already exists for this domain");
      }
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
