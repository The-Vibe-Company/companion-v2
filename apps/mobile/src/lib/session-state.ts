import type { Session, WhoAmI } from "./types";

type ParsedJsonValue = null | boolean | number | string | ParsedJsonObject | ParsedJsonValue[];
type ParsedJsonObject = { readonly [key: string]: ParsedJsonValue | undefined };

function isParsedJsonObject(value: ParsedJsonValue | undefined): value is ParsedJsonObject {
  // SAFETY: JSON.parse produces only JSON objects, arrays, and primitives; the tag and array checks
  // establish the object shape before any persisted-session fields are read.
  return value !== null
    && !Array.isArray(value)
    && Object.prototype.toString.call(value) === "[object Object]";
}

function parsedString(value: ParsedJsonValue | undefined): string | null {
  // SAFETY: JSON.parse cannot produce boxed strings or custom toString tags at this boundary.
  return Object.prototype.toString.call(value) === "[object String]" ? String(value) : null;
}

function parsedBoolean(value: ParsedJsonValue | undefined): boolean | null {
  if (Object.prototype.toString.call(value) !== "[object Boolean]") return null;
  return value === true;
}

export function parseStoredSession(stored: string): Session {
  // SAFETY: The JSON parser output is checked as a ParsedJsonValue before persisted fields are used.
  const parsed = JSON.parse(stored);
  const candidate = isParsedJsonObject(parsed) ? parsed : null;
  const cookie = parsedString(candidate?.cookie);
  const orgIdValue = candidate?.orgId;
  const orgId = orgIdValue === null ? null : parsedString(orgIdValue);
  const user = isParsedJsonObject(candidate?.user) ? candidate.user : null;
  const userId = parsedString(user?.id);
  const email = parsedString(user?.email);
  const nameValue = user?.name;
  const name = nameValue === undefined || nameValue === null ? null : parsedString(nameValue);
  const onboardingValue = candidate?.needsOnboarding;
  const needsOnboarding = onboardingValue === undefined ? null : parsedBoolean(onboardingValue);
  if (
    cookie === null
    || cookie.length === 0
    || (orgIdValue !== null && orgId === null)
    || user === null
    || userId === null
    || userId.length === 0
    || email === null
    || email.length === 0
    || (nameValue !== undefined && nameValue !== null && name === null)
    || (onboardingValue !== undefined && needsOnboarding === null)
  ) throw new Error("malformed stored session");

  return {
    cookie,
    orgId,
    needsOnboarding: needsOnboarding ?? orgId === null,
    user: { id: userId, email, name },
  };
}

export function sessionFromIdentity(cookie: string, me: WhoAmI): Session {
  const orgId = me.org?.org_id ?? null;
  return {
    cookie,
    orgId,
    needsOnboarding: me.needsOnboarding || orgId === null,
    user: { id: me.userId, email: me.email, name: me.name ?? null },
  };
}

export function onboardSession(session: Session, orgId: string): Session {
  return { ...session, orgId, needsOnboarding: false };
}

export function renameSessionUser(session: Session, name: string): Session {
  return { ...session, user: { ...session.user, name } };
}

export function sameSessionAuthority(current: Session | null | undefined, expected: Session): current is Session {
  return current?.cookie === expected.cookie && current.user.id === expected.user.id;
}

export function profileInitials(nameOrEmail: string): string {
  const parts = nameOrEmail.trim().split(/[.\s@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function isRevokedSessionStatus(status: number): boolean {
  return status === 401;
}

export async function clearSessionAuthorities(
  removePersistedSession: () => Promise<void>,
  clearGoogleSession: () => Promise<void>,
): Promise<void> {
  await Promise.all([
    removePersistedSession().catch(() => undefined),
    clearGoogleSession().catch(() => undefined),
  ]);
}

export type SessionLocation = "app" | "login" | "onboarding" | "other";
export type SessionRedirect = "/(app)" | "/(auth)/login" | "/(auth)/onboarding" | null;

export function sessionRedirect(
  session: Session | null,
  location: SessionLocation,
): SessionRedirect {
  if (!session && (location === "app" || location === "onboarding")) return "/(auth)/login";
  if (session?.needsOnboarding && location !== "onboarding") return "/(auth)/onboarding";
  if (session && !session.needsOnboarding && location !== "app") return "/(app)";
  return null;
}
