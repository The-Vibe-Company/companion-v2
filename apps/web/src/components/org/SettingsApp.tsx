"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { OrgRole } from "@companion/contracts";
import {
  addAccessDomain as addAccessDomainRpc,
  inviteMember as inviteMemberRpc,
  issueToken as issueTokenRpc,
  listTokens as listTokensRpc,
  removeMember as removeMemberRpc,
  removeAccessDomain as removeAccessDomainRpc,
  revokeInvite as revokeInviteRpc,
  revokeToken as revokeTokenRpc,
  setMemberRole as setMemberRoleRpc,
  updateMe as updateMeRpc,
  updateOrg as updateOrgRpc,
  uploadWorkspaceLogo as uploadWorkspaceLogoRpc,
  uploadUserAvatar as uploadUserAvatarRpc,
  removeUserAvatar as removeUserAvatarRpc,
} from "@/lib/org";
import {
  applyAccent,
  applyTheme,
  DEFAULT_PREFS,
  freezeAnim,
  readPrefs,
  subscribeSystemTheme,
  writePrefs,
  type Accent,
  type Prefs,
  type Theme,
} from "@/lib/theme";
import { initialsOf, mapApiKey } from "@/lib/settingsViewModel";
import { Onboarding } from "./Onboarding";
import { SettingsView } from "./SettingsView";
import { useOrgActions } from "./useOrgActions";
import type {
  ApiKeyVM,
  Invite,
  OrgCtx,
  OrgFull,
  SeedUser,
  SettingsAppData,
  SettingsDialog,
  SettingsRoute,
} from "./model";

function normalizeOrgFull(org: OrgFull): OrgFull {
  const members = Array.isArray(org.members) ? org.members : [];
  const accessDomains = Array.isArray(org.accessDomains) ? org.accessDomains : [];
  return { ...org, accessDomains, members };
}

/** Build the canonical settings URL: `?view=` (+ `&dialog=`). */
export function settingsHref(route: SettingsRoute, dialog: SettingsDialog): string {
  const qs = new URLSearchParams();
  qs.set("view", route.view);
  if (dialog) qs.set("dialog", dialog);
  return `/settings?${qs.toString()}`;
}

