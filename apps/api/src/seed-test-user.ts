import { createOrg, ensureUserBootstrap, listOrgs, markOnboarded } from "@companion/core/services";
import { closeDb, db } from "@companion/db";

const DEFAULT_EMAIL = "admin@tvc.dev";
const DEFAULT_PASSWORD = "adminadmin";
const DEFAULT_NAME = "Admin";
const LOCAL_DATABASE_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function seedEmail(): string {
  return (process.env.COMPANION_SEED_EMAIL ?? DEFAULT_EMAIL).trim().toLowerCase();
}

function seedPassword(): string {
  return process.env.COMPANION_SEED_PASSWORD ?? DEFAULT_PASSWORD;
}

function seedName(email: string): string {
  return (process.env.COMPANION_SEED_NAME ?? DEFAULT_NAME).trim() || email.split("@")[0] || DEFAULT_NAME;
}

function assertLocalSeedAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("refusing to seed a test user when NODE_ENV=production");
  }

  if (process.env.COMPANION_ALLOW_TEST_USER_SEED === "1") {
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed a local test user");
  }

  const host = new URL(databaseUrl).hostname;
  if (!LOCAL_DATABASE_HOSTS.has(host)) {
    throw new Error(
      `refusing to seed a test user against non-local database host "${host}"; set COMPANION_ALLOW_TEST_USER_SEED=1 to override`,
    );
  }
}

function createdMessage(email: string, password: string): string {
  if (process.env.COMPANION_SEED_PASSWORD) {
    return `Seeded local test user ${email}; password was read from COMPANION_SEED_PASSWORD`;
  }
  return `Seeded local test user ${email} / ${password}`;
}

async function createAuthUser(input: { email: string; password: string; name: string }): Promise<void> {
  const { auth } = await import("@companion/auth");
  const authUrl = process.env.BETTER_AUTH_URL ?? process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001";
  const response = await auth.handler(
    new Request(`${authUrl.replace(/\/$/, "")}/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: authUrl,
      },
      body: JSON.stringify(input),
    }),
  );

  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as { message?: string; error?: { message?: string } };
    throw new Error(json.error?.message ?? json.message ?? `sign-up failed with ${response.status}`);
  }
}

async function main(): Promise<void> {
  assertLocalSeedAllowed();

  const email = seedEmail();
  const password = seedPassword();
  const name = seedName(email);

  let user = await db.query.user.findFirst({
    where: (table, { eq }) => eq(table.email, email),
  });
  const created = !user;

  if (!user) {
    await createAuthUser({ email, password, name });
    user = await db.query.user.findFirst({
      where: (table, { eq }) => eq(table.email, email),
    });
  }

  if (!user) throw new Error(`could not create seed user ${email}`);

  const actor = { id: user.id, email: user.email, name: user.name || name };
  await ensureUserBootstrap(actor);
  // The first-user auto-bootstrap was removed in favor of onboarding, so give the local test user a
  // workspace and mark them onboarded — keeps `pnpm dev` / browser:smoke landing on /skills, not /onboarding.
  const orgs = await listOrgs(actor);
  if (orgs.length === 0) {
    await createOrg({ actor, name: "Acme", kind: "team" });
  }
  await markOnboarded(actor);

  console.log(created ? createdMessage(email, password) : `Local test user ${email} already exists; leaving password unchanged`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
