import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db, schema } from "@companion/db";
import { passwordResetCodeEmail, sendTransactionalEmail, verificationCodeEmail } from "@companion/email";

export function getBetterAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret && process.env.NODE_ENV !== "production") {
    return "local-dev-only-better-auth-secret-change-in-production";
  }
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required");
  return secret;
}

/**
 * Google OAuth is opt-in: the "Continue with Google" button always renders, but the social provider is
 * only wired when both credentials are present. Without them, the web `/v1/auth/google` route returns a
 * friendly "unavailable" error instead of the config throwing at boot.
 */
function googleSocialProvider() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return {};
  return { google: { clientId, clientSecret } };
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
    // Email signups must confirm a 6-digit OTP (emailOTP plugin) before they get a session.
    requireEmailVerification: true,
  },
  emailVerification: {
    // After /email-otp/verify-email succeeds, create the session so the user lands logged in.
    autoSignInAfterVerification: true,
    // An unverified sign-in re-sends a fresh OTP so the UI can route straight to the verify screen.
    sendOnSignIn: true,
  },
  socialProviders: googleSocialProvider(),
  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 600, // seconds (10 minutes)
      // Take over email verification so confirmation uses a 6-digit code (not a magic link).
      overrideDefaultEmailVerification: true,
      async sendVerificationOTP({ email, otp, type }) {
        // `type` is "email-verification" (signup / verify / unverified sign-in) or
        // "forget-password" (password reset). Both delivered via the shared email sender (Resend in prod).
        const mail =
          type === "forget-password"
            ? passwordResetCodeEmail({ to: email, code: otp })
            : verificationCodeEmail({ to: email, code: otp });
        await sendTransactionalEmail(mail);
      },
    }),
  ],
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
