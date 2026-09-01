"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  Companion,
  CompanionDesktop,
  CompanionOperation,
  CompanionRoutine,
  CompanionThread as Thread,
  CompanionTranscriptEntry,
  CompanionTrigger,
} from "@companion/contracts";
import { ApiFetchError } from "@/lib/apiClient";
import { Icon } from "../Icon";
import { CompanionContext, type CompanionContextSkill } from "./CompanionContext";
import { CompanionTranscript } from "./CompanionTranscript";
import { companionBoxStatusLabel, companionStatus } from "./status";
import { CompanionIcon } from "./CompanionIcon";
import {
  CompanionRoutineHistory,
  type RoutineHistoryTarget,
} from "./CompanionRoutineHistory";
import {
  CompanionTriggerHistory,
  type TriggerHistoryTarget,
} from "./CompanionTriggerHistory";
import type { CompanionTriggerHistoryApi } from "./CompanionTriggerHistoryTypes";
import type { CompanionTriggerAccountOption, CompanionTriggerV2 } from "./CompanionTriggerTypes";
import { replyExpected } from "./transcript";
import { useVisualViewportPin } from "./useVisualViewportPin";

/**
 * What the context panel beside the conversation is showing, and how a runner drives it. The mint
 * itself belongs to the surface that owns the org and the open Companion, so this is the state it
 * hands down: a desktop is only ever the one minted for the join now on screen.
 */
export interface CompanionContextPanel {
  open: boolean;
  desktop: CompanionDesktop | null;
  joining: boolean;
  error: string | null;
  onToggle: () => void;
  onJoin: () => void;
}