export function SettingsController({
  data,
  initialRoute,
  initialDialog,
  onClose,
  onRefreshData,
}: {
  data: SettingsAppData;
  initialRoute: SettingsRoute;
  initialDialog: SettingsDialog;
  onClose: () => void;
  onRefreshData?: () => Promise<SettingsAppData | null>;
}) {
  const router = useRouter();
  const actions = useOrgActions();
  const { me } = data;

  const [current, setCurrent] = useState<OrgFull>(() => normalizeOrgFull(data.current));
  const [domainJoin, setDomainJoin] = useState(data.domainJoin);
  const [users, setUsers] = useState(data.users);
  const [apiKeys, setApiKeys] = useState<ApiKeyVM[]>(data.apiKeys);
  const [invites, setInvites] = useState<Invite[]>(data.invites);
  useEffect(() => {
    router.prefetch("/skills");
  }, [router]);
  useEffect(() => {
    setCurrent(normalizeOrgFull(data.current));
    setDomainJoin(data.domainJoin);
    setUsers(data.users);
    setApiKeys(data.apiKeys);
    setInvites(data.invites);
  }, [data.current, data.domainJoin, data.users, data.apiKeys, data.invites]);
  useEffect(() => {
    document.cookie = `companion_org=${encodeURIComponent(data.current.id)}; path=/; SameSite=Lax`;
  }, [data.current.id]);
  const [busy, setBusy] = useState(false);

  const [route, setRoute] = useState<SettingsRoute>(initialRoute);
  const [dialog, setDialog] = useState<SettingsDialog>(initialDialog);
  useEffect(() => setRoute(initialRoute), [initialRoute]);
  useEffect(() => setDialog(initialDialog), [initialDialog]);

  // Keep the URL the source of truth for the active pane. Every pane change — clicks AND
  // programmatic navigation (after invite / create / delete) — goes through `navigate` so a
  // reload or back/forward restores the right pane.
  const replaceUrl = (r: SettingsRoute, d: SettingsDialog) => {
    window.history.replaceState(window.history.state, "", settingsHref(r, d));
  };
  const navigate = (r: SettingsRoute) => {
    setRoute(r);
    setDialog(null);
    replaceUrl(r, null);
  };

  // Per-device theme + accent prefs (localStorage), applied to <html> live.
  // Start from the SSR-safe default so the server-rendered HTML and the first
  // client render match (no hydration mismatch on the Preferences selection);
  // the persisted prefs are adopted after mount, below.
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const setTheme = (theme: Theme) => {
    freezeAnim();
    applyTheme(theme);
    setPrefs((p) => {
      const next = { ...p, theme };
      writePrefs(next);
      return next;
    });
  };
  // The pickers hand back plain string ids; narrow to the Accent union the theme lib expects.
  const setAccent = (accent: string) => {
    const value = accent as Accent;
    freezeAnim();
    applyAccent(value);
    setPrefs((p) => {
      const next = { ...p, accent: value };
      writePrefs(next);
      return next;
    });
  };

  // Adopt the persisted prefs into state after mount. The no-FOUC inline script in
  // layout.tsx already applied them to <html> at first paint, so we don't re-apply
  // here (re-applying from the DEFAULT_PREFS starting state would flash). This only
  // syncs the React state so the Preferences UI reflects the real selection.
  useEffect(() => {
    setPrefs(readPrefs());
  }, []);

  // Follow the OS color scheme while theme === "system" (light/dark are applied
  // eagerly by setTheme; first paint is handled by the inline script).
  useEffect(() => subscribeSystemTheme(prefs.theme), [prefs.theme]);

  const setErr = actions.setError;
  const refreshSettingsData = async () => {
    if (!onRefreshData) {
      router.refresh();
      return;
    }
    try {
      const next = await onRefreshData();
      if (!next) {
        router.refresh();
        return;
      }
      setUsers(next.users);
      setCurrent(normalizeOrgFull(next.current));
      setDomainJoin(next.domainJoin);
      setApiKeys(next.apiKeys);
      setInvites(next.invites);
    } catch (error) {
      setErr((error as Error).message);
    }
  };

  // Optimistic mutate: apply locally, call the RPC. On failure, resync from the server
  // (router.refresh) rather than restoring a captured snapshot — a stale snapshot could
  // clobber a newer in-flight mutation's successful result.
  const optimistic = (next: OrgFull, call: () => Promise<unknown>, after?: () => void) => {
    setCurrent(next);
    setBusy(true);
    call()
      .then(() => after?.())
      .catch((e: Error) => {
        setErr(e.message);
        void refreshSettingsData();
      })
      .finally(() => setBusy(false));
  };

  const ctx: OrgCtx = {
    user: (id) => users[id] ?? { id, name: id, initials: "?", email: "", avatarUrl: null },
    currentOrg: current,
    myId: me.id,
    myRole: current.myRole,
    canManage: current.myRole === "owner" || current.myRole === "admin",
    isOwner: current.myRole === "owner",
    ownerCount: (org) => org.members.filter((m) => m.role === "owner" && !m.pending).length,
    domainJoin,
    prefs,
    setTheme,
    setAccent,
    setMyName: (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const initials = initialsOf(trimmed);
      const prev: SeedUser = users[me.id] ?? { id: me.id, name: me.name, initials: me.initials, email: me.email, avatarUrl: me.avatarUrl };
      setUsers((u) => ({ ...u, [me.id]: { ...prev, name: trimmed, initials } }));
      setBusy(true);
      updateMeRpc(trimmed)
        .catch((e: Error) => {
          setErr(e.message);
          void refreshSettingsData();
        })
        .finally(() => setBusy(false));
    },
    setWorkspace: (patch) => {
      // Apply optimistically, then reconcile from the server response — the server slugifies
      // (trims/collapses dashes), so the raw client value would otherwise stick until reload.
      setCurrent((c) => ({ ...c, ...patch }));
      setBusy(true);
      updateOrgRpc(patch)
        .then((res) =>
          setCurrent((c) => ({
            ...c,
            name: res.name,
            slug: res.slug,
            domain: res.domain ?? null,
            domainAutoJoin: res.domainAutoJoin,
            color: res.color ?? null,
            logoUrl: res.logoUrl ?? null,
          })),
        )
        .catch((e: Error) => {
          setErr(e.message);
          void refreshSettingsData();
        })
        .finally(() => setBusy(false));
    },
    uploadWorkspaceLogo: async (file) => {
      setBusy(true);
      try {
        const res = await uploadWorkspaceLogoRpc(file);
        setCurrent((c) => ({
          ...c,
          name: res.name,
          slug: res.slug,
          domain: res.domain ?? null,
          domainAutoJoin: res.domainAutoJoin,
          color: res.color ?? null,
          logoUrl: res.logoUrl ?? null,
        }));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        void refreshSettingsData();
        throw e;
      } finally {
        setBusy(false);
      }
    },
    // Optimistically swap my avatar everywhere it reads from `users` (sidebar chip, members "you"
    // row). The server returns a freshly `?v=`-versioned URL so other surfaces cache-bust too.
    uploadUserAvatar: async (file) => {
      setBusy(true);
      try {
        const res = await uploadUserAvatarRpc(file);
        setUsers((u) => {
          const prev: SeedUser = u[me.id] ?? { id: me.id, name: me.name, initials: me.initials, email: me.email, avatarUrl: null };
          return { ...u, [me.id]: { ...prev, avatarUrl: res.avatarUrl ?? null } };
        });
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        void refreshSettingsData();
        throw e;
      } finally {
        setBusy(false);
      }
    },
    removeUserAvatar: async () => {
      setBusy(true);
      try {
        const res = await removeUserAvatarRpc();
        setUsers((u) => {
          const prev: SeedUser = u[me.id] ?? { id: me.id, name: me.name, initials: me.initials, email: me.email, avatarUrl: null };
          return { ...u, [me.id]: { ...prev, avatarUrl: res.avatarUrl ?? null } };
        });
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        void refreshSettingsData();
        throw e;
      } finally {
        setBusy(false);
      }
    },
    addAccessDomain: async (domain) => {
      setBusy(true);
      try {
        const added = await addAccessDomainRpc(domain);
        setCurrent((c) => ({
          ...c,
          accessDomains: c.accessDomains.some((item) => item.id === added.id)
            ? c.accessDomains
            : [...c.accessDomains, { id: added.id, domain: added.domain, createdAt: "today" }].sort((a, b) =>
                a.domain.localeCompare(b.domain),
              ),
        }));
      } catch (e) {
        setErr((e as Error).message);
        void refreshSettingsData();
        throw e;
      } finally {
        setBusy(false);
      }
    },
    removeAccessDomain: async (domainId) => {
      const prev = current.accessDomains;
      setCurrent((c) => ({ ...c, accessDomains: c.accessDomains.filter((domain) => domain.id !== domainId) }));
      setBusy(true);
      try {
        await removeAccessDomainRpc(domainId);
      } catch (e) {
        setErr((e as Error).message);
        setCurrent((c) => ({ ...c, accessDomains: prev }));
        void refreshSettingsData();
      } finally {
        setBusy(false);
      }
    },
    createApiKey: async (name, scope) => {
      setBusy(true);
      try {
        const scopes = scope === "write" ? (["skills:read", "skills:write"] as const) : (["skills:read"] as const);
        const issued = await issueTokenRpc({ name: name.trim(), scopes: [...scopes] });
        // The one-time secret is the important result — return it as soon as the key exists.
        // Refresh the masked list best-effort; if it fails, fall back to a full resync rather
        // than throwing (which would hide the just-created key + its reveal dialog).
        listTokensRpc()
          .then((rows) => setApiKeys(rows.map(mapApiKey)))
          .catch(() => void refreshSettingsData());
        return issued.token;
      } catch (e) {
        setErr((e as Error).message);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    revokeApiKey: (id) => {
      const prev = apiKeys;
      setApiKeys((ks) => ks.filter((k) => k.id !== id));
      setBusy(true);
      revokeTokenRpc(id)
        .catch((e: Error) => {
          setErr(e.message);
          setApiKeys(prev);
        })
        .finally(() => setBusy(false));
    },
    setMemberRole: (orgId, userId, role: OrgRole) =>
      optimistic(
        { ...current, members: current.members.map((m) => (m.userId === userId ? { ...m, role } : m)) },
        () => setMemberRoleRpc(orgId, userId, role),
      ),
    removeMember: (orgId, userId) =>
      optimistic(
        {
          ...current,
          members: current.members.filter((m) => m.userId !== userId),
        },
        () => removeMemberRpc(orgId, userId),
        userId === me.id
          ? () => {
              router.push("/skills");
              router.refresh();
            }
          : undefined,
      ),
    inviteMember: async (orgId, email, role: OrgRole) => {
      setBusy(true);
      try {
        const { token } = await inviteMemberRpc(orgId, email, role);
        await refreshSettingsData();
        navigate({ view: "invitations" });
        return token;
      } catch (e) {
        setErr((e as Error).message);
        return "";
      } finally {
        setBusy(false);
      }
    },
    revokeInvite: (_orgId, inviteId) => {
      const prev = invites;
      setInvites((list) => list.filter((i) => i.id !== inviteId));
      setBusy(true);
      revokeInviteRpc(inviteId)
        .catch((e: Error) => {
          setErr(e.message);
          setInvites(prev);
          void refreshSettingsData();
        })
        .finally(() => setBusy(false));
    },
    error: actions.error,
    setError: actions.setError,
    busy: busy || actions.busy,
  };

  const onView = navigate;
  const onDialog = (d: SettingsDialog) => {
    setDialog(d);
    replaceUrl(route, d);
  };

  return (
    <>
      <SettingsView
        ctx={ctx}
        route={route}
        dialog={dialog}
        apiKeys={apiKeys}
        invites={invites}
        onView={onView}
        onDialog={onDialog}
        onClose={onClose}
      />
      {actions.onboarding && (
        <Onboarding
          mode={actions.onboarding}
          onMode={actions.setOnboarding}
          onCreate={actions.createOrg}
          onJoin={actions.joinOrg}
          busy={actions.busy}
        />
      )}
    </>
  );
}

export function SettingsApp({
  data,
  initialRoute,
  initialDialog,
}: {
  data: SettingsAppData;
  initialRoute: SettingsRoute;
  initialDialog: SettingsDialog;
}) {
  const router = useRouter();
  return (
    <div className="app">
      <div className="main">
        <SettingsController
          data={data}
          initialRoute={initialRoute}
          initialDialog={initialDialog}
          onClose={() => router.push("/skills")}
        />
      </div>
    </div>
  );
}
