import { eq } from "drizzle-orm";
import { db, schema, closeDb } from ".";
import { initialsFor } from "./ids";

async function main(): Promise<void> {
  const existing = await db.query.organizations.findFirst({
    where: eq(schema.organizations.slug, "acme"),
  });
  if (existing) return;

  await db.insert(schema.organizations).values({
    name: "Acme",
    slug: "acme",
    kind: "team",
    plan: "free",
  });

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
