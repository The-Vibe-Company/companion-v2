import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { configureApi, login, logout, updateProfile as updateProfileRequest, whoami } from "./api";
import { authClient, clearGoogleAuthSession } from "./auth-client";
import { exchangeGoogleSession, type SignInResult } from "./google-sign-in";
import { secureStorage } from "./secure-storage";
import {
  clearSessionAuthorities,
  isRevokedSessionStatus,
  onboardSession,
  parseStoredSession,
  renameSessionUser,
  sameSessionAuthority,
  sessionFromIdentity,
} from "./session-state";
import type { Session } from "./types";
import { ApiError } from "./types";

const sessionKey = "companion.native.session";

type SessionContextValue = {
  session: Session | null | undefined;
  bootstrapError: string | null;
  retryBootstrap(): void;
  signIn(email: string, password: string): Promise<SignInResult>;
  signInWithGoogle(): Promise<SignInResult>;
  finishOnboarding(orgId: string): Promise<void>;
  updateProfile(name: string): Promise<void>;
  signOut(): Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const restoreGeneration = useRef(0);
  const sessionRevision = useRef(0);
  const sessionRef = useRef<Session | null | undefined>(undefined);
  const sessionStorageQueue = useRef<Promise<void>>(Promise.resolve());

  const runSessionStorageMutation = useCallback((operation: () => Promise<void>): Promise<void> => {
    const pending = sessionStorageQueue.current.then(operation, operation);
    sessionStorageQueue.current = pending.catch(() => undefined);
    return pending;
  }, []);

  const publishSession = useCallback((next: Session | null | undefined) => {
    sessionRevision.current += 1;
    sessionRef.current = next;
    setSession(next);
  }, []);

  const clearSession = useCallback(async () => {
    restoreGeneration.current += 1;
    configureApi(null);
    publishSession(null);
    setBootstrapError(null);
    // Both stores hold bearer authority after Google sign-in. Cleanup remains best effort so a
    // locked keychain or offline sign-out cannot strand the UI on the splash screen.
    await clearSessionAuthorities(
      () => runSessionStorageMutation(() => secureStorage.removeItem(sessionKey)),
      clearGoogleAuthSession,
    );
  }, [publishSession, runSessionStorageMutation]);

  const persistSession = useCallback(async (
    next: Session,
    generation = restoreGeneration.current,
    expectedRevision?: number,
  ): Promise<boolean> => {
    const isCurrent = () => restoreGeneration.current === generation
      && (expectedRevision === undefined || sessionRevision.current === expectedRevision);
    let stored = false;
    await runSessionStorageMutation(async () => {
      if (!isCurrent()) return;
      await secureStorage.setItem(sessionKey, JSON.stringify(next));
      stored = isCurrent();
    });
    if (!stored || !isCurrent()) return false;
    configureApi(next, () => void clearSession());
    setBootstrapError(null);
    publishSession(next);
    return true;
  }, [clearSession, publishSession, runSessionStorageMutation]);

  useEffect(() => {
    let cancelled = false;
    const generation = restoreGeneration.current;
    const current = () => !cancelled && restoreGeneration.current === generation;
    void (async () => {
      publishSession(undefined);
      setBootstrapError(null);

      let stored: string | null;
      try {
        stored = await secureStorage.getItem(sessionKey);
      } catch {
        // SecureStore can be temporarily unavailable (for example while the device is locked).
        // Keep the value recoverable instead of treating an unreadable store as a signed-out user.
        if (!current()) return;
        configureApi(null);
        publishSession(null);
        setBootstrapError("Secure storage is temporarily unavailable. Try again to restore your session.");
        return;
      }
      if (stored === null) {
        if (current()) publishSession(null);
        return;
      }

      let restored: Session;
      try {
        // SAFETY: This app is the sole writer of the SecureStore value under this private key.
        restored = parseStoredSession(stored);
      } catch {
        // A parse/schema failure is the one local condition that proves the persisted state is
        // unusable. Cleanup is best effort because SecureStore may still be unavailable.
        if (!current()) return;
        await runSessionStorageMutation(() => secureStorage.removeItem(sessionKey)).catch(() => undefined);
        configureApi(null);
        publishSession(null);
        return;
      }

      // Let the app recover with the last known-good cookie while whoami is offline or retryable.
      if (!current()) return;
      configureApi(restored, () => void clearSession());
      publishSession(restored);
      const restoredRevision = sessionRevision.current;

      try {
        const me = await whoami();
        if (!current() || sessionRevision.current !== restoredRevision) return;
        const next = sessionFromIdentity(restored.cookie, me);
        configureApi(next, () => void clearSession());
        publishSession(next);
        // Keep a valid in-memory session even if a rolling-session write is temporarily unavailable.
        await runSessionStorageMutation(async () => {
          if (current()) await secureStorage.setItem(sessionKey, JSON.stringify(next));
        }).catch(() => undefined);
      } catch (cause) {
        if (!current()) return;
        if (cause instanceof ApiError && isRevokedSessionStatus(cause.status)) {
          // Only an authoritative auth failure invalidates the persisted cookie.
          await clearSession();
          return;
        }
        if (sessionRevision.current !== restoredRevision) return;
        // Network errors and authenticated 5xx responses are retryable; retain the restored state.
        configureApi(restored, () => void clearSession());
        publishSession(restored);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clearSession, publishSession, restoreAttempt, runSessionStorageMutation]);

  const signIn = useCallback(async (email: string, password: string): Promise<SignInResult> => {
    configureApi(null);
    try {
      const { cookie, me } = await login(email.trim(), password);
      await persistSession(sessionFromIdentity(cookie, me));
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
  }, [persistSession]);

  const signInWithGoogle = useCallback(async (): Promise<SignInResult> => {
    configureApi(null);
    const outcome = await exchangeGoogleSession({
      clear: clearGoogleAuthSession,
      start: async () => {
        const result = await authClient.signIn.social({
          provider: "google",
          callbackURL: "/",
          newUserCallbackURL: "/",
          errorCallbackURL: "/",
        });
        return { ok: !result.error };
      },
      getCookie: authClient.getCookie,
      identify: async (cookie) => {
        configureApi({
          cookie,
          orgId: null,
          needsOnboarding: true,
          user: { id: "pending", email: "pending", name: null },
        });
        return whoami();
      },
    });
    if (!outcome.session) {
      configureApi(null);
      return outcome;
    }
    try {
      await persistSession(outcome.session);
      return { error: null, reason: null };
    } catch {
      configureApi(null);
      await clearGoogleAuthSession();
      return {
        error: "The Google session could not be saved securely. Please try again.",
        reason: "google",
      };
    }
  }, [persistSession]);

  const finishOnboarding = useCallback(async (orgId: string) => {
    const current = sessionRef.current;
    if (!current) throw new Error("A signed-in session is required to finish onboarding.");
    const next = onboardSession(current, orgId);
    configureApi(next, () => void clearSession());
    publishSession(next);
    await runSessionStorageMutation(() => secureStorage.setItem(sessionKey, JSON.stringify(next))).catch(() => undefined);
  }, [clearSession, publishSession, runSessionStorageMutation]);

  const updateProfile = useCallback(async (name: string) => {
    const current = sessionRef.current;
    if (!current) throw new Error("A signed-in session is required to update the profile.");
    const generation = restoreGeneration.current;
    const profile = await updateProfileRequest(name);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = sessionRef.current;
      if (restoreGeneration.current !== generation || !sameSessionAuthority(latest, current)) return;
      const revision = sessionRevision.current;
      if (await persistSession(renameSessionUser(latest, profile.name), generation, revision)) return;
    }
    throw new Error("Your profile was updated, but this device could not refresh the session. Please try again.");
  }, [persistSession]);

  const signOut = useCallback(async () => {
    await logout().catch(() => undefined);
    await clearSession();
  }, [clearSession]);

  const retryBootstrap = useCallback(() => {
    restoreGeneration.current += 1;
    setRestoreAttempt((value) => value + 1);
  }, []);

  const value = useMemo(() => ({
    session,
    bootstrapError,
    retryBootstrap,
    signIn,
    signInWithGoogle,
    finishOnboarding,
    updateProfile,
    signOut,
  }), [
    session,
    bootstrapError,
    retryBootstrap,
    signIn,
    signInWithGoogle,
    finishOnboarding,
    updateProfile,
    signOut,
  ]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
