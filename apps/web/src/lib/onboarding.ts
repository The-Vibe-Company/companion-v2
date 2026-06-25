"use client";

import { apiFetch } from "./apiClient";

export interface OnboardingMatchedOrg {
  id: string;
  name: string;
  domain: string;
  memberCount: number;
}

/** Client view of the email-domain classification driving the onboarding flow. */
export interface OnboardingContext {
  email: string;
  domain: string | null;
  isPersonal: boolean;
  matchedOrgs: OnboardingMatchedOrg[];
}

export interface CompleteOnboardingPayload {
  org: { name: string; domain?: string | null; autoJoin: boolean; color?: string | null; logoUrl?: string | null };
  invites: string[];
}

/** Join a selected domain-access org for the signed-in user's verified email domain. */
export async function joinByDomain(orgId: string): Promise<{ orgId: string }> {
  return apiFetch("/v1/onboarding/join", { method: "POST", body: JSON.stringify({ orgId }) });
}

/** Create the org + invites and finish onboarding. */
export async function completeOnboarding(payload: CompleteOnboardingPayload): Promise<{ orgId: string }> {
  return apiFetch("/v1/onboarding/create", { method: "POST", body: JSON.stringify(payload) });
}

export interface BrandIconCandidate {
  domain: string;
  url: string;
}

export type BrandIconLoader = (candidate: BrandIconCandidate) => Promise<boolean>;

/**
 * Best-effort brand-logo URL for a website/domain. The browser loads it directly (icon.horse);
 * if it 404s or is blocked, the create-org screen falls back to derived brand-color tiles.
 */
export function faviconUrl(domain: string): string {
  const clean = normalizeWebsiteDomain(domain);
  return `https://icon.horse/icon/${clean}`;
}

export function normalizeWebsiteDomain(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^\/+/, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
}

export function brandIconCandidates(value: string): BrandIconCandidate[] {
  const clean = normalizeWebsiteDomain(value);
  if (!clean) return [];

  const hosts = [clean];
  if (clean.startsWith("www.")) {
    hosts.push(clean.slice(4));
  } else {
    hosts.push(`www.${clean}`);
  }

  return Array.from(new Set(hosts)).map((domain) => ({ domain, url: faviconUrl(domain) }));
}

export async function firstLoadableBrandIconCandidate(
  candidates: BrandIconCandidate[],
  loadIcon: BrandIconLoader,
): Promise<BrandIconCandidate | null> {
  for (const candidate of candidates) {
    if (await loadIcon(candidate)) return candidate;
  }
  return null;
}
