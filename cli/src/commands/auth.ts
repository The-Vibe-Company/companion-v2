import { isCancel, password as passwordPrompt, text } from "@clack/prompts";
import { getProfileConfig, saveProfileConfig } from "../lib/config";
import { clearSession, saveSession } from "../lib/session";
import { getClient } from "../lib/client";
import { CliError } from "../lib/errors";
import { emitJson, out, type GlobalOpts } from "../lib/output";

async function promptText(message: string): Promise<string> {
  const v = await text({ message });
  if (isCancel(v) || !v) throw new CliError("cancelled", 2);
  return String(v);
}
async function promptPassword(message: string): Promise<string> {
  const v = await passwordPrompt({ message });
  if (isCancel(v) || !v) throw new CliError("cancelled", 2);
  return String(v);
}

export interface LoginOpts {
  url?: string;
  email?: string;
  password?: string;
  signup?: boolean;
}

export async function login(opts: LoginOpts, g: GlobalOpts): Promise<void> {
  const existing = await getProfileConfig(g.profile).catch(() => ({ url: "", orgId: undefined }));
  const url = (opts.url ?? existing.url ?? process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
  const selectedOrgId = g.org ?? process.env.COMPANION_ORG_ID ?? existing.orgId;
  await saveProfileConfig(g.profile, { url, orgId: selectedOrgId });

  const email = opts.email ?? (await promptText("Email"));
  const pw = opts.password ?? (await promptPassword("Password"));

  const res = await fetch(`${url}${opts.signup ? "/v1/auth/signup" : "/v1/auth/login"}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: url },
    body: JSON.stringify({ email, password: pw, name: email.split("@")[0] ?? email }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string; error?: { message?: string } };
    throw new CliError(`login failed: ${json.error?.message ?? json.message ?? res.statusText}`, 3);
  }
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new CliError("login failed: auth server did not return a session cookie", 3);
  const whoami = await fetch(`${url}/v1/auth/whoami`, {
    headers: { cookie, ...(selectedOrgId ? { "x-companion-org": selectedOrgId } : {}) },
  });
  const me = (await whoami.json().catch(() => ({}))) as {
    userId: string;
    email: string;
    error?: string;
    org?: { org_id?: string } | null;
  };
  if (!whoami.ok) throw new CliError(`login failed: ${me.error ?? "could not resolve current user"}`, 3);
  // `whoami` falls back to the actor's first accessible organization when a remembered organization
  // was deleted or the actor lost membership. Persist that authoritative result so a reset local
  // workspace (or an org removal in production) cannot leave every later CLI request on a stale id.
  const resolvedOrgId = me.org?.org_id;
  await saveProfileConfig(g.profile, { url, orgId: resolvedOrgId });
  await saveSession(g.profile, { cookie, orgId: resolvedOrgId, user: { id: me.userId, email: me.email } });

  if (g.json) emitJson({ ok: true, user: { id: me.userId, email: me.email } });
  else out(`logged in as ${me.email}`);
}

export async function logout(g: GlobalOpts): Promise<void> {
  const cfg = await getProfileConfig(g.profile).catch(() => null);
  const session = await import("../lib/session").then((m) => m.loadSession(g.profile));
  if (cfg && session?.cookie) {
    await fetch(`${cfg.url}/v1/auth/logout`, {
      method: "POST",
      headers: { cookie: session.cookie, origin: cfg.url },
    }).catch(() => null);
  }
  await clearSession(g.profile);
  if (g.json) emitJson({ ok: true });
  else out("logged out");
}

export async function whoami(g: GlobalOpts): Promise<void> {
  const client = await getClient(g.profile, g.org);
  const me = await client.request<{ userId: string; email: string; org?: { slug?: string; name?: string }; role?: string }>(
    "/v1/auth/whoami",
  );
  if (g.json) {
    emitJson(me);
  } else {
    out(`user   ${me.email}`);
    out(`id     ${me.userId}`);
    out(`org    ${me.org?.slug ?? "-"} (${me.org?.name ?? "-"})`);
    out(`role   ${me.role ?? "-"}`);
  }
}
