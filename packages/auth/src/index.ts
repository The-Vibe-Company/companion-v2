import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db, schema } from "@companion/db";

export function getBetterAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret && process.env.NODE_ENV !== "production") {
    return "local-dev-only-better-auth-secret-change-in-production";
  }
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required");
  return secret;
}

function trustedOrigins(): string[] {
  const webUrl = process.env.COMPANION_WEB_URL;
  const authUrl = process.env.BETTER_AUTH_URL;
  const apiUrl = process.env.COMPANION_API_URL;
  const devLoopbackOrigins =
    process.env.NODE_ENV === "production" ? [] : ["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"];

  return Array.from(
    new Set(
      [
        webUrl,
        webUrl?.replace("127.0.0.1", "localhost"),
        authUrl,
        authUrl?.replace("127.0.0.1", "localhost"),
        apiUrl,
        apiUrl?.replace("127.0.0.1", "localhost"),
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://127.0.0.1:3001",
        "http://localhost:3001",
        "http://127.0.0.1:3010",
        "http://localhost:3010",
        ...devLoopbackOrigins,
      ].filter((origin): origin is string => Boolean(origin)),
    ),
  );
}

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001",
  basePath: "/auth",
  secret: getBetterAuthSecret(),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  advanced: {
    cookiePrefix: process.env.BETTER_AUTH_COOKIE_PREFIX ?? "better-auth",
    database: {
      generateId: () => crypto.randomUUID(),
    },
    defaultCookieAttributes: {
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  },
  trustedOrigins: trustedOrigins(),
});

export type Auth = typeof auth;
export type AuthSession = typeof auth.$Infer.Session;
