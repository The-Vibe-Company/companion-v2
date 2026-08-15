"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  Companion,
  CompanionDesktop,
  CompanionPluginAccount,
  CompanionProvidersResponse,
  CompanionThread as Thread,
} from "@companion/contracts";
import type { OrgVM } from "@/lib/types";
import {
  duplicateCompanion,
  getCompanionRuntime,
  getCompanionThread,
  listCompanions,
  openCompanionDesktop,
  sendCompanionMessage,
  setCompanionProvider,
  startCompanionRuntime,
  syncCompanionThread,
  updateCompanionMemberState,
} from "@/lib/companions";
import { Icon } from "../Icon";
import { RelativeTime } from "./RelativeTime";
import { CompanionProvidersDialog } from "./CompanionProvidersDialog";
import { CompanionPlugins } from "./CompanionPlugins";
import { CompanionSettings } from "./CompanionSettings";
import type { CompanionContextSkill } from "./CompanionContext";
import { CompanionThread } from "./CompanionThread";
import { NewCompanionDialog } from "./NewCompanionDialog";
import { ShareCompanionDialog } from "./ShareCompanionDialog";
import { companionStatus } from "./status";
import { createThreadQueue } from "./threadQueue";
import { Onboarding } from "../org/Onboarding";
import { useOrgActions } from "../org/useOrgActions";
import { Sidebar } from "../skills/Sidebar";
import { skillsRouteHref, type SkillsLibrary } from "../skills/route";
import type { TreeRow } from "../skills/sidebarTree";

/** Awake threads pull Pi events; asleep and Viewer threads only re-read the control plane. */
const LIVE_POLL_MS = 2_000;
const READ_MODEL_POLL_MS = 8_000;
/**
 * How often a runner's status chip re-observes the Box it already runs. This read never resumes a
 * Box, and a Viewer never makes it, so the chip stays honest about a Box that stopped underneath it
 * without anyone's Companion being woken to find out.
 */
const BOX_STATUS_POLL_MS = 15_000;
/**
 * How often a Companion mid-transition re-reads the lifecycle it is waiting on. Nothing else does:
 * the Box-status poll below starts only once the state is already `running`, and the request that
 * began the transition answers once, before the lifecycle finishes when it outlives a proxy. That
 * left the chip reporting Starting against a Box that was already up, beside a reply Pi had already
 * sent. This is the control-plane projection, so it never resumes a Box and is safe for a Viewer.
 */
const PENDING_POLL_MS = 3_000;
/**
 * How often the conversation list re-reads every thread's last line. It is slow on purpose: this is
 * the sidebar, not the open thread, and it is the control-plane read model, so it never contacts or
 * wakes a Box for any Companion — including the ones nobody has opened.
 */
const LIST_POLL_MS = 45_000;

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

/**
 * Keep a preview a response did not carry. Every mutation answers about the settings it just wrote
 * and reports `last_message: null`, so replacing a row wholesale would blank the line the sidebar is
 * showing until the next list poll. The projection only ever arrives from a read, so a null here
 * means "not answered", never "the thread is empty".
 */
function mergeCompanion(previous: Companion, next: Companion): Companion {
  return next.last_message === null && previous.last_message !== null
    ? { ...next, last_message: previous.last_message }
    : next;
}

const CONTEXT_OPEN_KEY = "companions:context-open";

/**
 * Whether the context panel starts open. A wide screen has room for it beside the conversation, so
 * that is the default there; on a narrow one the panel comes over the thread, so it waits to be asked
 * for. An explicit choice, once made, wins over both.
 */
