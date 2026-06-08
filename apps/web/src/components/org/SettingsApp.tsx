"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { OrgRole, TeamRole } from "@companion/contracts";
import {
  addTeamMember as addTeamMemberRpc,
  createTeam as createTeamRpc,
  inviteMember as inviteMemberRpc,
  removeMember as removeMemberRpc,
  removeTeamMember as removeTeamMemberRpc,
  revokeInvite as revokeInviteRpc,
  setMemberRole as setMemberRoleRpc,
  setTeamMemberRole as setTeamMemberRoleRpc,
} from "@/lib/org";
import { Onboarding } from "./Onboarding";
import { SettingsView } from "./SettingsView";
import { useOrgActions } from "./useOrgActions";
import type { OrgCtx, OrgFull, SettingsAppData, SettingsDialog, SettingsTab } from "./model";

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

export function SettingsController({
  data,
  initialTab,
  initialDialog,
  onClose,
}: {
  data: SettingsAppData;
  initialTab: SettingsTab;
  initialDialog: SettingsDialog;
  onClose: () => void;
}) {
  const router = useRouter();
  const actions = useOrgActions();
  const { me, users } = data;

  const [current, setCurrent] = useState<OrgFull>(() => normalizeOrgFull(data.current));
  useEffect(() => {
    router.prefetch("/skills");
  }, [router]);
  useEffect(() => setCurrent(normalizeOrgFull(data.current)), [data.current]);
  useEffect(() => {
    document.cookie = `companion_org=${encodeURIComponent(data.current.id)}; path=/; SameSite=Lax`;
  }, [data.current.id]);
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [dialog, setDialog] = useState<SettingsDialog>(initialDialog);
  useEffect(() => setTab(initialTab), [initialTab]);
  useEffect(() => setDialog(initialDialog), [initialDialog]);

  const setErr = actions.setError;

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
        router.refresh();
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
        userId === me.id ? () => { router.push("/skills"); router.refresh(); } : undefined,
      ),
    inviteMember: async (orgId, email, role: OrgRole) => {
      setBusy(true);
      try {
        const { token } = await inviteMemberRpc(orgId, email, role);
        router.refresh();
        return token;
      } catch (e) {
        setErr((e as Error).message);
        return "";
      } finally {
        setBusy(false);
      }
    },
    revokeInvite: (_orgId, inviteId) =>
      optimistic({ ...current, members: current.members.filter((m) => m.inviteId !== inviteId) }, () =>
        revokeInviteRpc(inviteId),
      ),
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
        await createTeamRpc(orgId, name);
        router.refresh();
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

  const pushUrl = (t: SettingsTab, d: SettingsDialog) => {
    const qs = new URLSearchParams();
    qs.set("tab", t);
    if (d) qs.set("dialog", d);
    router.replace(`/settings?${qs.toString()}`, { scroll: false });
  };
  const onTab = (t: SettingsTab) => { setTab(t); setDialog(null); pushUrl(t, null); };
  const onDialog = (d: SettingsDialog) => { setDialog(d); pushUrl(tab, d); };

  return (
    <>
      <SettingsView ctx={ctx} tab={tab} dialog={dialog} onTab={onTab} onDialog={onDialog} onClose={onClose} />
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
  initialTab,
  initialDialog,
}: {
  data: SettingsAppData;
  initialTab: SettingsTab;
  initialDialog: SettingsDialog;
}) {
  const router = useRouter();
  return (
    <div className="app">
      <div className="main">
        <SettingsController
          data={data}
          initialTab={initialTab}
          initialDialog={initialDialog}
          onClose={() => router.push("/skills")}
        />
      </div>
    </div>
  );
}
