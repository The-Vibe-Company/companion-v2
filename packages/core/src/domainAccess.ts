import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import type { OrgRole } from "@companion/contracts";
import { canManageOrg } from "./authz";
import { classifyEmailDomain } from "./email-domains";
import type { ActorContext } from "./services";

export interface OrgAccessDomain {
  id: string;
  domain: string;
  createdAt: string;
}

export interface DomainJoinableOrg {
  id: string;
  name: string;
  domain: string;
  memberCount: number;
  teamCount: number;
}

export function normalizeAccessDomain(value: string): string {
  const domain = value
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\//i, "")
    .replace(/^\/+/, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
  const labels = domain.split(".");
  const validLabels =
    labels.length >= 2 &&
    labels.every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
  if (!domain || domain.length > 253 || !validLabels || domain.includes(":") || domain.includes("*") || /\s/.test(domain)) {
    throw new Error("enter a valid email domain");
  }
  return domain;
}

export function requireVerifiedForDomainJoin(): boolean {
  const flag = process.env.COMPANION_REQUIRE_VERIFIED_DOMAIN_JOIN;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return process.env.NODE_ENV === "production";
}

export async function isActorEmailVerified(actorId: string, database: Db): Promise<boolean> {
  const row = await database.query.user.findFirst({
    where: eq(schema.user.id, actorId),
    columns: { emailVerified: true },
  });
  return row?.emailVerified === true;
}

async function getOrgRole(orgId: string, userId: string, database: Db): Promise<OrgRole | null> {
  const row = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)),
  });
  return (row?.orgRole as OrgRole | undefined) ?? null;
}

export async function listOrgAccessDomains(orgId: string, database: Db = db): Promise<OrgAccessDomain[]> {
  const rows = await database
    .select({
      id: schema.organizationDomains.id,
      domain: schema.organizationDomains.domain,
      createdAt: schema.organizationDomains.createdAt,
    })
    .from(schema.organizationDomains)
    .where(eq(schema.organizationDomains.orgId, orgId))
    .orderBy(asc(schema.organizationDomains.domain));
  return rows.map((row) => ({ id: row.id, domain: row.domain, createdAt: row.createdAt.toISOString() }));
}

export async function listJoinableOrgsByDomain(domain: string, actorId: string, database: Db = db): Promise<DomainJoinableOrg[]> {
  const normalized = normalizeAccessDomain(domain);
  const rows = await database
    .select({
      orgId: schema.organizations.id,
      name: schema.organizations.name,
      domain: schema.organizationDomains.domain,
    })
    .from(schema.organizationDomains)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.organizationDomains.orgId))
    .where(
      and(
        sql`lower(${schema.organizationDomains.domain}) = ${normalized}`,
        ne(schema.organizations.kind, "personal"),
        sql`not exists (
          select 1 from ${schema.memberships}
          where ${schema.memberships.orgId} = ${schema.organizations.id}
            and ${schema.memberships.userId} = ${actorId}
        )`,
      ),
    )
    .orderBy(asc(schema.organizations.name));

  const orgs: DomainJoinableOrg[] = [];
  for (const row of rows) {
    const [members] = await database
      .select({ value: count() })
      .from(schema.memberships)
      .where(eq(schema.memberships.orgId, row.orgId));
    orgs.push({
      id: row.orgId,
      name: row.name,
      domain: row.domain,
      memberCount: Number(members?.value ?? 0),
      // Teams were removed product-wide (Org → User); always 0. Kept for the onboarding read shape
      // until the API/web onboarding slices drop the field.
      teamCount: 0,
    });
  }
  return orgs;
}

export async function orgAllowsEmailDomain(input: {
  orgId: string;
  emailDomain: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const domain = normalizeAccessDomain(input.emailDomain);
  const row = await database.query.organizationDomains.findFirst({
    where: and(
      eq(schema.organizationDomains.orgId, input.orgId),
      sql`lower(${schema.organizationDomains.domain}) = ${domain}`,
    ),
  });
  return row != null;
}

export async function addOrgAccessDomain(input: {
  actor: ActorContext;
  orgId: string;
  domain: string;
  database?: Db;
}): Promise<OrgAccessDomain> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role || !canManageOrg(role)) throw new Error("not allowed to manage workspace domains");

  const org = await database.query.organizations.findFirst({
    where: eq(schema.organizations.id, input.orgId),
    columns: { kind: true },
  });
  if (!org) throw new Error("organization not found");
  if (org.kind !== "team") throw new Error("domain access is only available for team workspaces");

  const domain = normalizeAccessDomain(input.domain);
  const actorDomain = classifyEmailDomain(input.actor.email);
  if (!actorDomain.domain || actorDomain.isPersonal || actorDomain.domain !== domain) {
    throw new Error("you can only add your verified corporate email domain");
  }
  if (!(await isActorEmailVerified(input.actor.id, database))) {
    throw new Error("verify your email to add this domain");
  }

  const [row] = await database
    .insert(schema.organizationDomains)
    .values({ orgId: input.orgId, domain, createdBy: input.actor.id })
    .onConflictDoNothing()
    .returning({
      id: schema.organizationDomains.id,
      domain: schema.organizationDomains.domain,
      createdAt: schema.organizationDomains.createdAt,
    });

  if (row) return { id: row.id, domain: row.domain, createdAt: row.createdAt.toISOString() };

  const existing = await database.query.organizationDomains.findFirst({
    where: and(eq(schema.organizationDomains.orgId, input.orgId), sql`lower(${schema.organizationDomains.domain}) = ${domain}`),
  });
  if (!existing) throw new Error("could not add workspace domain");
  return { id: existing.id, domain: existing.domain, createdAt: existing.createdAt.toISOString() };
}

export async function removeOrgAccessDomain(input: {
  actor: ActorContext;
  orgId: string;
  domainId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role || !canManageOrg(role)) throw new Error("not allowed to manage workspace domains");
  await database
    .delete(schema.organizationDomains)
    .where(and(eq(schema.organizationDomains.orgId, input.orgId), eq(schema.organizationDomains.id, input.domainId)));
}
