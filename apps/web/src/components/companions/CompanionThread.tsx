"use client";

import { useEffect, useRef, useState } from "react";
import type { Companion, CompanionDesktop, CompanionThread as Thread } from "@companion/contracts";
import { Icon } from "../Icon";
import { CompanionContext, type CompanionContextSkill } from "./CompanionContext";
import { CompanionTranscript } from "./CompanionTranscript";
import { companionBoxStatusLabel, companionStatus } from "./status";
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

/**
 * One Companion, one thread. The header carries the identity, the Box status chip, settings, and the
 * context toggle; the conversation and the composer below it are
 * the assistant-ui primitives. The transcript is the control-plane read model, so a Viewer sees the
 * conversation without any Box contact and gets no composer. Pi's tools and skills stay out of the
 * transcript by design.
 *
 * A runner can open the context panel beside the conversation: the Box screen as a preview, the
 * routines this Companion will keep, and the skills it may stage. It is a second pane rather than a
 * change to the transcript: the primitives keep the conversation, the composer, and their own
 * mechanics untouched whether the panel is open or not.
 */
export function CompanionThread({
  companion,
  thread,
  orgId,
  error,
  busy,
  openingDesktop,
  context,
  contextSkills,
  lastReadOrdinal,
  openedThroughOrdinal,
  onBack,
  onSend,
  onSettings,
  onThread,
  onDesktop,
}: {
  companion: Companion;
  thread: Thread | null;
  orgId: string;
  error: string | null;
  busy: boolean;
  openingDesktop: boolean;
  context: CompanionContextPanel;
  /** Selected skills this surface can name; the panel counts the ones it cannot. */
  contextSkills: CompanionContextSkill[];
  /** This reader's unread watermark when the thread was opened; the "New" divider sits past it. */
  lastReadOrdinal?: number | null;
  /** The last ordinal the thread held when it was opened, so the divider stays where reading did. */
  openedThroughOrdinal?: number | null;
  onBack: () => void;
  onSend: (content: string, clientMessageId: string) => Promise<boolean>;
  /** Null for a Viewer: the settings page refuses them, so the header must not offer the door. */
  onSettings: (() => void) | null;
  onThread: (thread: Thread) => void;
  onDesktop: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState(false);
  const status = companionStatus(companion.runtime.state);
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

  // Opening a thread unmounts the list control that was focused, so focus moves to this thread.
  useEffect(() => {
    headingRef.current?.focus();
  }, [companion.id]);

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
    <section className="chat" aria-label={`Chat with ${companion.name}`}>
      <header className="chat-head">
        <button type="button" className="iconbtn chat-back" aria-label="Back to Companions" onClick={onBack}>
          <Icon name="arrow-left" size={16} />
        </button>
        <span className="companions-avatar chat-avatar" aria-hidden="true">
          {companion.name.trim().slice(0, 1).toLocaleUpperCase("en-US") || "C"}
        </span>
        <div className="chat-identity">
          <h1 ref={headingRef} tabIndex={-1}>{companion.name}</h1>
          {companion.persona && <p>{companion.persona}</p>}
        </div>
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
            aria-label={context.open ? "Hide the context panel" : "Show the context panel"}
            aria-pressed={context.open}
            onClick={context.onToggle}
          >
            <Icon name="panel-right" size={16} />
          </button>
        )}
      </header>

      {notice && <div className="companions-error" role="alert">{notice}</div>}

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
          onSend={onSend}
          onThread={onThread}
        />
        {showContext && overlay && (
          <button
            type="button"
            className="chat-context-scrim"
            aria-label="Hide the context panel"
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
            onJoin={context.onJoin}
            onDesktop={onDesktop}
            onSettings={onSettings}
            onClose={context.onToggle}
          />
        )}
      </div>
    </section>
  );
}
