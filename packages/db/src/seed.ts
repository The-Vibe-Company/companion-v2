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
      // Legacy fields kept populated for compatibility; domain access now lives in organization_domains.
      domain: "acme.com",
      domainAutoJoin: true,
    })
    .returning({ id: schema.organizations.id });
  if (org) {
    await db.insert(schema.organizationDomains).values({ orgId: org.id, domain: "acme.com" }).onConflictDoNothing();
    // Seed one empty label so the folder tree is non-trivial before any skill is filed. Empty
    // folders are first-class: a `labels` row with no matching `skill_labels` still shows in the tree.
    await db
      .insert(schema.labels)
      .values([
        { orgId: org.id, path: "growth" },
        { orgId: org.id, path: "marketing" },
        { orgId: org.id, path: "marketing/seo" },
      ])
      .onConflictDoNothing();
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
