import { getProfileConfig } from "./config";
import { loadSession } from "./session";
import { CliError } from "./errors";

export interface AuthedClient {
  url: string;
  cookie: string;
  orgId: string | null;
  userId: string;
  email: string;
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

export async function getClient(profile: string, orgId?: string): Promise<AuthedClient> {
  const { url, orgId: configuredOrgId } = await getProfileConfig(profile);
  const session = await loadSession(profile);
  if (!session?.cookie) throw new CliError("not logged in. Run: companion login", 3);
  const cookie = session.cookie;
  const selectedOrgId = orgId ?? process.env.COMPANION_ORG_ID ?? configuredOrgId ?? session.orgId ?? null;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }),
        cookie,
        ...(selectedOrgId ? { "x-companion-org": selectedOrgId } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new CliError(json.error ?? `request failed: ${res.status}`, res.status === 401 ? 3 : 8);
    return json as T;
  }

  const me = await request<{ userId: string; email: string; org?: { org_id?: string } | null }>("/v1/auth/whoami");
  return { url, cookie, orgId: selectedOrgId ?? me.org?.org_id ?? null, userId: me.userId, email: me.email, request };
}

export async function getOrgId(client: AuthedClient): Promise<string> {
  const me = await client.request<{ org?: { org_id?: string } | null }>("/v1/auth/whoami");
  const orgId = me.org?.org_id;
  if (!orgId) throw new CliError("no organization membership", 7);
  return orgId;
}
