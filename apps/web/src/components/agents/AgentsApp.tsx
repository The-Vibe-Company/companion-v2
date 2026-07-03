"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AgentDetail,
  AgentModelsResponse,
  AgentsListResponse,
  LabelsResponse,
  ProvisionProgress,
  ProvisionStep,
} from "@companion/contracts";
import {
  destroyAgent as destroyAgentRpc,
  fetchAgent,
  fetchProvision,
  pauseAgent,
  pushAgentSkill,
  retryProvision,
  wakeAgent,
} from "@/lib/agentQueries";
import { formatDurationSeconds } from "@/lib/format";
import {
  mapAgent,
  mapAgentDetail,
  type AgentVM,
  type MeVM,
  type OrgVM,
  type ProvisionStepVM,
  type SkillVM,
} from "@/lib/types";
import { Icon } from "../Icon";
import { Onboarding } from "../org/Onboarding";
import { settingsHref } from "../org/SettingsApp";
import { useOrgActions } from "../org/useOrgActions";
import { Sidebar, type SidebarAgentsNav } from "../skills/Sidebar";
import { deriveTreeRows } from "../skills/SkillsApp";
import { skillsRouteHref, type SkillsLibrary } from "../skills/route";
import { AgentsListView } from "./AgentsListView";
import { CreateView } from "./CreateView";
import { DetailView } from "./DetailView";
import { ProvisioningCard } from "./ProvisioningCard";
import { deriveAgentNav } from "./derive";
import {
  agentChatHref,
  agentsRouteHref,
  agentsRouteKey,
  parseAgentsRoute,
  type AgentsLibrary,
  type AgentsRoute,
} from "./route";

/** Map a polled ProvisionStep to the card VM (mirrors the mapping used by mapAgentDetail). */
function stepVM(step: ProvisionStep): ProvisionStepVM {
  return {
    key: step.key,
    label: step.label,
    detail: step.detail,
    state: step.state,
    time: step.state === "done" || step.state === "failed" ? formatDurationSeconds(step.duration_ms) : "",
  };
}

/**
 * The Companion Agents console orchestrator: URL-driven route state (pushState/popstate — never
 * router.refresh() after mutations), the per-library agent lists with synchronous refs for
 * optimistic mutations, and the provisioning / skill-push polling loops.
 */