function readContextOpen(): boolean {
  try {
    const stored = window.localStorage.getItem(CONTEXT_OPEN_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
    return window.matchMedia("(min-width: 1024px)").matches;
  } catch {
    return false;
  }
}

function writeContextOpen(open: boolean): void {
  try {
    window.localStorage.setItem(CONTEXT_OPEN_KEY, open ? "true" : "false");
  } catch {
    // A device that cannot remember the preference simply asks again next time.
  }
}

function threadUrl(companionId: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (companionId) {
    url.searchParams.set("companion", companionId);
    url.searchParams.delete("view");
  }
  else url.searchParams.delete("companion");
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

export function CompanionsApp({
  orgs,
  currentOrg,
  viewer,
  navigation,
  skills,
  initialCompanions,
  initialProviders,
  initialPlugins,
  initialCompanionId,
  initialSettingsCompanionId,
  initialPluginsOpen = false,
}: {
  orgs: OrgVM[];
  currentOrg: OrgVM;
  /** The signed-in reader: whose messages are their own, and whose face the footer row carries. */
  viewer: { id: string; name: string; email: string; initials: string; avatarUrl: string | null };
  navigation: CompanionNavigation;
  /** Every skill this reader can see, so the context panel can name the ones a Companion stages. */
  skills: CompanionContextSkill[];
  initialCompanions: Companion[];
  initialProviders: CompanionProvidersResponse;
  initialPlugins: CompanionPluginAccount[];
  initialCompanionId?: string | null;
  initialSettingsCompanionId?: string | null;
  initialPluginsOpen?: boolean;
}) {
  const router = useRouter();
  const orgActions = useOrgActions();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [companions, setCompanions] = useState(initialCompanions);
  const [providers, setProviders] = useState(initialProviders);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [managingProviders, setManagingProviders] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(initialPluginsOpen && !initialCompanionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<Companion | null>(null);
  const [settingsId, setSettingsId] = useState<string | null>(
    () => initialCompanions.some((item) => item.id === initialSettingsCompanionId)
      ? initialSettingsCompanionId ?? null
      : null,
  );
  const [openedId, setOpenedId] = useState<string | null>(
    () => !initialSettingsCompanionId
      && initialCompanions.some((item) => item.id === initialCompanionId)
      ? initialCompanionId ?? null
      : null,
  );
  const [thread, setThread] = useState<Thread | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  /** This reader's watermark when the open thread was opened; the "New" divider sits just past it. */
  const [lastReadOrdinal, setLastReadOrdinal] = useState<number | null>(null);
  /** How far the thread went when it was opened, so the divider marks reading rather than arrivals. */
  const [openedThroughOrdinal, setOpenedThroughOrdinal] = useState<number | null>(null);
  /**
   * Why the last desktop handoff opened nothing. It is kept apart from `threadError` because the
   * live thread poll clears that one every couple of seconds, which would erase this answer before
   * anyone could read it and leave a failed handoff looking like nothing happened at all.
   */
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [waking, setWaking] = useState(false);
  const [openingDesktop, setOpeningDesktop] = useState(false);
  /**
   * Whether a runner keeps the context panel beside the conversation. It is a preference rather than
   * a property of one Companion, so it survives moving between threads and reloads: an operator who
   * wants the screen, the routines, and the skills in view wants them for the next Companion too. It
   * starts closed so server markup and the first client paint agree, and the stored preference — open
   * unless it was closed — arrives once the client owns the page.
   */
  const [contextOpen, setContextOpen] = useState(false);
  /**
   * The one join the open panel is showing, and the Companion it was minted for. Box rotates the
   * stream token on every state change, so a desktop is held for exactly as long as the join that
   * minted it is on screen and is never stored: closing the panel, moving to another Companion, and a
   * Box that stops all drop it.
   *
   * The Companion is part of the state rather than assumed, because the panel preference outlives one
   * thread. Without it, opening another Companion would frame the previous one's screen — and its
   * secret-bearing URL — under the new Companion's name until the next mint answered.
   */
  const [contextJoin, setContextJoin] = useState<{
    companionId: string;
    desktop: CompanionDesktop | null;
    error: string | null;
    joining: boolean;
  } | null>(null);
  const threadRequestRef = useRef(0);
  /** The Companion whose read watermark has already been captured for the open thread. */
  const capturedReadRef = useRef<string | null>(null);
  /** Newest panel join, so a slower mint cannot put its stream on screen after a newer one. */
  const contextJoinRef = useRef(0);
  /** Newest runtime read per Companion, so a slower one cannot answer over it. */
  const companionReadRef = useRef(new Map<string, number>());
  const threadQueueRef = useRef(createThreadQueue());
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const noop = () => {};

  const opened = useMemo(
    () => companions.find((companion) => companion.id === openedId) ?? null,
    [companions, openedId],
  );
  const settingsCompanion = useMemo(
    () => companions.find((companion) => companion.id === settingsId) ?? null,
    [companions, settingsId],
  );
  const canRunOpened = opened !== null && opened.access !== "viewer";
  const openedAwake = opened?.runtime.state === "running";
  // A lifecycle the control plane is still resolving. `error` is not one of these: it is where a
  // failed transition settles, and its reason is already on screen.
  const openedPending = opened?.runtime.state === "provisioning" || opened?.runtime.state === "stopping";

  const providerName = (providerId: string) =>
    providers.catalog.find((provider) => provider.id === providerId)?.name ?? providerId;
  const fallbackProvider = providers.default_provider_id
    ?? providers.connections[0]?.provider_id
    ?? "";

  const sidebarCompanions = useMemo(
    () => companions.map((companion) => {
      const status = companionStatus(companion.runtime.state);
      return {
        id: companion.id,
        name: companion.name,
        status: status.label,
        tone: status.tone,
        preview: companion.last_message?.preview ?? null,
        previewAt: companion.last_message?.created_at ?? null,
        // The reader's own watermark, from the control plane. The thread on screen is being read
        // right now, so it is never the one with a dot on it.
        unread: companion.id !== openedId && companion.unread,
      };
    }),
    [companions, openedId],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en-US");
    const active = companions.filter((companion) => !companion.hidden);
    if (!needle) return active;
    return active.filter((companion) =>
      companion.name.toLocaleLowerCase("en-US").includes(needle)
      || (companion.persona ?? "").toLocaleLowerCase("en-US").includes(needle));
  }, [companions, query]);

  const hiddenCompanions = useMemo(
    () => companions.filter((companion) => companion.hidden),
    [companions],
  );

  /**
   * Put one Companion back where it already was. Reads run on a poll, and the roster's order is the
   * server's — pin age, then recency, then name — so re-sorting here on every answer would fight the
   * list poll and make rows jump under the cursor. The preview is merged because a mutation answers
   * about what it just wrote and would otherwise blank the line the conversation list is showing.
   */
  const replaceCompanion = useCallback((next: Companion) => {
    setCompanions((current) =>
      current.map((item) => item.id === next.id ? mergeCompanion(item, next) : item));
  }, []);

  /**
   * Put one Companion back and let it move. Pin and hide are the writes that change where a row
   * belongs, so this is the only path that re-sorts, and it sorts the way the server does.
   */
  const resortCompanion = useCallback((next: Companion) => {
    setCompanions((current) => {
      const previous = current.find((item) => item.id === next.id);
      const merged = previous ? mergeCompanion(previous, next) : next;
      const without = current.filter((item) => item.id !== next.id);
      return [merged, ...without].sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        return Date.parse(right.updated_at) - Date.parse(left.updated_at);
      });
    });
  }, []);

  const applyMemberState = async (
    companion: Companion,
    patch: { pinned?: boolean; hidden?: boolean; unread?: boolean },
  ) => {
    setBusy(true);
    setError(null);
    try {
      const next = await updateCompanionMemberState(currentOrg.id, companion.id, patch);
      resortCompanion(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this Companion.");
    } finally {
      setBusy(false);
    }
  };

  const onDuplicate = async (companion: Companion) => {
    setBusy(true);
    setError(null);
    try {
      const cloned = await duplicateCompanion(currentOrg.id, companion.id);
      setCompanions((current) => [cloned, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not duplicate this Companion.");
    } finally {
      setBusy(false);
    }
  };

  const openCompanion = (companion: Companion) => {
    threadRequestRef.current += 1;
    setOpenedId(companion.id);
    setThread(null);
    setThreadError(null);
    setDesktopError(null);
    setPluginsOpen(false);
    setSettingsId(null);
    threadUrl(companion.id);
    if (companion.unread) {
      setCompanions((current) => current.map((item) =>
        item.id === companion.id ? { ...item, unread: false } : item));
    }
  };

  const closeThread = () => {
    const wasOpen = openedId;
    threadRequestRef.current += 1;
    setOpenedId(null);
    setThread(null);
    setThreadError(null);
    setDesktopError(null);
    threadUrl(null);
    // Leaving the thread unmounts the back button, so focus returns to the row it came from.
    window.requestAnimationFrame(() => {
      (wasOpen ? rowRefs.current.get(wasOpen) : null)?.focus();
    });
  };

  const openPlugins = () => {
    setPluginsOpen(true);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("companion");
    url.searchParams.set("view", "plugins");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };

  const closePlugins = () => {
    setPluginsOpen(false);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };

  const closeSettings = () => {
    setSettingsId(null);
    router.push("/companions");
  };

  /** One refresh of the open thread: Pi delivery plus projection when awake, read model otherwise. */
  const refreshThread = useCallback(async (live: boolean) => {
    if (!openedId) return;
    // The request id is claimed by the call that actually goes out, not by the tick that asked for
    // one. A tick the queue skips used to claim an id anyway, which invalidated the read already in
    // flight and threw its answer away — including the one payload that carries where this reader
    // left off, so a first read slower than one poll silently lost the divider for good.
    let requestId = threadRequestRef.current;
    try {
      const next = await threadQueueRef.current.run(
        () => {
          requestId = ++threadRequestRef.current;
          return live
            ? syncCompanionThread(currentOrg.id, openedId)
            : getCompanionThread(currentOrg.id, openedId);
        },
        { skipWhenBusy: true },
      );
      if (next && requestId === threadRequestRef.current) {
        setThread(next);
        setThreadError(null);
        // The control plane advances this member's watermark as it answers. Opening from the list
        // already cleared the row optimistically; this covers the thread nobody clicked into — a
        // deep link — which would otherwise keep a dot on a thread that is on screen.
        setCompanions((current) => current.map((item) =>
          item.id === openedId && item.unread ? { ...item, unread: false } : item));
      }
    } catch (cause) {
      if (requestId === threadRequestRef.current) {
        setThreadError(cause instanceof Error ? cause.message : "This thread could not be loaded.");
      }
    }
  }, [currentOrg.id, openedId]);

  // The panel preference is per device, so it can only be read once the client owns the page.
  useEffect(() => setContextOpen(readContextOpen()), []);

  /**
   * Where this reader left off, taken from the first thread payload after opening: the control plane
   * reports the watermark as it stood before that read advanced it, and that read is also what
   * advances it. So it is captured exactly once per Companion — keyed by id rather than by the value
   * being null, because null is a real answer (a first visit) and a second poll would otherwise
   * capture the watermark the first one had just moved, drawing a divider above a reply the reader
   * is watching arrive. The same key is what re-captures when the sidebar moves to another thread.
   */
  useEffect(() => {
    if (!openedId) {
      capturedReadRef.current = null;
      setLastReadOrdinal(null);
      setOpenedThroughOrdinal(null);
      return;
    }
    if (thread?.companion_id !== openedId || capturedReadRef.current === openedId) return;
    capturedReadRef.current = openedId;
    setLastReadOrdinal(thread.last_read_ordinal);
    setOpenedThroughOrdinal(thread.entries.at(-1)?.ordinal ?? null);
  }, [openedId, thread]);

  /**
   * The conversation list re-reads every thread's last line on a slow cadence. It is the
   * control-plane read model — the same list the page was rendered from — so it never contacts a Box
   * and never wakes one, whatever state the Companions in it are in.
   *
   * The open thread does not depend on this: sending re-reads its Companion, and a runner watching an
   * awake Box re-reads it every few seconds, and both of those reads now carry the preview.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      void listCompanions(currentOrg.id)
        .then((latest) => setCompanions((current) => {
          const byId = new Map(current.map((item) => [item.id, item]));
          return latest.map((item) => {
            const previous = byId.get(item.id);
            return previous ? mergeCompanion(previous, item) : item;
          });
        }))
        // A list that could not be re-read keeps the rows it has; nothing on screen is wrong yet.
        .catch(() => {});
    }, LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [currentOrg.id]);

  useEffect(() => {
    if (!openedId) return;
    void refreshThread(false);
  }, [openedId, refreshThread]);

  useEffect(() => {
    if (!openedId) return;
    const live = canRunOpened && openedAwake;
    const timer = setInterval(
      () => void refreshThread(live),
      live ? LIVE_POLL_MS : READ_MODEL_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [canRunOpened, openedAwake, openedId, refreshThread]);

  /**
   * Re-read one Companion; a failed read leaves the current row alone. The control-plane read is the
   * default, so it is safe for a Viewer and after a failed wake. A live read observes an already
   * running Box for a runner and still never resumes one.
   */
  const refreshCompanion = useCallback(async (companionId: string, live = false) => {
    // Reads of one Companion can overlap, and a lifecycle is watched closely enough that they will:
    // an older read that answers late must not put a state the Companion has already left back on
    // screen, which is how a chip that had reached Online would blink back to Starting.
    const readId = (companionReadRef.current.get(companionId) ?? 0) + 1;
    companionReadRef.current.set(companionId, readId);
    try {
      const latest = await getCompanionRuntime(currentOrg.id, companionId, { live });
      if (companionReadRef.current.get(companionId) !== readId) return;
      replaceCompanion(latest);
    } catch {
      // The failure that prompted this read is already on screen; do not replace it with this one.
    }
  }, [currentOrg.id, replaceCompanion]);

  // Only a runner whose Box is already running observes it, so opening a thread never wakes a Box
  // and a Viewer's chip stays on the control-plane projection.
  useEffect(() => {
    if (!openedId || !canRunOpened || !openedAwake) return;
    const timer = setInterval(() => void refreshCompanion(openedId, true), BOX_STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [canRunOpened, openedAwake, openedId, refreshCompanion]);

  // A pending lifecycle is the one window where the projection is expected to change on its own, so
  // it is the one window that has to be watched. The chip, the wake control, and the composer footer
  // all read this row, so they leave Starting together as soon as the wake records that it finished.
  useEffect(() => {
    if (!openedId || !openedPending) return;
    const timer = setInterval(() => void refreshCompanion(openedId), PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [openedId, openedPending, refreshCompanion]);

  /** Resolves false when the message never reached the control plane, so the composer keeps its text. */
  const onSend = async (content: string, clientMessageId: string): Promise<boolean> => {
    if (!openedId) return false;
    const companionId = openedId;
    setSending(true);
    setThreadError(null);
    try {
      // Sending also delivers the backlog, so it waits for an in-flight sync instead of racing it.
      // The composer's message id travels with the request, so one submission is one turn however
      // many times the request itself reaches the control plane.
      const next = await threadQueueRef.current.run(
        () => sendCompanionMessage(currentOrg.id, companionId, content, clientMessageId),
        { skipWhenBusy: false },
      );
      threadRequestRef.current += 1;
      if (next) setThread(next);
      return true;
    } catch (cause) {
      setThreadError(cause instanceof Error ? cause.message : "The message could not be sent.");
      return false;
    } finally {
      setSending(false);
      // A send can wake this Companion, and it can also fail and record why, so the lifecycle it
      // leaves behind is re-read from the projection the status chip already uses. Everything the
      // thread derives from the runtime — the chip, the wake control, the composer footer, and the
      // live cadence that projects Pi's reply — then moves off the pre-send state together instead
      // of waiting for a reload. The read is the control-plane projection, so it never wakes a Box.
      await refreshCompanion(companionId);
    }
  };

  const onWake = async () => {
    if (!opened) return;
    const companionId = opened.id;
    setWaking(true);
    setThreadError(null);
    try {
      const updated = await startCompanionRuntime(currentOrg.id, companionId);
      replaceCompanion(updated);
      await refreshThread(true);
    } catch (cause) {
      setThreadError(cause instanceof Error ? cause.message : "This Companion could not be woken.");
      // A failed start records why on the Companion, so re-read it: the status pill must show Error
      // rather than the state the wake started from, and the reason must survive a reload.
      await refreshCompanion(companionId);
    } finally {
      setWaking(false);
    }
  };

  /**
   * Computer use for a runner: one handoff to the Box desktop Lux drives. The Box must already be
   * running, so this never creates or resumes one, and the returned URL opens in its own tab instead
   * of being stored anywhere.
   *
   * A browser only honours a new tab that the click itself asked for, so the tab is claimed on
   * `about:blank` before the handoff request and pointed at the desktop once the URL arrives;
   * anything else closes the claimed tab and leaves the reason on the thread. The claim never asks
   * for the empty URL: a browser may read that as this page and leave a copy of the app behind
   * instead of a tab to hand off. `noopener` cannot be passed as a window feature without losing the
   * handle the handoff needs, so the tab disowns this one only once it is on its way to the desktop:
   * disowning it first can detach the handle, and the handoff then silently never lands.
   */
  const onDesktop = async () => {
    if (!opened || !canRunOpened || !openedAwake) return;
    const tab = window.open("about:blank", "_blank");
    setOpeningDesktop(true);
    setDesktopError(null);
    try {
      const desktop = await openCompanionDesktop(currentOrg.id, opened.id);
      if (desktop.desktop_url && tab) {
        // A refused handoff throws, and the catch below closes the tab and says why rather than
        // leaving a blank tab open as if the desktop had been reached.
        tab.location.replace(desktop.desktop_url);
        try {
          tab.opener = null;
        } catch {
          // A tab already on its way to the desktop may refuse the write; it cannot reach back
          // through a stale handle either way, and the handoff itself has already happened.
        }
        return;
      }
      tab?.close();
      if (!desktop.desktop_url) {
        setDesktopError(desktop.provisioning
          ? "The Box desktop is still starting. Try again in a moment."
          : "This Box has no desktop to open yet.");
        return;
      }
      setDesktopError("This browser blocked the Box desktop tab. Allow pop-ups here, then try again.");
    } catch (cause) {
      tab?.close();
      setDesktopError(cause instanceof Error ? cause.message : "The Box desktop could not be opened.");
    } finally {
      setOpeningDesktop(false);
    }
  };

  /**
   * One join of the context panel's screen: mint this Companion's desktop and show it in the panel.
   * It is the same authorized handoff the desktop tab uses, so it observes a Box that is already
   * running and can never create or resume one — the panel is not a wake, and a Viewer never sees it.
   *
   * The URL is minted for this join alone. It is held in state only while the panel shows it, so
   * nothing here can hand a later join a stream token Box has already rotated away.
   */
  const joinContext = useCallback(async () => {
    if (!openedId || !canRunOpened || !openedAwake) return;
    const companionId = openedId;
    const joinId = ++contextJoinRef.current;
    setContextJoin({ companionId, desktop: null, error: null, joining: true });
    try {
      const minted = await openCompanionDesktop(currentOrg.id, companionId);
      if (contextJoinRef.current !== joinId) return;
      setContextJoin({
        companionId,
        desktop: minted,
        error: minted.desktop_url
          ? null
          : minted.provisioning
            ? "The Box desktop is still starting. Reconnect in a moment."
            : "This Box has no desktop to show yet.",
        joining: false,
      });
    } catch (cause) {
      if (contextJoinRef.current !== joinId) return;
      // The reason is kept on the panel rather than the thread: the live thread poll clears its own
      // notice every couple of seconds, which would erase this one before it could be read.
      setContextJoin({
        companionId,
        desktop: null,
        error: cause instanceof Error ? cause.message : "The Box desktop could not be reached.",
        joining: false,
      });
    }
  }, [canRunOpened, currentOrg.id, openedAwake, openedId]);

  /** Whether the panel has a running Box of a runner's to show, which is the only thing it streams. */
  const contextLive = contextOpen && canRunOpened && openedAwake;
  /**
   * The join the panel may show right now, which is only ever the open Companion's. A join belonging
   * to the Companion an operator just left is not shown for the paint before its replacement is
   * minted: a panel that is live with nothing of this Companion's yet is a panel that is connecting.
   */
  const openedContext = contextJoin?.companionId === openedId ? contextJoin : null;

  // Every join mints its own URL: opening the panel, moving to another Companion, and a Box that came
  // back up are each a fresh mint, because Box rotates the stream token on every state change and a
  // kept URL is one that has already stopped working.
  useEffect(() => {
    if (!openedId || !contextLive) return;
    void joinContext();
  }, [contextLive, joinContext, openedId]);

  // A closed panel, a Companion left behind, and a Box that stopped under the stream all leave no
  // desktop: the URL goes with the join it belonged to, and an in-flight mint is disowned.
  useEffect(() => {
    if (contextLive) return;
    contextJoinRef.current += 1;
    setContextJoin(null);
  }, [contextLive]);

  const onCreated = (companion: Companion) => {
    setCompanions((current) => [companion, ...current]);
    setCreating(false);
    setError(null);
    openCompanion(companion);
  };

  const onSetProvider = async (companion: Companion) => {
    if (!fallbackProvider) {
      setError("Connect a provider before configuring this Companion.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await setCompanionProvider(currentOrg.id, companion.id, fallbackProvider);
      replaceCompanion(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider could not be set.");
    } finally {
      setBusy(false);
    }
  };

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

  const dialogOpen = sharing !== null || creating || managingProviders;

  useEffect(() => {
    if (!dialogOpen) return;
    const sidebar = document.querySelector<HTMLElement>(".side");
    const sidebarWasInert = sidebar?.inert ?? false;
    if (sidebar) sidebar.inert = true;
    return () => {
      if (sidebar) sidebar.inert = sidebarWasInert;
    };
  }, [dialogOpen]);

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
        companionsEnabled
        mode="companions"
        onSelectMode={(mode) => {
          if (mode === "skills") router.push("/skills");
        }}
        companions={sidebarCompanions}
        onOpenPlugins={openPlugins}
        pluginsActive={pluginsOpen}
        viewer={viewer}
        activeCompanionId={openedId ?? settingsId}
        onSelectCompanion={(companionId) => {
          const companion = companions.find((item) => item.id === companionId);
          if (!companion) return;
          if (settingsCompanion) router.push(`/companions?companion=${companion.id}`);
          else openCompanion(companion);
        }}
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
        className={"companions-main" + (opened ? " companions-main--chat" : "")}
        aria-hidden={mobileSidebarOpen || dialogOpen || undefined}
        inert={mobileSidebarOpen || dialogOpen ? true : undefined}
      >
        {opened ? (
          <>
            {opened.access === "owner" && !opened.runtime.provider_ids.length && fallbackProvider && (
              <div className="companions-thread-notice">
                <span>This Companion has no provider yet.</span>
                <button
                  type="button"
                  className="cds-btn cds-btn--secondary cds-btn--sm"
                  disabled={busy}
                  onClick={() => void onSetProvider(opened)}
                >
                  {busy ? "Setting..." : `Set ${providerName(fallbackProvider)}`}
                </button>
              </div>
            )}
            <CompanionThread
              companion={opened}
              thread={thread}
              orgId={currentOrg.id}
              error={desktopError ?? threadError}
              busy={sending}
              waking={waking}
              openingDesktop={openingDesktop}
              context={{
                open: contextOpen,
                desktop: openedContext?.desktop ?? null,
                joining: openedContext?.joining ?? contextLive,
                error: openedContext?.error ?? null,
                onToggle: () => setContextOpen((open) => {
                  writeContextOpen(!open);
                  return !open;
                }),
                onJoin: () => void joinContext(),
              }}
              contextSkills={skills}
              lastReadOrdinal={lastReadOrdinal}
              openedThroughOrdinal={openedThroughOrdinal}
              onBack={closeThread}
              onSend={onSend}
              onSettings={() => router.push(`/companions/${opened.id}/settings`)}
              onThread={setThread}
              onWake={() => void onWake()}
              onDesktop={() => void onDesktop()}
            />
          </>
        ) : settingsCompanion ? (
          <CompanionSettings
            orgId={currentOrg.id}
            companion={settingsCompanion}
            providers={providers}
            onBack={closeSettings}
            onSaved={(updated) => {
              replaceCompanion(updated);
            }}
            onDeleted={(companionId) => {
              setCompanions((current) => current.filter((item) => item.id !== companionId));
              setSettingsId(null);
              router.push("/companions");
            }}
          />
        ) : pluginsOpen ? (
          <CompanionPlugins
            orgId={currentOrg.id}
            initialAccounts={initialPlugins}
            onBack={closePlugins}
          />
        ) : (
          <>
            <header className="companions-head">
              <h1>
                Companions
                <span className="companions-count tnum">{companions.length}</span>
              </h1>
              <div className="companions-head-actions">
                {providers.can_manage && (
                  <button
                    type="button"
                    className="cds-btn cds-btn--secondary cds-btn--md"
                    onClick={() => setManagingProviders(true)}
                  >
                    Providers
                  </button>
                )}
                <button
                  type="button"
                  className="cds-btn cds-btn--secondary cds-btn--md"
                  onClick={openPlugins}
                >
                  <Icon name="plug-zap" size={15} /> Plugins
                </button>
                <button
                  type="button"
                  className="cds-btn cds-btn--primary cds-btn--md"
                  onClick={() => setCreating(true)}
                >
                  <Icon name="plus" size={15} /> New companion
                </button>
              </div>
            </header>

            <div className="companions-content">
              {error && <div className="companions-error" role="alert">{error}</div>}

              {companions.length === 0 ? (
                <div className="companions-empty">
                  <Icon name="bot" size={22} />
                  <strong>No Companions yet</strong>
                  <p>A Companion is a name, one line of persona, and a model provider. It stays asleep until you open it.</p>
                  <button
                    type="button"
                    className="cds-btn cds-btn--primary cds-btn--md"
                    onClick={() => setCreating(true)}
                  >
                    New companion
                  </button>
                </div>
              ) : (
                <>
                  <label className="companions-search">
                    <Icon name="search" size={15} />
                    <input
                      type="search"
                      value={query}
                      placeholder="Search companions"
                      aria-label="Search companions"
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>

                  <div className="companions-list">
                    <div className="companions-row companions-row--head">
                      <span>Companion</span>
                      <span>Status</span>
                      <span>Updated</span>
                      <span>Access</span>
                    </div>
                    {visible.map((companion) => {
                      const status = companionStatus(companion.runtime.state);
                      return (
                        <div
                          className={`companions-row${companion.pinned ? " companions-row--pinned" : ""}`}
                          key={companion.id}
                        >
                          <button
                            type="button"
                            className="companions-row__main"
                            ref={(node) => {
                              if (node) rowRefs.current.set(companion.id, node);
                              else rowRefs.current.delete(companion.id);
                            }}
                            onClick={() => openCompanion(companion)}
                          >
                            <span className="companions-avatar" aria-hidden="true">
                              {companion.name.trim().slice(0, 1).toLocaleUpperCase("en-US") || "C"}
                              {companion.unread && (
                                <i className="companions-unread" title="Unread" />
                              )}
                            </span>
                            <span className="companions-row__text">
                              <strong>
                                {companion.pinned && (
                                  <Icon name="pin" size={12} aria-hidden="true" />
                                )}
                                {companion.name}
                              </strong>
                              <span>
                                {companion.persona
                                  ?? providerName(companion.runtime.provider_ids[0] ?? "No provider")}
                              </span>
                            </span>
                          </button>
                          <span
                            className={`companions-state companions-state--${status.tone}`}
                            title={companion.runtime.last_error ?? undefined}
                          >
                            <i aria-hidden="true" />
                            {status.label}
                          </span>
                          <RelativeTime className="companions-row__time" iso={companion.updated_at} />
                          <span className="companions-row-actions">
                            <span className="companions-role">{companion.access}</span>
                            <details className="companions-row-menu">
                              <summary
                                className="cds-btn cds-btn--ghost cds-btn--sm"
                                aria-label={`Actions for ${companion.name}`}
                              >
                                <Icon name="more-horizontal" size={15} />
                              </summary>
                              <div className="companions-row-menu__panel" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={busy}
                                  onClick={(event) => {
                                    event.currentTarget.closest("details")?.removeAttribute("open");
                                    void applyMemberState(companion, { pinned: !companion.pinned });
                                  }}
                                >
                                  {companion.pinned ? "Unpin" : "Pin"}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={busy || companion.unread}
                                  onClick={(event) => {
                                    event.currentTarget.closest("details")?.removeAttribute("open");
                                    void applyMemberState(companion, { unread: true });
                                  }}
                                >
                                  Mark as unread
                                </button>
                                {companion.access === "owner" && (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    disabled={busy}
                                    onClick={(event) => {
                                      event.currentTarget.closest("details")?.removeAttribute("open");
                                      void onDuplicate(companion);
                                    }}
                                  >
                                    Duplicate
                                  </button>
                                )}
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={busy}
                                  onClick={(event) => {
                                    event.currentTarget.closest("details")?.removeAttribute("open");
                                    void applyMemberState(companion, { hidden: true });
                                  }}
                                >
                                  Hide
                                </button>
                              </div>
                            </details>
                            <button
                              type="button"
                              className="cds-btn cds-btn--ghost cds-btn--sm"
                              aria-label={`Settings for ${companion.name}`}
                              onClick={() => router.push(`/companions/${companion.id}/settings`)}
                            >
                              Settings
                            </button>
                            {companion.access === "owner" && currentOrg.kind !== "personal" && (
                              <button
                                type="button"
                                className="cds-btn cds-btn--ghost cds-btn--sm"
                                onClick={() => setSharing(companion)}
                              >
                                Share
                              </button>
                            )}
                          </span>
                        </div>
                      );
                    })}
                    {visible.length === 0 && (
                      <p className="companions-list-empty">No Companion matches this search.</p>
                    )}
                  </div>

                  {hiddenCompanions.length > 0 && !query.trim() && (
                    <section className="companions-hidden" aria-labelledby="companions-hidden-title">
                      <h2 id="companions-hidden-title">Hidden</h2>
                      <div className="companions-list">
                        {hiddenCompanions.map((companion) => (
                          <div className="companions-row" key={companion.id}>
                            <div className="companions-row__main companions-row__main--static">
                              <span className="companions-avatar" aria-hidden="true">
                                {companion.name.trim().slice(0, 1).toLocaleUpperCase("en-US") || "C"}
                              </span>
                              <span className="companions-row__text">
                                <strong>{companion.name}</strong>
                                <span>Hidden from your list</span>
                              </span>
                            </div>
                            <span className="companions-row-actions">
                              <button
                                type="button"
                                className="cds-btn cds-btn--ghost cds-btn--sm"
                                disabled={busy}
                                onClick={() => void applyMemberState(companion, { hidden: false })}
                              >
                                Unhide
                              </button>
                              <button
                                type="button"
                                className="cds-btn cds-btn--ghost cds-btn--sm"
                                aria-label={`Settings for ${companion.name}`}
                                onClick={() => router.push(`/companions/${companion.id}/settings`)}
                              >
                                Settings
                              </button>
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </main>

      {creating && (
        <NewCompanionDialog
          orgId={currentOrg.id}
          providers={providers}
          onCreated={onCreated}
          onConnectProvider={() => {
            setCreating(false);
            setManagingProviders(true);
          }}
          onClose={() => setCreating(false)}
        />
      )}

      {managingProviders && (
        <CompanionProvidersDialog
          orgId={currentOrg.id}
          providers={providers}
          onProviders={setProviders}
          onClose={() => setManagingProviders(false)}
        />
      )}

      {sharing && (
        <ShareCompanionDialog
          orgId={currentOrg.id}
          companion={sharing}
          onClose={() => setSharing(null)}
        />
      )}

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
