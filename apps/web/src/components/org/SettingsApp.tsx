"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { OrgRole, TeamRole } from "@companion/contracts";
import {
  addTeamMember as addTeamMemberRpc,
  createTeam as createTeamRpc,
  deleteTeam as deleteTeamRpc,
  inviteMember as inviteMemberRpc,
  issueToken as issueTokenRpc,
  listTokens as listTokensRpc,
  removeMember as removeMemberRpc,
  removeTeamMember as removeTeamMemberRpc,
  revokeInvite as revokeInviteRpc,
  revokeToken as revokeTokenRpc,
  setMemberRole as setMemberRoleRpc,
  setTeamMemberRole as setTeamMemberRoleRpc,
  updateMe as updateMeRpc,
  updateOrg as updateOrgRpc,
  updateTeam as updateTeamRpc,
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
  const teams = Array.isArray(org.teams)
    ? org.teams.map((team) => ({
        ...team,
        members: Array.isArray(team.members) ? team.members : [],
      }))
    : [];
  return { ...org, members, teams };
}

/** Build the canonical settings URL: `?view=` (+ `&team=` for team panes, `&dialog=`). */
export function settingsHref(route: SettingsRoute, dialog: SettingsDialog): string {
  const qs = new URLSearchParams();
  qs.set("view", route.view);
  if (route.teamId && (route.view === "team-general" || route.view === "team-members")) {
    qs.set("team", route.teamId);
  }
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
  const [users, setUsers] = useState(data.users);
  const [apiKeys, setApiKeys] = useState<ApiKeyVM[]>(data.apiKeys);
  const [invites, setInvites] = useState<Invite[]>(data.invites);
  useEffect(() => {
    router.prefetch("/skills");
  }, [router]);
  useEffect(() => {
    setCurrent(normalizeOrgFull(data.current));
    setUsers(data.users);
    setApiKeys(data.apiKeys);
    setInvites(data.invites);
  }, [data.current, data.users, data.apiKeys, data.invites]);
  useEffect(() => {
    document.cookie = `companion_org=${encodeURIComponent(data.current.id)}; path=/; SameSite=Lax`;
  }, [data.current.id]);
  const [busy, setBusy] = useState(false);

  const [route, setRoute] = useState<SettingsRoute>(initialRoute);
  const [dialog, setDialog] = useState<SettingsDialog>(initialDialog);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = new Set<string>();
    if (initialRoute.teamId) open.add(initialRoute.teamId);
    const first = data.current.teams[0];
    if (first) open.add(first.id);
    return open;
  });
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

  const toggleTeam = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

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
    user: (id) => users[id] ?? { id, name: id, initials: "?", email: "" },
    currentOrg: current,
    myId: me.id,
    myRole: current.myRole,
    canManage: current.myRole === "owner" || current.myRole === "admin",
    isOwner: current.myRole === "owner",
    ownerCount: (org) => org.members.filter((m) => m.role === "owner" && !m.pending).length,
    prefs,
    setTheme,
    setAccent,
    setMyName: (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const initials = initialsOf(trimmed);
      const prev: SeedUser = users[me.id] ?? { id: me.id, name: me.name, initials: me.initials, email: me.email };
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
        .then((res) => setCurrent((c) => ({ ...c, name: res.name, slug: res.slug })))
        .catch((e: Error) => {
          setErr(e.message);
          void refreshSettingsData();
        })
        .finally(() => setBusy(false));
    },
    updateTeam: (teamId, patch) => {
      setCurrent((c) => ({
        ...c,
        teams: c.teams.map((t) => (t.id === teamId ? { ...t, ...patch } : t)),
      }));
      setBusy(true);
      updateTeamRpc(teamId, patch)
        .then((res) =>
          setCurrent((c) => ({
            ...c,
            teams: c.teams.map((t) =>
              t.id === teamId ? { ...t, name: res.name, slug: res.slug, description: res.description ?? "" } : t,
            ),
          })),
        )
        .catch((e: Error) => {
          setErr(e.message);
          void refreshSettingsData();
        })
        .finally(() => setBusy(false));
    },
    deleteTeam: (teamId) =>
      optimistic(
        { ...current, teams: current.teams.filter((t) => t.id !== teamId) },
        () => deleteTeamRpc(teamId),
        () => {
          setExpanded((s) => {
            const n = new Set(s);
            n.delete(teamId);
            return n;
          });
          navigate({ view: "general" });
        },
      ),
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
          teams: current.teams.map((t) => ({ ...t, members: t.members.filter((x) => x.userId !== userId) })),
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
    setTeamMemberRole: (_orgId, teamId, userId, role: TeamRole) =>
      optimistic(
        {
          ...current,
          teams: current.teams.map((t) =>
            t.id === teamId ? { ...t, members: t.members.map((m) => (m.userId === userId ? { ...m, role } : m)) } : t,
          ),
        },
        () => setTeamMemberRoleRpc(teamId, userId, role),
      ),
    removeTeamMember: (_orgId, teamId, userId) =>
      optimistic(
        {
          ...current,
          teams: current.teams.map((t) =>
            t.id === teamId ? { ...t, members: t.members.filter((m) => m.userId !== userId) } : t,
          ),
        },
        () => removeTeamMemberRpc(teamId, userId),
      ),
    addTeamMember: (orgId, teamId, userId, role: TeamRole) =>
      optimistic(
        {
          ...current,
          teams: current.teams.map((t) =>
            t.id === teamId ? { ...t, members: [...t.members, { userId, role }] } : t,
          ),
        },
        () => addTeamMemberRpc(orgId, teamId, userId, role),
      ),
    createTeam: async (orgId, name) => {
      setBusy(true);
      try {
        const { id } = await createTeamRpc(orgId, name);
        await refreshSettingsData();
        setExpanded((s) => new Set([...s, id]));
        navigate({ view: "team-general", teamId: id });
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
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
        expanded={expanded}
        onView={onView}
        onDialog={onDialog}
        onToggleTeam={toggleTeam}
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
