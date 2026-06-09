"use client";

import type { SettingsAppData } from "@/components/org/model";
import type { MeVM, OrgVM } from "./types";
import { apiFetch } from "./apiClient";
import { buildSettingsAppData, parseApiTokensResponse, parseOrgSettingsResponse } from "./settingsViewModel";

export async function fetchSettingsAppData(input: {
  me: MeVM;
  currentOrg: OrgVM;
}): Promise<SettingsAppData | null> {
  const headers = { "x-companion-org": input.currentOrg.id };
  // Tokens are a separate, user-scoped endpoint — fetch alongside the org settings (mirrors the
  // server loader) so the in-app drawer's API-keys pane/count isn't empty. Token errors are
  // tolerated (empty list) so a token hiccup can't blank the whole drawer.
  const [raw, tokensRaw] = await Promise.all([
    apiFetch<unknown>("/v1/orgs/current/settings", { headers }),
    apiFetch<unknown>("/v1/tokens", { headers }).catch(() => null),
  ]);
  const settings = parseOrgSettingsResponse(raw);
  if (!settings) return null;
  const tokens = parseApiTokensResponse(tokensRaw);
  return buildSettingsAppData({ me: input.me, current: input.currentOrg, settings, tokens });
}
