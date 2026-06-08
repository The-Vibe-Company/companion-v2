"use client";

import { apiFetch } from "./apiClient";

export interface OnboardingMatchedOrg {
  name: string;
  domain: string;
  memberCount: number;
  teamCount: number;
}

/** Client view of the email-domain classification driving the onboarding flow. */
export interface OnboardingContext {
  email: string;
  domain: string | null;
  isPersonal: boolean;
  matchedOrg: OnboardingMatchedOrg | null;
}

export interface CompleteOnboardingPayload {
  org: { name: string; domain?: string | null; autoJoin: boolean; color?: string | null; logoUrl?: string | null };
  team: { name: string; color?: string | null; icon?: string | null };
  invites: string[];
}

/** Join the domain-auto-join org for the signed-in user's verified email domain. */
export async function joinByDomain(): Promise<{ orgId: string }> {
  return apiFetch("/v1/onboarding/join", { method: "POST" });
}

/** Create the org + first team + invites and finish onboarding. */
export async function completeOnboarding(payload: CompleteOnboardingPayload): Promise<{ orgId: string }> {
  return apiFetch("/v1/onboarding/create", { method: "POST", body: JSON.stringify(payload) });
}

/**
 * Best-effort brand-logo URL for a website/domain. The browser loads it directly (icon.horse);
 * if it 404s or is blocked, the create-org screen falls back to derived brand-color tiles.
 */
export function faviconUrl(domain: string): string {
  const clean = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase();
  return `https://icon.horse/icon/${clean}`;
}
