import { eq } from "drizzle-orm";
import { db, schema, closeDb } from ".";
import { initialsFor } from "./ids";

async function main(): Promise<void> {
  const existing = await db.query.organizations.findFirst({
    where: eq(schema.organizations.slug, "acme"),
  });
  if (existing) return;

  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Acme",
      slug: "acme",
      kind: "team",
      plan: "free",
      // Legacy fields kept populated for compatibility; domain access now lives in organization_domains.
      domain: "acme.com",
      domainAutoJoin: true,
    })
    .returning({ id: schema.organizations.id });
  if (org) {
    await db.insert(schema.organizationDomains).values({ orgId: org.id, domain: "acme.com" }).onConflictDoNothing();
  }

  console.log("Seeded Acme workspace placeholder. Create the first user through the UI or CLI.");
  console.log(`Default initials helper loaded: ${initialsFor("admin@tvc.dev")}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
