"use client";

import type { Companion, CompanionDesktop } from "@companion/contracts";
import { Icon } from "../Icon";
import { companionStatus } from "./status";

/**
 * The Companion's computer, beside its conversation. This is the live Box desktop itself rather than
 * a second place to read its status: the panel shows the screen an Owner or Editor can already reach
 * in a tab, so watching Pi work no longer costs a context switch, and `Open desktop` stays exactly
 * the handoff it was for the person who wants the full screen.
 *
 * Every join mints its own URL. Box rotates the stream token on each state change, so the panel is
 * only ever handed a URL that was minted for the join now on screen, and it keeps none: closing it,
 * moving to another Companion, or a Box that stops drops the stream and the next join asks again.
 *
 * The panel is a runner's surface. It never wakes anything on its own — a desktop request observes a
 * Box and cannot resume one — so a sleeping Box is reported as asleep beside the same Wake control
 * the header offers, and a Viewer, who must never start a Box, is never handed the panel at all.
 */
export function CompanionComputer({
  companion,
  desktop,
  joining,
  error,
  openingDesktop,
  waking,
  onJoin,
  onDesktop,
  onWake,
  onClose,
}: {
  companion: Companion;
  desktop: CompanionDesktop | null;
  joining: boolean;
  error: string | null;
  openingDesktop: boolean;
  waking: boolean;
  onJoin: () => void;
  onDesktop: () => void;
  onWake: () => void;
  onClose: () => void;
}) {
  const awake = companion.runtime.state === "running";
  const status = companionStatus(companion.runtime.state);
  const streamUrl = awake ? desktop?.desktop_url ?? null : null;

  return (
    <aside className="chat-computer" aria-label={`${companion.name}'s computer`}>
      <header className="chat-computer__head">
        <Icon name="monitor" size={15} />
        <h2>Computer</h2>
        {streamUrl && desktop?.transport && (
          <span className="chat-computer__transport">{desktop.transport}</span>
        )}
        <button
          type="button"
          className="iconbtn chat-computer__close"
          aria-label="Hide the Computer panel"
          onClick={onClose}
        >
          <Icon name="x" size={15} />
        </button>
      </header>

      <div className="chat-computer__screen">
        {streamUrl ? (
          /*
            The desktop is another origin's document, so it is framed with nothing granted that would
            let it act as this app: no top-level navigation, no popups, and no access to anything of
            ours. `key` is the minted URL, so a fresh join replaces the frame rather than leaving the
            previous stream on screen while the new one connects.
          */
          <iframe
            key={streamUrl}
            className="chat-computer__frame"
            src={streamUrl}
            title={`${companion.name}'s screen`}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock"
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        ) : (
          <div className="chat-computer__empty">
            <Icon name={awake ? "monitor" : "moon"} size={22} />
            <strong>
              {awake
                ? joining ? "Connecting to the desktop..." : "No desktop on screen"
                : `${status.label} — this Box is not running`}
            </strong>
            <p>
              {awake
                ? joining
                  ? `Box is minting a fresh desktop for ${companion.name}.`
                  : "Reconnect to mint a fresh desktop for this Box."
                : `Wake ${companion.name} to see its screen. Opening this panel never starts a Box.`}
            </p>
          </div>
        )}
      </div>

      {error && <p className="chat-computer__error" role="alert">{error}</p>}

      <div className="chat-computer__actions">
        {awake ? (
          <>
            <button
              type="button"
              className="cds-btn cds-btn--secondary cds-btn--sm"
              disabled={joining}
              onClick={onJoin}
            >
              <Icon name="refresh-cw" size={14} />
              {joining ? "Connecting..." : "Reconnect"}
            </button>
            <button
              type="button"
              className="cds-btn cds-btn--secondary cds-btn--sm"
              disabled={openingDesktop}
              onClick={onDesktop}
            >
              <Icon name="external-link" size={14} />
              {openingDesktop ? "Opening..." : "Open desktop"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="cds-btn cds-btn--secondary cds-btn--sm"
            disabled={waking}
            onClick={onWake}
          >
            {waking ? "Waking..." : "Wake"}
          </button>
        )}
      </div>
    </aside>
  );
}