function InterruptedTurnNotice({
  turn,
  latestOperation,
  canAct,
  onRetry,
  onCancel,
}: {
  turn: NonNullable<Thread["interrupted_turn"]>;
  latestOperation: Companion["runtime"]["latest_operation"];
  canAct: boolean;
  onRetry: (turnId: string, retryId: string) => Promise<CompanionOperation>;
  onCancel: (turnId: string) => Promise<void>;
}) {
  const titleId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const retryIdRef = useRef<string | null>(null);
  const [action, setAction] = useState<"retry" | "cancel" | null>(null);
  const [acceptedRetry, setAcceptedRetry] = useState<CompanionOperation | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    retryIdRef.current = null;
    setAction(null);
    setAcceptedRetry(null);
    setActionError(null);
  }, [turn.id, turn.latest_attempt?.id]);

  useEffect(() => {
    if (actionError) errorRef.current?.focus();
  }, [actionError]);

  const latestRetryOperation = latestOperation
    && (latestOperation.kind === "start" || latestOperation.kind === "restart_pi")
    && latestOperation.source_turn_id === turn.id
    ? latestOperation
    : null;

  useEffect(() => {
    if (!latestRetryOperation
      || !["failed", "interrupted", "cancelled"].includes(latestRetryOperation.status)) return;
    retryIdRef.current = null;
    if (acceptedRetry?.id === latestRetryOperation.id) setAcceptedRetry(null);
  }, [acceptedRetry?.id, latestRetryOperation, turn.id]);

  const retry = async () => {
    if (!canAct || action) return;
    const retryId = retryIdRef.current ?? crypto.randomUUID();
    retryIdRef.current = retryId;
    setAction("retry");
    setActionError(null);
    try {
      setAcceptedRetry(await onRetry(turn.id, retryId));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "This turn could not be retried.");
    } finally {
      setAction(null);
    }
  };

  const cancel = async () => {
    if (!canAct || action) return;
    setAction("cancel");
    setActionError(null);
    try {
      await onCancel(turn.id);
    } catch (cause) {
      setActionError(cause instanceof ApiFetchError && cause.status === 409
        ? "The retry has already started, so it cannot be cancelled now. Wait for the turn to refresh."
        : cause instanceof Error ? cause.message : "This turn could not be cancelled.");
      setAction(null);
    }
  };

  const durableRetry = latestRetryOperation;
  const retryOperation = acceptedRetry && acceptedRetry.id !== durableRetry?.id
    ? acceptedRetry
    : durableRetry ?? acceptedRetry;
  const retryPending = retryOperation?.status === "pending" || retryOperation?.status === "running";
  const retryFailure = retryOperation
    && (retryOperation.status === "failed" || retryOperation.status === "interrupted")
    ? retryOperation.error?.message ?? (retryOperation.kind === "start"
      ? "The Companion could not start. Retry or cancel this turn."
      : "Pi could not restart. Retry or cancel this turn.")
    : null;

  return (
    <section
      className="chat-interruption"
      aria-labelledby={titleId}
      aria-busy={action !== null || undefined}
    >
      <Icon name="alert-triangle" size={18} />
      <div className="chat-interruption__body">
        <div role="alert" aria-labelledby={titleId}>
          <h2 id={titleId}>Turn interrupted</h2>
          <p>
            {turn.error?.message ?? "The runtime lost a confirmed outcome for this turn."} External
            actions may already have succeeded.
          </p>
        </div>
        {!canAct ? (
          <p className="chat-interruption__status">
            This turn is finished. Later messages continue automatically.
          </p>
        ) : (
          <>
            {retryPending ? (
              <p className="chat-interruption__status" role="status">
                {retryOperation.kind === "start"
                  ? "Retry accepted. The Companion will start before this turn runs again."
                  : "Retry accepted. Pi will restart before this turn runs again."}
              </p>
            ) : null}
            <div className="chat-interruption__actions">
              {!retryPending ? (
                <button
                  type="button"
                  className="cds-btn cds-btn--primary cds-btn--sm"
                  disabled={action !== null}
                  onClick={() => void retry()}
                >
                  {action === "retry" ? "Requesting retry…" : "Retry turn"}
                </button>
              ) : null}
              <button
                type="button"
                className="cds-btn cds-btn--secondary cds-btn--sm"
                disabled={action !== null}
                onClick={() => void cancel()}
              >
                {action === "cancel" ? "Cancelling…" : "Cancel turn"}
              </button>
            </div>
          </>
        )}
        {retryFailure ? (
          <p className="chat-interruption__error" role="alert">{retryFailure}</p>
        ) : null}
        {actionError ? (
          <p ref={errorRef} className="chat-interruption__error" role="alert" tabIndex={-1}>
            {actionError}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One Companion, one thread. The header carries the identity, the Box status chip, settings, and the
 * context toggle; the conversation and the composer below it are
 * the assistant-ui primitives. The transcript is the control-plane read model, so a Viewer sees the
 * conversation without any Box contact and gets no composer. Pi's tools and skills stay out of the
 * transcript by design.
 *
 * A runner can open the context panel beside the conversation: the Box screen as a preview and the
 * skills it may stage. It is a second pane rather than a change to the transcript: the primitives
 * keep the conversation, the composer, and their own mechanics untouched whether the panel is open
 * or not.
 */
export function CompanionThread({
  companion,
  thread,
  orgId,
  error,
  reconnecting = false,
  busy,
  openingDesktop,
  context,
  contextSkills,
  contextRoutines = [],
  memberTimezone,
  onRoutinesChange,
  contextTriggers = [],
  onTriggersChange,
  contextTriggerAccounts = [],
  contextTriggerHistoryApi,
  onManageTriggerProviders,
  contextPlugins = [],
  contextModels = [],
  lastReadOrdinal,
  openedThroughOrdinal,
  onBack,
  onSend,
  onSettings,
  onThread,
  onDesktop,
  onRetryInterrupted,
  onCancelInterrupted,
}: {
  companion: Companion;
  thread: Thread | null;
  orgId: string;
  error: string | null;
  /** Consecutive thread refreshes have failed; the transcript on screen may be behind. */
  reconnecting?: boolean;
  busy: boolean;
  openingDesktop: boolean;
  context: CompanionContextPanel;
  /** Selected skills this surface can name; the panel counts the ones it cannot. */
  contextSkills: CompanionContextSkill[];
  contextRoutines?: CompanionRoutine[];
  memberTimezone?: string | null;
  onRoutinesChange?: (routines: CompanionRoutine[]) => void;
  contextTriggers?: CompanionTrigger[];
  onTriggersChange?: (triggers: CompanionTrigger[]) => void;
  /** Credential-free member accounts available to every Companion for provider registration. */
  contextTriggerAccounts?: readonly CompanionTriggerAccountOption[];
  /** Optional read adapter for the trigger history drawer. */
  contextTriggerHistoryApi?: CompanionTriggerHistoryApi;
  onManageTriggerProviders?: () => void;
  /** Connected plugins this reader can already name on a config card. */
  contextPlugins?: Array<{ id: string; label: string }>;
  /** Provider catalog models this surface already loaded. */
  contextModels?: Array<{ id: string; label: string }>;
  /** This reader's unread watermark when the thread was opened; the "New" divider sits past it. */
  lastReadOrdinal?: number | null;
  /** The last ordinal the thread held when it was opened, so the divider stays where reading did. */
  openedThroughOrdinal?: number | null;
  onBack: () => void;
  onSend: (content: string, clientMessageId: string, files: readonly File[]) => Promise<boolean>;
  /** Null for a Viewer: read-only settings remain available from the workspace list, not the thread. */
  onSettings: (() => void) | null;
  onThread: (thread: Thread) => void;
  onDesktop: () => void;
  onRetryInterrupted: (turnId: string, retryId: string) => Promise<CompanionOperation>;
  onCancelInterrupted: (turnId: string) => Promise<void>;
}) {
  const chatRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const routineHistoryOpenerRef = useRef<HTMLElement | null>(null);
  const triggerHistoryOpenerRef = useRef<HTMLElement | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [routineHistory, setRoutineHistory] = useState<RoutineHistoryTarget | null>(null);
  const [triggerHistory, setTriggerHistory] = useState<TriggerHistoryTarget | null>(null);
  const status = companionStatus(companion.runtime.state);
  // "Companion is replying…" is only ever the durable ACKed projection, so the icon animates on
  // exactly the same signal instead of guessing from lifecycle state.
  const thinking = replyExpected(thread);
  const canSend = thread ? thread.can_send : companion.access !== "viewer";
  const awake = companion.runtime.state === "running";
  const boxLabel = companionBoxStatusLabel(companion.runtime.state);
  // Computer use is the Box desktop Lux drives, reached from the status chip itself so the header
  // keeps one control. A Viewer reads the same chip without the action: a sleeping Box has no
  // desktop, and a Viewer must never be handed anything that could start one.
  const canOpenDesktop = canSend && awake;
  // The context panel is a runner surface, and a Viewer never gets it: the screen preview cannot
  // start a Box, but it must not offer a Viewer a control that looks as if it could.
  const showContext = canSend && context.open;
  // A red status without a reason tells an operator nothing. The failure this request saw wins;
  // otherwise the reason recorded on the Companion explains an Error state across reloads.
  const notice = error ?? companion.runtime.last_error;
  const interruptedTurn = thread?.interrupted_turn ?? null;
  const previousInterruptedIdRef = useRef<string | null>(null);

  const closeRoutineHistory = useCallback(() => {
    setRoutineHistory(null);
  }, []);
  const openRoutineHistory = useCallback((routine: CompanionRoutine) => {
    routineHistoryOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setRoutineHistory({ routineId: routine.id, runId: null, name: routine.name });
  }, []);
  const openRoutineRun = useCallback((routine: NonNullable<CompanionTranscriptEntry["routine"]>) => {
    if (!routine.run_id) return;
    routineHistoryOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setRoutineHistory({ routineId: routine.id, runId: routine.run_id, name: routine.name });
  }, []);
  const openTriggerHistory = useCallback((trigger: CompanionTriggerV2) => {
    if (!contextTriggerHistoryApi) return;
    triggerHistoryOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setTriggerHistory({ triggerId: trigger.id, runId: null, name: trigger.name });
  }, [contextTriggerHistoryApi]);

  // Opening a thread unmounts the list control that was focused, so focus moves to this thread.
  useEffect(() => {
    headingRef.current?.focus();
    setRoutineHistory(null);
    setTriggerHistory(null);
  }, [companion.id]);

  useEffect(() => {
    if (!routineHistory && !triggerHistory) return;
    const chat = chatRef.current;
    if (!chat) return;
    const blocked = Array.from(chat.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement
      && !child.classList.contains("routine-history-layer")
      && !child.classList.contains("trigger-history-layer"),
    );
    const previous = blocked.map((element) => element.inert);
    blocked.forEach((element) => {
      element.inert = true;
    });
    return () => {
      blocked.forEach((element, index) => {
        element.inert = previous[index] ?? false;
      });
    };
  }, [routineHistory, triggerHistory]);

  // Restore focus only after the modal has unmounted and the rest of the thread is interactive
  // again. Doing this in the close handler can race React's inert cleanup in browsers and tests.
  useEffect(() => {
    if (routineHistory || triggerHistory) return;
    const opener = triggerHistoryOpenerRef.current ?? routineHistoryOpenerRef.current;
    triggerHistoryOpenerRef.current = null;
    routineHistoryOpenerRef.current = null;
    if (!opener) return;
    const frame = window.requestAnimationFrame(() => {
      if (opener.isConnected) opener.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [routineHistory, triggerHistory]);

  // Once the optional Retry or Cancel closes this terminal notice, return keyboard users to the
  // composer. Later work was never blocked by the notice.
  useEffect(() => {
    const previous = previousInterruptedIdRef.current;
    previousInterruptedIdRef.current = interruptedTurn?.id ?? null;
    if (!previous || interruptedTurn) return;
    window.requestAnimationFrame(() => {
      stageRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    });
  }, [interruptedTurn]);

  /**
   * Whether the panel comes over the conversation rather than sitting beside it. An overlay is
   * something to dismiss — Esc and the scrim close it — and a docked panel is not, so the surface has
   * to know which one is on screen rather than offering a dismissal for a panel nobody is stuck under.
   */
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 1023px)");
    const sync = () => setOverlay(narrow.matches);
    sync();
    narrow.addEventListener("change", sync);
    return () => narrow.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!showContext || !overlay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      context.onToggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [context, overlay, showContext]);

  /**
   * An overlay covers the conversation, so the conversation stops being reachable: without this a
   * keyboard walks straight through the scrim into a composer nobody can see. Focus moves into the
   * panel on the way in and back to the toggle that opened it on the way out, the way every other
   * transient surface here behaves.
   */
  useEffect(() => {
    if (!showContext || !overlay) return;
    const conversation = stageRef.current?.querySelector<HTMLElement>(".chat-thread");
    const wasInert = conversation?.inert ?? false;
    if (conversation) conversation.inert = true;
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- invariant checked by the surrounding validation
    const returnTo = document.activeElement as HTMLElement | null;
    window.requestAnimationFrame(() => {
      stageRef.current?.querySelector<HTMLElement>(".chat-context__close")?.focus();
    });
    return () => {
      if (conversation) conversation.inert = wasInert;
      returnTo?.focus();
    };
  }, [overlay, showContext]);

  // A thread is the only Companions surface a phone keyboard opens over, so it is the only one that
  // has to follow the visual viewport.
  useVisualViewportPin();

  return (
    <section ref={chatRef} className="chat" aria-label={`Chat with ${companion.name}`}>
      <header className="chat-head">
        <button type="button" className="iconbtn chat-back" aria-label="Back to Companions" onClick={onBack}>
          <Icon name="arrow-left" size={16} />
        </button>
        <span className="companions-avatar chat-avatar" aria-hidden="true">
          <CompanionIcon icon={companion.icon} size={24} state={thinking ? "thinking" : "idle"} />
        </span>
        <div className="chat-identity">
          <h1 ref={headingRef} tabIndex={-1}>{companion.name}</h1>
          {companion.persona && <p>{companion.persona}</p>}
        </div>
        {/*
          A word, not an alert: the transcript on screen is not wrong, it may just be behind. It sits
          beside the chip so the reader who wonders why nothing moves finds the answer where they
          look for liveness, and it disappears on the first poll that answers. The live region stays
          mounted and only its text toggles — a region mounted together with its content is not
          reliably announced.
        */}
        <span className="chat-reconnecting" role="status">
          {reconnecting ? "Reconnecting…" : ""}
        </span>
        {/*
          The chip is a dot and the state word, and the word is never left to the dot's colour. What
          the state is about — the Box — rides in the accessible name and the tooltip rather than in
          the visible text, because the header has to hold a name, a lifecycle control, and two
          toggles beside it at 320px.
        */}
        {canOpenDesktop ? (
          <button
            type="button"
            className={`companions-state companions-state--${status.tone} chat-box`}
            aria-label={`${boxLabel} — open the Box desktop`}
            title={boxLabel}
            disabled={openingDesktop}
            onClick={onDesktop}
          >
            <i aria-hidden="true" />
            <span className="chat-box__state">
              {openingDesktop ? "Opening desktop" : status.label}
            </span>
          </button>
        ) : (
          <span
            role="img"
            className={`companions-state companions-state--${status.tone} chat-box`}
            aria-label={boxLabel}
            title={boxLabel}
          >
            <i aria-hidden="true" />
            <span className="chat-box__state">{status.label}</span>
          </span>
        )}
        {onSettings && (
          <button
            type="button"
            className="iconbtn chat-settings"
            aria-label={`Settings for ${companion.name}`}
            title="Settings"
            onClick={onSettings}
          >
            <Icon name="settings" size={16} />
          </button>
        )}
        {canSend && (
          <button
            type="button"
            className={"iconbtn chat-context-toggle"
              + (context.open ? " chat-context-toggle--on" : "")}
            aria-label={context.open ? "Hide Companion details" : "Show Companion details"}
            title="Companion details"
            aria-pressed={context.open}
            onClick={context.onToggle}
          >
            <Icon name="panel-right" size={16} />
          </button>
        )}
      </header>

      {notice && <div className="companions-error" role="alert">{notice}</div>}

      {interruptedTurn ? (
        <InterruptedTurnNotice
          turn={interruptedTurn}
          latestOperation={companion.runtime.latest_operation ?? null}
          canAct={canSend}
          onRetry={onRetryInterrupted}
          onCancel={onCancelInterrupted}
        />
      ) : null}

      {/*
        The conversation and, for a runner, the context panel share the room below the header. A
        narrow screen has room for one of them, so there the panel comes over the conversation and
        the toggle in the header is how an operator moves between the two.
      */}
      <div ref={stageRef} className={"chat-stage" + (showContext ? " chat-stage--context" : "")}>
        {/*
          Keyed by Companion: the transcript owns the runtime and the composer, and a half-typed
          message belongs to the conversation it was meant for. Opening another Companion must hand
          over an empty composer rather than the previous draft, which would otherwise be one Enter
          away from the wrong thread.
        */}
        <CompanionTranscript
          key={companion.id}
          companion={companion}
          thread={thread}
          orgId={orgId}
          busy={busy}
          lastReadOrdinal={lastReadOrdinal}
          openedThroughOrdinal={openedThroughOrdinal}
          skills={contextSkills.map((skill) => ({ id: skill.id, label: skill.slug }))}
          plugins={contextPlugins}
          models={contextModels}
          onSend={onSend}
          onStop={onCancelInterrupted}
          onCancelQueued={onCancelInterrupted}
          onOpenRoutineRun={openRoutineRun}
          onThread={onThread}
        />
        {showContext && overlay && (
          <button
            type="button"
            className="chat-context-scrim"
            aria-label="Hide Companion details"
            onClick={context.onToggle}
          />
        )}
        {showContext && (
          <CompanionContext
            companion={companion}
            desktop={context.desktop}
            joining={context.joining}
            error={context.error}
            openingDesktop={openingDesktop}
            skills={contextSkills}
            orgId={orgId}
            routines={contextRoutines}
            memberTimezone={memberTimezone}
            onRoutinesChange={onRoutinesChange ?? (() => undefined)}
            onOpenRoutineHistory={openRoutineHistory}
            triggers={contextTriggers}
            triggerAccounts={contextTriggerAccounts}
            onTriggersChange={onTriggersChange ?? (() => undefined)}
            onOpenTriggerHistory={contextTriggerHistoryApi ? openTriggerHistory : undefined}
            onManageTriggerProviders={onManageTriggerProviders}
            onJoin={context.onJoin}
            onDesktop={onDesktop}
            onSettings={onSettings}
            onClose={context.onToggle}
          />
        )}
      </div>
      {routineHistory ? (
        <CompanionRoutineHistory
          key={`${routineHistory.routineId ?? "deleted"}:${routineHistory.runId ?? "list"}`}
          orgId={orgId}
          companionId={companion.id}
          target={routineHistory}
          memberTimezone={memberTimezone}
          canAct={canSend}
          latestOperation={companion.runtime.latest_operation ?? null}
          onRetry={onRetryInterrupted}
          onCancel={onCancelInterrupted}
          onClose={closeRoutineHistory}
        />
      ) : null}
      {triggerHistory && contextTriggerHistoryApi ? (
        <CompanionTriggerHistory
          key={`${triggerHistory.triggerId ?? "deleted"}:${triggerHistory.runId ?? "list"}`}
          orgId={orgId}
          companionId={companion.id}
          target={triggerHistory}
          memberTimezone={memberTimezone}
          api={contextTriggerHistoryApi}
          onClose={() => setTriggerHistory(null)}
        />
      ) : null}
    </section>
  );
}
