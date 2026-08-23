import { sessionFromIdentity } from "./session-state";
import type { Session, WhoAmI } from "./types";
import { ApiError } from "./types";

export type SignInResult = {
  error: string | null;
  reason: "credentials" | "network" | "google" | "callback" | "cancelled" | null;
};

type GoogleSignInPort = {
  clear(): Promise<void>;
  start(): Promise<{ ok: boolean }>;
  getCookie(): string;
  identify(cookie: string): Promise<WhoAmI>;
};

type GoogleSignInOutcome = SignInResult & { session: Session | null };

export async function exchangeGoogleSession(port: GoogleSignInPort): Promise<GoogleSignInOutcome> {
  await port.clear();
  try {
    const started = await port.start();
    if (!started.ok) {
      await port.clear();
      return {
        session: null,
        error: "Google sign-in is unavailable. Try again later.",
        reason: "google",
      };
    }

    const cookie = port.getCookie();
    if (!cookie) {
      await port.clear();
      return {
        session: null,
        error: "Google sign-in was cancelled or could not be completed.",
        reason: "cancelled",
      };
    }

    const identity = await port.identify(cookie);
    return { session: sessionFromIdentity(cookie, identity), error: null, reason: null };
  } catch (cause) {
    await port.clear();
    if (cause instanceof ApiError && cause.status === 0) {
      return {
        session: null,
        error: "The server could not be reached. Check the API address and try again.",
        reason: "network",
      };
    }
    if (cause instanceof ApiError) {
      return {
        session: null,
        error: "Google returned a session that the server could not validate. Please try again.",
        reason: "callback",
      };
    }
    return {
      session: null,
      error: "Google sign-in was cancelled or could not be completed.",
      reason: "cancelled",
    };
  }
}
