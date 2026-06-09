"use client";

import type { SettingsAppData } from "@/components/org/model";
import type { MeVM, OrgVM } from "./types";
import { apiFetch } from "./apiClient";
import { buildSettingsAppData, parseOrgSettingsResponse } from "./settingsViewModel";

export async function fetchSettingsAppData(input: {
  me: MeVM;
  currentOrg: OrgVM;
}): Promise<SettingsAppData | null> {
  const raw = await apiFetch<unknown>("/v1/orgs/current/settings", {
    headers: { "x-companion-org": input.currentOrg.id },
  });
  const settings = parseOrgSettingsResponse(raw);
  if (!settings) return null;
  return buildSettingsAppData({ me: input.me, current: input.currentOrg, settings });
}