export function AgentsApp({
  initialRoute,
  initialMineAgents,
  initialOrgAgents,
  initialModels,
  registrySkills,
  mineSkills,
  orgSkills,
  initialPersonalLabels,
  initialLabels,
  me: _me,
  orgs,
  currentOrg,
  appOrigin,
}: {
  initialRoute: AgentsRoute;
  initialMineAgents: AgentsListResponse;
  initialOrgAgents: AgentsListResponse;
  initialModels: AgentModelsResponse;
  /** Pickable registry skills: org skills + the caller's authored personal skills. */
  registrySkills: SkillVM[];
  /** The two skill libraries, for the sidebar counts + folder trees (read-only here). */
  mineSkills: SkillVM[];
  orgSkills: SkillVM[];
  initialPersonalLabels: LabelsResponse;
  initialLabels: LabelsResponse;
  me: MeVM;
  orgs: OrgVM[];
  currentOrg: OrgVM;
  /** Server-computed web origin for chat URLs (avoids window reads during render). */
  appOrigin: string;
}) {
  const router = useRouter();
  const orgActions = useOrgActions();

  const [route, setRoute] = useState<AgentsRoute>(initialRoute);
  const [mineAgents, setMineAgents] = useState<AgentVM[]>(() => initialMineAgents.agents.map(mapAgent));
  const [orgAgents, setOrgAgents] = useState<AgentVM[]>(() => initialOrgAgents.agents.map(mapAgent));
  const [provisionMap, setProvisionMap] = useState<Record<string, ProvisionProgress>>({});
  // Keeps the provisioning card mounted (same URL) after a provision run fails, until the user
  // retries to completion or leaves — the errblock + "Retry with a fresh fork" live on the card.
  const [cardSticky, setCardSticky] = useState<string | null>(null);
  const [detailMissing, setDetailMissing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Synchronous mirrors for optimistic handlers (StrictMode-safe: read current state via the ref,
  // never gate an RPC on a flag set inside a setState updater).
  const mineAgentsRef = useRef<AgentVM[]>(mineAgents);
  const orgAgentsRef = useRef<AgentVM[]>(orgAgents);
  mineAgentsRef.current = mineAgents;
  orgAgentsRef.current = orgAgents;
  // In-flight per-skill pushes, keyed `${slug}/${skillSlug}` → the active poll interval (or null
  // while the POST itself is in flight). Presence in the map IS the synchronous gate.
  const pushOpsRef = useRef<Map<string, ReturnType<typeof setInterval> | null>>(new Map());
  const pauseBusyRef = useRef<Set<string>>(new Set());

  const initialRouteKey = agentsRouteKey(initialRoute);

  useEffect(() => setMineAgents(initialMineAgents.agents.map(mapAgent)), [initialMineAgents]);
  useEffect(() => setOrgAgents(initialOrgAgents.agents.map(mapAgent)), [initialOrgAgents]);
  useEffect(() => {
    setRoute(initialRoute);
    setCardSticky(null);
    setDetailMissing(null);
  }, [currentOrg.id, initialRoute, initialRouteKey]);
  useEffect(() => {
    document.cookie = `companion_org=${encodeURIComponent(currentOrg.id)}; path=/; SameSite=Lax`;
  }, [currentOrg.id]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const sync = () => {
      if (!query.matches) setMobileSidebarOpen(false);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // --- URL <-> route state (pushState + popstate, mirroring SkillsApp) --------
  const writeUrl = useCallback((next: AgentsRoute, history: "push" | "replace") => {
    if (typeof window === "undefined" || window.location.pathname !== "/agents") return;
    const href = agentsRouteHref(next);
    if (`${window.location.pathname}${window.location.search}` === href) return;
    if (history === "push") window.history.pushState(window.history.state, "", href);
    else window.history.replaceState(window.history.state, "", href);
  }, []);

  const applyRoute = useCallback(
    (next: AgentsRoute, history: "push" | "replace" | "none") => {
      setRoute(next);
      setCardSticky(null);
      setDetailMissing(null);
      if (history !== "none") writeUrl(next, history);
    },
    [writeUrl],
  );

  useEffect(() => {
    const onPopState = () => {
      if (window.location.pathname !== "/agents") return;
      applyRoute(parseAgentsRoute(window.location.search), "none");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applyRoute]);

  // --- Agent state helpers -----------------------------------------------------
  const findAgent = useCallback(
    (slug: string): AgentVM | null =>
      mineAgentsRef.current.find((a) => a.id === slug) ?? orgAgentsRef.current.find((a) => a.id === slug) ?? null,
    [],
  );

  const patchAgent = useCallback((slug: string, fn: (agent: AgentVM) => AgentVM) => {
    setMineAgents((arr) => arr.map((a) => (a.id === slug ? fn(a) : a)));
    setOrgAgents((arr) => arr.map((a) => (a.id === slug ? fn(a) : a)));
  }, []);

  /** Upsert a fetched AgentDetail into its library list (detail fields ride on the list VM). */
  const applyDetail = useCallback((row: AgentDetail) => {
    const vm = mapAgentDetail(row);
    const setter = vm.scope === "org" ? setOrgAgents : setMineAgents;
    setter((arr) => (arr.some((a) => a.id === vm.id) ? arr.map((a) => (a.id === vm.id ? vm : a)) : [...arr, vm]));
  }, []);

  // --- Detail route: enrich the open agent + drive the provisioning card --------
  const detailSlug = route.kind === "detail" ? route.agent : null;
  const detailAgent = useMemo(() => {
    if (!detailSlug) return null;
    const primary = route.lib === "org" ? orgAgents : mineAgents;
    const secondary = route.lib === "org" ? mineAgents : orgAgents;
    return primary.find((a) => a.id === detailSlug) ?? secondary.find((a) => a.id === detailSlug) ?? null;
  }, [detailSlug, route.lib, mineAgents, orgAgents]);

  useEffect(() => {
    if (!detailSlug) return;
    let cancelled = false;
    fetchAgent(detailSlug)
      .then((row) => {
        if (!cancelled) applyDetail(row);
      })
      .catch(() => {
        if (!cancelled && !findAgent(detailSlug)) setDetailMissing(detailSlug);
      });
    return () => {
      cancelled = true;
    };
  }, [detailSlug, currentOrg.id, applyDetail, findAgent]);

  // Poll the slim provision progress (~750ms) while the open agent provisions; in-flight guard +
  // cleanup on unmount/dep change. On ready: refetch the detail and swap to DetailView in place.
  const detailStatus = detailAgent?.status ?? null;
  useEffect(() => {
    if (!detailSlug || detailStatus !== "provisioning") return;
    let stopped = false;
    let inFlight = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      stopped = true;
      if (intervalId) clearInterval(intervalId);
    };
    const tick = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const progress = await fetchProvision(detailSlug);
        if (stopped) return;
        setProvisionMap((m) => ({ ...m, [detailSlug]: progress }));
        if (progress.lifecycle === "ready") {
          stop();
          const row = await fetchAgent(detailSlug);
          setCardSticky(null);
          applyDetail(row);
        } else if (progress.lifecycle === "error") {
          stop();
          setCardSticky(detailSlug);
          const row = await fetchAgent(detailSlug).catch(() => null);
          if (row) applyDetail(row);
        }
      } catch {
        // Transient poll failure — keep the interval running.
      } finally {
        inFlight = false;
      }
    };
    void tick();
    intervalId = setInterval(() => {
      void tick();
    }, 750);
    return stop;
  }, [detailSlug, detailStatus, applyDetail]);

  // --- Mutations -----------------------------------------------------------------
  const retryAgentProvision = useCallback(
    (slug: string) => {
      setCardSticky(slug);
      patchAgent(slug, (a) => ({ ...a, status: "provisioning" }));
      retryProvision(slug)
        .then((progress) => setProvisionMap((m) => ({ ...m, [slug]: progress })))
        .catch((e) => {
          setNotice(e instanceof Error ? e.message : "Could not retry provisioning.");
          fetchAgent(slug).then(applyDetail).catch(() => {});
        });
    },
    [applyDetail, patchAgent],
  );

  /** Optimistic single-field status flip (running ↔ sleeping) with revert on error. */
  const pauseWake = useCallback(
    (slug: string) => {
      if (pauseBusyRef.current.has(slug)) return;
      const agent = findAgent(slug);
      if (!agent || (agent.status !== "running" && agent.status !== "sleeping")) return;
      const prev = agent.status;
      const next = prev === "running" ? ("sleeping" as const) : ("running" as const);
      pauseBusyRef.current.add(slug);
      patchAgent(slug, (a) => ({ ...a, status: next }));
      const revert = (e: unknown) => {
        patchAgent(slug, (a) => ({ ...a, status: prev }));
        setNotice(e instanceof Error ? e.message : "Could not update the agent.");
      };
      const done = () => {
        pauseBusyRef.current.delete(slug);
      };
      if (prev === "running") {
        pauseAgent(slug).catch(revert).finally(done);
      } else {
        wakeAgent(slug)
          .then((result) => patchAgent(slug, (a) => ({ ...a, status: result.status, lastResumeMs: result.resume_ms })))
          .catch(revert)
          .finally(done);
      }
    },
    [findAgent, patchAgent],
  );

  /** Non-optimistic destroy: await the RPC, drop the row, then land on the list. */
  const destroyOpenAgent = useCallback(
    async (slug: string) => {
      const agent = findAgent(slug);
      const lib: AgentsLibrary = agent?.scope === "org" ? "org" : "mine";
      try {
        await destroyAgentRpc(slug, slug);
        setMineAgents((arr) => arr.filter((a) => a.id !== slug));
        setOrgAgents((arr) => arr.filter((a) => a.id !== slug));
        applyRoute({ lib, kind: "list" }, "push");
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "Could not destroy the agent.");
      }
    },
    [applyRoute, findAgent],
  );

  /**
   * Push one skill's latest version to one agent, then poll the agent (~750ms) until the
   * pending_op reports updated | failed. Gated on the synchronous pushOpsRef key.
   */
  const pushSkill = useCallback(
    (slug: string, skillSlug: string) => {
      const key = `${slug}/${skillSlug}`;
      if (pushOpsRef.current.has(key)) return;
      pushOpsRef.current.set(key, null);
      const pin = findAgent(slug)?.skills.find((s) => s.id === skillSlug);
      patchAgent(slug, (a) => ({
        ...a,
        pendingOp: {
          kind: "skill-push",
          skill_slug: skillSlug,
          from_version: pin?.version ?? null,
          to_version: pin?.latest ?? "",
          phase: "pushing",
          error: null,
          started_at: new Date().toISOString(),
        },
      }));
      const finish = () => {
        const intervalId = pushOpsRef.current.get(key);
        if (intervalId) clearInterval(intervalId);
        pushOpsRef.current.delete(key);
      };
      pushAgentSkill(slug, skillSlug)
        .then((res) => {
          patchAgent(slug, (a) => ({ ...a, pendingOp: res.pending_op }));
          let inFlight = false;
          const intervalId = setInterval(() => {
            if (inFlight) return;
            inFlight = true;
            fetchAgent(slug)
              .then((row) => {
                applyDetail(row);
                const op = row.pending_op;
                if (!op || op.skill_slug !== skillSlug || op.phase === "updated" || op.phase === "failed") {
                  finish();
                  if (op?.phase === "failed" && op.error) setNotice(op.error);
                }
              })
              .catch(() => finish())
              .finally(() => {
                inFlight = false;
              });
          }, 750);
          pushOpsRef.current.set(key, intervalId);
        })
        .catch((e) => {
          finish();
          patchAgent(slug, (a) => ({ ...a, pendingOp: null }));
          setNotice(e instanceof Error ? e.message : "Could not push the skill.");
        });
    },
    [applyDetail, findAgent, patchAgent],
  );

  // Clear any in-flight push polls on unmount.
  useEffect(
    () => () => {
      for (const intervalId of pushOpsRef.current.values()) {
        if (intervalId) clearInterval(intervalId);
      }
      pushOpsRef.current.clear();
    },
    [],
  );

  // Auto-dismiss notices.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // --- Sidebar data ---------------------------------------------------------------
  const personalTreeRows = useMemo(
    () => deriveTreeRows(mineSkills.filter((s) => s.source === "authored"), initialPersonalLabels.flat),
    [mineSkills, initialPersonalLabels],
  );
  const orgTreeRows = useMemo(() => deriveTreeRows(orgSkills, initialLabels.flat), [orgSkills, initialLabels]);
  const starredCount = useMemo(() => mineSkills.filter((s) => s.starred).length, [mineSkills]);
  const installedCount = useMemo(() => mineSkills.filter((s) => s.source === "installed").length, [mineSkills]);
  const installedUpdateCount = useMemo(
    () => mineSkills.filter((s) => s.source === "installed" && s.installStatus === "update").length,
    [mineSkills],
  );

  const agentsNav = useMemo<SidebarAgentsNav>(
    () => ({
      ...deriveAgentNav(mineAgents, orgAgents),
      active: route.kind === "list" ? { lib: route.lib, label: route.label ?? null } : null,
      onSelectAgents: (lib: SkillsLibrary) => applyRoute({ lib, kind: "list" }, "push"),
      onSelectAgentLabel: (lib: SkillsLibrary, label: string) => applyRoute({ lib, kind: "list", label }, "push"),
    }),
    [mineAgents, orgAgents, route, applyRoute],
  );

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const goToSkills = useCallback(
    (target: Parameters<typeof skillsRouteHref>[0]) => router.push(skillsRouteHref(target)),
    [router],
  );

  // --- View switch -----------------------------------------------------------------
  const lib = route.lib;
  const libAgents = lib === "org" ? orgAgents : mineAgents;
  const updates = lib === "org" ? initialOrgAgents.updates : initialMineAgents.updates;
  const backToList = () => applyRoute({ lib, kind: "list" }, "push");

  let main: React.ReactNode;
  if (route.kind === "create") {
    main = (
      <CreateView
        lib={lib}
        models={initialModels.models}
        registry={registrySkills}
        appOrigin={appOrigin}
        onBack={backToList}
        onCreated={(detail) => {
          applyDetail(detail);
          applyRoute({ lib, kind: "detail", agent: detail.slug }, "push");
        }}
      />
    );
  } else if (route.kind === "detail") {
    if (!detailAgent) {
      main =
        detailMissing === route.agent ? (
          <div className="empty" style={{ flex: 1 }}>
            <Icon name="bot" size={22} style={{ color: "var(--color-faint)" }} />
            <div className="empty__title">Agent not found</div>
            <div className="empty__desc">It may have been destroyed. Go back to the fleet list.</div>
            <button type="button" className="btn-primary" onClick={backToList}>
              Back to Agents
            </button>
          </div>
        ) : null;
    } else {
      const progress = provisionMap[detailAgent.id];
      const showCard = detailAgent.status === "provisioning" || cardSticky === detailAgent.id;
      if (showCard) {
        const steps = progress ? progress.steps.map(stepVM) : detailAgent.provision?.steps ?? [];
        const error = progress?.error ?? detailAgent.provision?.error ?? null;
        main = (
          <ProvisioningCard
            name={detailAgent.id}
            steps={steps}
            error={error}
            ok={progress?.lifecycle === "ready"}
            skillsCount={detailAgent.skills.length}
            onRetry={() => retryAgentProvision(detailAgent.id)}
            onBackToForm={() => applyRoute({ lib, kind: "create" }, "push")}
          />
        );
      } else {
        main = (
          <DetailView
            agent={detailAgent}
            chatUrl={`${appOrigin}/agents/${detailAgent.id}/chat`}
            onBack={backToList}
            onOpenChat={() => router.push(agentChatHref(detailAgent.id))}
            onPauseWake={() => pauseWake(detailAgent.id)}
            onRetry={() => retryAgentProvision(detailAgent.id)}
            onPushSkill={(skillSlug) => pushSkill(detailAgent.id, skillSlug)}
            onDestroy={() => {
              void destroyOpenAgent(detailAgent.id);
            }}
          />
        );
      }
    }
  } else {
    // `list` — and, for this increment, the `update` route also lands on the list (fan-out ships
    // next; the route parse stays intact so /agents?view=update&skill=… keeps resolving).
    main = (
      <AgentsListView
        lib={lib}
        label={route.kind === "list" ? route.label ?? null : null}
        agents={libAgents}
        updates={updates}
        onOpenAgent={(slug) => applyRoute({ lib, kind: "detail", agent: slug }, "push")}
        onOpenCreate={() => applyRoute({ lib, kind: "create" }, "push")}
        onOpenUpdate={(skill) => applyRoute({ lib, kind: "update", skill }, "push")}
      />
    );
  }

  return (
    <div className={"app app--skills" + (mobileSidebarOpen ? " app--side-open" : "")}>
      <Sidebar
        orgs={orgs}
        currentOrg={currentOrg}
        onSwitchOrg={orgActions.switchOrg}
        onOnboard={(mode) => orgActions.setOnboarding(mode)}
        onOpenSettings={() => router.push(settingsHref({ view: "profile" }, null))}
        onWarmSettings={() => {}}
        mineTreeRows={personalTreeRows}
        orgTreeRows={orgTreeRows}
        expanded={expanded}
        onToggleExpand={toggleExpand}
        selection={null}
        mineCount={mineSkills.length}
        orgCount={orgSkills.length}
        starredCount={starredCount}
        installedCount={installedCount}
        installedUpdateCount={installedUpdateCount}
        onOpenPalette={() => goToSkills({ lib: "mine", kind: "all" })}
        onSelectMineAll={() => goToSkills({ lib: "mine", kind: "all" })}
        onSelectOrgAll={() => goToSkills({ lib: "org", kind: "all" })}
        onSelectStarred={() => goToSkills({ lib: "mine", kind: "starred" })}
        onSelectInstalled={() => goToSkills({ lib: "mine", kind: "installed" })}
        onSelectLabel={(treeLib, path) => goToSkills({ lib: treeLib, kind: "label", label: path })}
        onCreateLabel={() => {}}
        onSetLabelColor={() => {}}
        onSetLabelIcon={() => {}}
        onRenameLabel={() => {}}
        onDeleteLabel={() => {}}
        drag={null}
        hovered={null}
        openPendingPath={null}
        dropDone={null}
        onReparentLabel={() => {}}
        onLabelStartDrag={() => {}}
        onSelectLocal={() => goToSkills({ kind: "local" })}
        onSelectArchived={() => goToSkills({ kind: "archived" })}
        localActive={false}
        localUpdateCount={0}
        archivedActive={false}
        archivedCount={0}
        mobileOpen={mobileSidebarOpen}
        onToggleMobile={() => setMobileSidebarOpen((open) => !open)}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        surface="agents"
        agentsNav={agentsNav}
        skillsReadOnly
      />
      {mobileSidebarOpen && (
        <button
          type="button"
          className="side-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      <div className="main" aria-hidden={mobileSidebarOpen || undefined} inert={mobileSidebarOpen ? true : undefined}>
        {main}
      </div>
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
      {notice && (
        <div className="og-toast" role="alert" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
    </div>
  );
}
