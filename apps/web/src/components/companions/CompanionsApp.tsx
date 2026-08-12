"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { OrgVM } from "@/lib/types";
import { Icon } from "../Icon";
import { Onboarding } from "../org/Onboarding";
import { useOrgActions } from "../org/useOrgActions";
import { Sidebar } from "../skills/Sidebar";
import { skillsRouteHref, type SkillsLibrary } from "../skills/route";
import type { TreeRow } from "../skills/sidebarTree";

export interface CompanionNavigation {
  mineTreeRows: TreeRow[];
  orgTreeRows: TreeRow[];
  mineCount: number;
  orgCount: number;
  installedCount: number;
  installedUpdateCount: number;
  localUpdateCount: number;
  archivedCount: number;
}

export function CompanionsApp({
  orgs,
  currentOrg,
  navigation,
}: {
  orgs: OrgVM[];
  currentOrg: OrgVM;
  navigation: CompanionNavigation;
}) {
  const router = useRouter();
  const orgActions = useOrgActions();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const noop = () => {};

  const navigateToLabel = (lib: SkillsLibrary, path: string) => {
    router.push(skillsRouteHref({ lib, kind: "label", label: path }));
  };
  const toggleExpanded = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMobileSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileSidebarOpen]);

  return (
    <div className={"app app--skills companions-app" + (mobileSidebarOpen ? " app--side-open" : "")}>
      <Sidebar
        orgs={orgs}
        currentOrg={currentOrg}
        onSwitchOrg={orgActions.switchOrg}
        onOnboard={orgActions.setOnboarding}
        onOpenSettings={() => router.push("/settings")}
        onWarmSettings={noop}
        mineTreeRows={navigation.mineTreeRows}
        orgTreeRows={navigation.orgTreeRows}
        expanded={expanded}
        onToggleExpand={toggleExpanded}
        selection={null}
        mineCount={navigation.mineCount}
        orgCount={navigation.orgCount}
        installedCount={navigation.installedCount}
        installedUpdateCount={navigation.installedUpdateCount}
        onOpenPalette={() => router.push("/skills")}
        onSelectMineAll={() => router.push(skillsRouteHref({ lib: "mine", kind: "all" }))}
        onSelectOrgAll={() => router.push(skillsRouteHref({ lib: "org", kind: "all" }))}
        onSelectInstalled={() => router.push(skillsRouteHref({ lib: "mine", kind: "installed" }))}
        onSelectLabel={navigateToLabel}
        onCreateLabel={noop}
        onSetLabelColor={noop}
        onSetLabelIcon={noop}
        onRenameLabel={noop}
        onDeleteLabel={noop}
        drag={null}
        hovered={null}
        openPendingPath={null}
        dropDone={null}
        onReparentLabel={noop}
        onLabelStartDrag={noop}
        onSelectLocal={() => router.push(skillsRouteHref({ kind: "local" }))}
        onSelectArchived={() => router.push(skillsRouteHref({ kind: "archived" }))}
        onSelectSecrets={() => router.push("/secrets")}
        onSelectCompanions={noop}
        companionsEnabled
        companionsActive
        navigationOnly
        localActive={false}
        localUpdateCount={navigation.localUpdateCount}
        archivedActive={false}
        archivedCount={navigation.archivedCount}
        mobileOpen={mobileSidebarOpen}
        onToggleMobile={() => setMobileSidebarOpen((open) => !open)}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />
      {mobileSidebarOpen && (
        <button
          type="button"
          className="side-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      <main
        className="companions-main"
        aria-hidden={mobileSidebarOpen || undefined}
        inert={mobileSidebarOpen ? true : undefined}
      >
        <header className="companions-head">
          <div>
            <p>Workspace</p>
            <h1>Companions</h1>
            <span>Companions available to this workspace will appear here.</span>
          </div>
        </header>
        <section className="companions-empty" aria-labelledby="companions-empty-title">
          <Icon name="bot" size={24} />
          <h2 id="companions-empty-title">No companions yet</h2>
          <p>Creation, chat, plugins, and sharing are not available in this scaffold.</p>
        </section>
      </main>

      {orgActions.onboarding && (
        <Onboarding
          mode={orgActions.onboarding}
          onMode={orgActions.setOnboarding}
          onCreate={orgActions.createOrg}
          onJoin={orgActions.joinOrg}
          busy={orgActions.busy}
        />
      )}
      {orgActions.error && (
        <div className="og-toast" role="alert" onClick={() => orgActions.setError(null)}>
          {orgActions.error}
        </div>
      )}
    </div>
  );
}
