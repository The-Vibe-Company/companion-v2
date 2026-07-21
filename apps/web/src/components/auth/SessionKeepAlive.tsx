"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export const SESSION_KEEPALIVE_THROTTLE_MS = 5 * 60 * 1_000;

/** Refresh the rolling Better Auth cookie when an authenticated browser becomes active. */
export function SessionKeepAlive() {
  const router = useRouter();
  const lastAttemptAt = useRef(Number.NEGATIVE_INFINITY);

  const refreshSession = useCallback(() => {
    const now = Date.now();
    if (now - lastAttemptAt.current < SESSION_KEEPALIVE_THROTTLE_MS) return;
    lastAttemptAt.current = now;

    void fetch("/v1/auth/whoami", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then((response) => {
        if (response.status === 401) router.refresh();
      })
      .catch(() => {
        // A transient API interruption must not clear local auth state or send the user to login.
      });
  }, [router]);

  useEffect(() => {
    refreshSession();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshSession();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [refreshSession]);

  return null;
}
