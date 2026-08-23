import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { configureApi, login, logout, whoami } from "./api";
import { secureStorage } from "./secure-storage";
import type { Session } from "./types";
import { ApiError } from "./types";

const sessionKey = "companion.native.session";

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

type SignInResult = { error: string | null; reason: "credentials" | "network" | null };
type SessionContextValue = {
  session: Session | null | undefined;
  bootstrapError: string | null;
  retryBootstrap(): void;
  signIn(email: string, password: string): Promise<SignInResult>;
  signOut(): Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const restoreGeneration = useRef(0);

  const clearSession = useCallback(async () => {
    restoreGeneration.current += 1;
    configureApi(null);
    setSession(null);
    setBootstrapError(null);
    // A failed cleanup must not strand the in-memory session state or leave the app on the splash.
    await secureStorage.removeItem(sessionKey).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const generation = restoreGeneration.current;
    const current = () => !cancelled && restoreGeneration.current === generation;
    void (async () => {
      setSession(undefined);
      setBootstrapError(null);

      let stored: string | null;
      try {
        stored = await secureStorage.getItem(sessionKey);
      } catch {
        // SecureStore can be temporarily unavailable (for example while the device is locked).
        // Keep the value recoverable instead of treating an unreadable store as a signed-out user.
        if (!current()) return;
        configureApi(null);
        if (current()) {
          setSession(null);
          setBootstrapError("Secure storage is temporarily unavailable. Try again to restore your session.");
        }
        return;
      }
      if (stored === null) {
        if (current()) setSession(null);
        return;
      }

      let restored: Session;
      try {
        // SAFETY: This app is the sole writer of the SecureStore value under this private key.
        // SAFETY: The JSON parser output is immediately checked as a ParsedJsonValue before any
        // persisted-session field is consumed.
        const parsed = JSON.parse(stored);
        const candidate = isParsedJsonObject(parsed) ? parsed : null;
        const cookie = parsedString(candidate?.cookie);
        const orgIdValue = candidate?.orgId;
        const orgId = orgIdValue === null ? null : parsedString(orgIdValue);
        const user = isParsedJsonObject(candidate?.user) ? candidate.user : null;
        const userId = parsedString(user?.id);
        const email = parsedString(user?.email);
        if (
          cookie === null
          || cookie.length === 0
          || (orgIdValue !== null && orgId === null)
          || user === null
          || userId === null
          || userId.length === 0
          || email === null
          || email.length === 0
        ) throw new Error("malformed stored session");
        restored = {
          cookie,
          orgId,
          user: { id: userId, email },
        };
      } catch {
        // A parse/schema failure is the one local condition that proves the persisted state is
        // unusable. Cleanup is best effort because SecureStore may still be unavailable.
        if (!current()) return;
        await secureStorage.removeItem(sessionKey).catch(() => undefined);
        configureApi(null);
        if (current()) setSession(null);
        return;
      }

      // Let the app recover with the last known-good cookie while whoami is offline or retryable.
      if (!current()) return;
      configureApi(restored, () => void clearSession());
      setSession(restored);

      try {
        const me = await whoami();
        if (!current()) return;
        const next: Session = {
          cookie: restored.cookie,
          orgId: me.org?.org_id ?? null,
          user: { id: me.userId, email: me.email },
        };
        configureApi(next, () => void clearSession());
        setSession(next);
        // Keep a valid in-memory session even if a rolling-session write is temporarily unavailable.
        await secureStorage.setItem(sessionKey, JSON.stringify(next)).catch(() => undefined);
      } catch (cause) {
        if (!current()) return;
        if (cause instanceof ApiError && cause.status === 401) {
          // Only an authoritative auth failure invalidates the persisted cookie.
          await clearSession();
          return;
        }
        // Network errors and authenticated 5xx responses are retryable; retain the restored state.
        configureApi(restored, () => void clearSession());
        setSession(restored);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clearSession, restoreAttempt]);

  const signIn = useCallback(async (email: string, password: string): Promise<SignInResult> => {
    configureApi(null);
    try {
      const { cookie, me } = await login(email.trim(), password);
      const next: Session = {
        cookie,
        orgId: me.org?.org_id ?? null,
        user: { id: me.userId, email: me.email },
      };
      await secureStorage.setItem(sessionKey, JSON.stringify(next));
      configureApi(next, () => void clearSession());
      setBootstrapError(null);
      setSession(next);
      return { error: null, reason: null };
    } catch (cause) {
      const network = cause instanceof ApiError && cause.status === 0;
      return {
        error: network
          ? "The server could not be reached. Check the API address and try again."
          : "The email or password was not accepted.",
        reason: network ? "network" : "credentials",
      };
    }
  }, [clearSession]);

  const signOut = useCallback(async () => {
    await logout().catch(() => undefined);
    await clearSession();
  }, [clearSession]);

  const retryBootstrap = useCallback(() => {
    restoreGeneration.current += 1;
    setRestoreAttempt((value) => value + 1);
  }, []);

  const value = useMemo(() => ({ session, bootstrapError, retryBootstrap, signIn, signOut }), [
    session,
    bootstrapError,
    retryBootstrap,
    signIn,
    signOut,
  ]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
