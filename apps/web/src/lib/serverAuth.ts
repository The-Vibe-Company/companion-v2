import "server-only";

import { ServerApiError, serverApiFetch } from "./apiServer";

export const AUTH_RETRY_DELAYS_MS = [250, 750] as const;

export type ServerAuthState<T> =
  | { status: "authenticated"; user: T }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ServerApiError && error.status === 401;
}

function isTransient(error: unknown): boolean {
  return !(error instanceof ServerApiError) || error.status === 0 || error.status >= 500;
}

/**
 * Verify the browser session without turning a deploy-time API interruption into a logout.
 * Only an authoritative 401 means "sign in again"; network and 5xx failures get two short retries.
 */
export async function loadServerAuth<T = unknown>(): Promise<ServerAuthState<T>> {
  for (let attempt = 0; attempt <= AUTH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const user = await serverApiFetch<T>("/v1/auth/whoami");
      return { status: "authenticated", user };
    } catch (error) {
      if (isUnauthenticated(error)) return { status: "unauthenticated" };
      if (!isTransient(error) || attempt === AUTH_RETRY_DELAYS_MS.length) {
        return { status: "unavailable" };
      }
      await sleep(AUTH_RETRY_DELAYS_MS[attempt]!);
    }
  }

  return { status: "unavailable" };
}
