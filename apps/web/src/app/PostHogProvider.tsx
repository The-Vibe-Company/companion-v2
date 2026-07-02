"use client";

import { PostHogProvider as PHProvider } from "@posthog/react";
import posthog from "posthog-js";
import { useEffect, type ReactNode } from "react";

let posthogInitialized = false;

export function PostHogProvider({ children }: { children: ReactNode }) {
  const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

  useEffect(() => {
    if (!projectToken || posthogInitialized) return;

    posthog.init(projectToken, {
      api_host: host,
      defaults: "2026-05-30",
    });
    posthogInitialized = true;
  }, [host, projectToken]);

  if (!projectToken) return <>{children}</>;

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
