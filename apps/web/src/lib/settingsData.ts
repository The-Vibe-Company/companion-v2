import "server-only";

import { redirect } from "next/navigation";
import { loadOrgContext } from "@/lib/currentOrg";
import { serverApiFetch } from "@/lib/apiServer";
import { buildSettingsAppData, initialsOf, parseOrgSettingsResponse } from "@/lib/settingsViewModel";
import type { SettingsAppData, SettingsDialog, SettingsTab } from "@/components/org/model";
import type { MeVM } from "@/lib/types";

export type SettingsSearchParams = Promise<Record<string, string | string[] | undefined>>;
export { parseOrgSettingsResponse } from "@/lib/settingsViewModel";

function parseSettingsState(sp: Record<string, string | string[] | undefined>): {
  initialTab: SettingsTab;
  initialDialog: SettingsDialog;
} {
  const tabRaw = typeof sp.tab === "string" ? sp.tab : undefined;
  const initialTab: SettingsTab = tabRaw === "general" || tabRaw === "teams" ? tabRaw : "members";
  const dialogRaw = typeof sp.dialog === "string" ? sp.dialog : undefined;
  const initialDialog: SettingsDialog = dialogRaw === "invite" || dialogRaw === "team" ? dialogRaw : null;
  return { initialTab, initialDialog };
}

export async function loadSettingsPageData(searchParams: SettingsSearchParams): Promise<{
  data: SettingsAppData;
  initialTab: SettingsTab;
  initialDialog: SettingsDialog;
} | null> {
  const whoami = await serverApiFetch<{ userId: string; email: string; name: string; needsOnboarding?: boolean }>(
    "/v1/auth/whoami",
  ).catch(() => null);
  if (!whoami) redirect("/login");
  if (whoami.needsOnboarding) redirect("/onboarding");

  const orgContext = await loadOrgContext().catch(() => null);
  if (!orgContext) return null;
  const { current } = orgContext;
  if (!current) redirect("/onboarding");
  const orgHeaders = { "x-companion-org": current.id };

  const me: MeVM = {
    id: whoami.userId,
    name: whoami.name || whoami.email || "You",
    email: whoami.email,
    initials: initialsOf(whoami.name || whoami.email || "You"),
  };

  const settingsRaw = await serverApiFetch<unknown>("/v1/orgs/current/settings", {
    headers: orgHeaders,
  }).catch(() => null);
  if (settingsRaw === null) return null;
  const settings = parseOrgSettingsResponse(settingsRaw);
  if (!settings) return null;

  const state = parseSettingsState(await searchParams);
  return {
    ...state,
    data: buildSettingsAppData({ me, current, settings }),
  };
}
