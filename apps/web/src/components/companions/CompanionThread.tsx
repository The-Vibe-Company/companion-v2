"use client";

import { useEffect, useRef } from "react";
import type { Companion, CompanionThread as Thread } from "@companion/contracts";
import { Icon } from "../Icon";
import { CompanionTranscript } from "./CompanionTranscript";
import {
  COMPANION_BOX_CHIP_PREFIX,
  companionBoxStateWord,
  companionBoxStatusLabel,
  companionStatus,
} from "./status";
import { useVisualViewportPin } from "./useVisualViewportPin";

/**
 * One Companion, one thread. The header carries the identity, the Box status chip, and at most one
 * lifecycle control; the conversation and the composer below it are the assistant-ui primitives. The
 * transcript is the control-plane read model, so a Viewer sees the conversation without any Box
 * contact and gets no composer. Pi's tools and skills stay out of this surface by design.
 */
export function CompanionThread({
  companion,
  thread,
  error,
  busy,
  waking,
  openingDesktop,
  onBack,
  onSend,
  onWake,
  onDesktop,
}: {
  companion: Companion;
  thread: Thread | null;
  error: string | null;
  busy: boolean;
  waking: boolean;
  openingDesktop: boolean;
  onBack: () => void;
  onSend: (content: string, clientMessageId: string) => Promise<boolean>;
  onWake: () => void;
  onDesktop: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const status = companionStatus(companion.runtime.state);
  const canSend = thread ? thread.can_send : companion.access !== "viewer";
  const awake = companion.runtime.state === "running";
  const boxLabel = companionBoxStatusLabel(companion.runtime.state);
  const boxWord = companionBoxStateWord(companion.runtime.state);
  // Computer use is the Box desktop Lux drives, reached from the status chip itself so the header
  // keeps one control. A Viewer reads the same chip without the action: a sleeping Box has no
  // desktop, and a Viewer must never be handed anything that could start one.
  const canOpenDesktop = canSend && awake;
  // A red status without a reason tells an operator nothing. The failure this request saw wins;
  // otherwise the reason recorded on the Companion explains an Error state across reloads.
  const notice = error ?? companion.runtime.last_error;

  // Opening a thread unmounts the list control that was focused, so focus moves to this thread.
  useEffect(() => {
    headingRef.current?.focus();
  }, [companion.id]);

  // A thread is the only Companions surface a phone keyboard opens over, so it is the only one that
  // has to follow the visual viewport.
  useVisualViewportPin();

  return (
    <section className="chat" aria-label={`Chat with ${companion.name}`}>
      <header className="chat-head">
        <button type="button" className="iconbtn chat-back" aria-label="Back to Companions" onClick={onBack}>
          <Icon name="arrow-left" size={16} />
        </button>
        <span className="companions-avatar" aria-hidden="true">
          {companion.name.trim().slice(0, 1).toLocaleUpperCase("en-US") || "C"}
        </span>
        <div className="chat-identity">
          <h1 ref={headingRef} tabIndex={-1}>{companion.name}</h1>
          {companion.persona && <p>{companion.persona}</p>}
        </div>
        {/*
          The chip is a dot, what it reports, and the state word. The two halves are separate
          elements so a narrow header can drop `Box ·` and keep the word: the state must never be
          left to the colour of the dot alone.
        */}
        {canOpenDesktop ? (
          <button
            type="button"
            className={`companions-state companions-state--${status.tone} chat-box`}
            aria-label={`${boxLabel} — open the Box desktop`}
            disabled={openingDesktop}
            onClick={onDesktop}
          >
            <i aria-hidden="true" />
            <span className="chat-box__prefix">{COMPANION_BOX_CHIP_PREFIX}</span>{" "}
            <span className="chat-box__state">{openingDesktop ? "opening desktop" : boxWord}</span>
          </button>
        ) : (
          <span className={`companions-state companions-state--${status.tone} chat-box`}>
            <i aria-hidden="true" />
            <span className="chat-box__prefix">{COMPANION_BOX_CHIP_PREFIX}</span>{" "}
            <span className="chat-box__state">{boxWord}</span>
          </span>
        )}
        {canSend && !awake && (
          <button
            type="button"
            className="cds-btn cds-btn--secondary cds-btn--sm"
            disabled={waking}
            onClick={onWake}
          >
            {waking ? "Waking..." : "Wake"}
          </button>
        )}
      </header>

      {notice && <div className="companions-error" role="alert">{notice}</div>}

      {/*
        Keyed by Companion: the transcript owns the runtime and the composer, and a half-typed message
        belongs to the conversation it was meant for. Opening another Companion must hand over an empty
        composer rather than the previous draft, which would otherwise be one Enter away from the wrong
        thread.
      */}
      <CompanionTranscript
        key={companion.id}
        companion={companion}
        thread={thread}
        busy={busy}
        onSend={onSend}
      />
    </section>
  );
}
