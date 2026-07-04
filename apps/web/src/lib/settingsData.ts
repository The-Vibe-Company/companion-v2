import "server-only";

import { redirect } from "next/navigation";
import { loadOrgContext } from "@/lib/currentOrg";
import { serverApiFetch } from "@/lib/apiServer";
import {
  buildSettingsAppData,
  initialsOf,
  parseApiTokensResponse,
  parseOrgSettingsResponse,
} from "@/lib/settingsViewModel";
import type { SettingsAppData, SettingsDialog, SettingsRoute, SettingsView } from "@/components/org/model";
import type { MeVM } from "@/lib/types";

export type SettingsSearchParams = Promise<Record<string, string | string[] | undefined>>;
export { parseOrgSettingsResponse } from "@/lib/settingsViewModel";

const SETTINGS_VIEWS: readonly SettingsView[] = [
  "profile",
  "preferences",
  "providers",
  "apikeys",
  "general",
  "members",
  "invitations",
];

function isSettingsView(value: string): value is SettingsView {
  return (SETTINGS_VIEWS as readonly string[]).includes(value);
}

function parseSettingsState(sp: Record<string, string | string[] | undefined>): {
  initialRoute: SettingsRoute;
  initialDialog: SettingsDialog;
} {
  const viewRaw = typeof sp.view === "string" ? sp.view : undefined;
  const view: SettingsView = viewRaw && isSettingsView(viewRaw) ? viewRaw : "profile";
  const dialogRaw = typeof sp.dialog === "string" ? sp.dialog : undefined;
  const initialDialog: SettingsDialog = dialogRaw === "invite" ? dialogRaw : null;
  return { initialRoute: { view }, initialDialog };
}

export async function loadSettingsPageData(searchParams: SettingsSearchParams): Promise<{
  data: SettingsAppData;
  initialRoute: SettingsRoute;
  initialDialog: SettingsDialog;
} | null> {
  const whoami = await serverApiFetch<{
    userId: string;
    email: string;
    name: string;
    avatarUrl?: string | null;
    needsOnboarding?: boolean;
  }>("/v1/auth/whoami").catch(() => null);
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
    avatarUrl: whoami.avatarUrl ?? null,
  };

  const settingsRaw = await serverApiFetch<unknown>("/v1/orgs/current/settings", {
    headers: orgHeaders,
  }).catch(() => null);
  if (settingsRaw === null) return null;
  const settings = parseOrgSettingsResponse(settingsRaw);
  if (!settings) return null;

  // Personal access tokens live on their own endpoint; a failed fetch degrades to an empty list.
  const tokensRaw = await serverApiFetch<unknown>("/v1/tokens", {
    headers: orgHeaders,
  }).catch(() => null);
  const tokens = parseApiTokensResponse(tokensRaw);

  const state = parseSettingsState(await searchParams);
  return {
    ...state,
    data: buildSettingsAppData({ me, current, settings, tokens }),
  };
}
