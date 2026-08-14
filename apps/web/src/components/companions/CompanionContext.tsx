"use client";

import type { Companion, CompanionDesktop } from "@companion/contracts";
import { Icon } from "../Icon";
import { companionStatus } from "./status";

/** One library skill this Companion may stage on its Box, named the way the Skills list names it. */
export type CompanionContextSkill = { id: string; slug: string };

/**
 * What this Companion has beside its conversation: its screen, the routines it will keep, and the
 * skills it may stage on its Box.
 *
 * The screen is the live Box desktop Lux drives, framed as a preview rather than a second place to
 * work: pointer events stop at the card, and the caption under it is the same authorized handoff that
 * opens the full desktop in its own tab. Every join mints its own URL, because Box rotates the stream
 * token on each state change, and the panel keeps none: closing it, moving to another Companion, and a
 * Box that stops all drop it and the next join asks again.
 *
 * The panel never wakes anything. A desktop request observes a Box and cannot resume one, so a
 * sleeping Box is reported as asleep beside the same Wake control the header offers, and a Viewer, who
 * must never start a Box, is never handed the panel at all.
 */
export function CompanionContext({
  companion,
  desktop,
  joining,
  error,
  openingDesktop,
  waking,
  skills,
  onJoin,
  onDesktop,
  onWake,
  onSettings,
  onClose,
}: {
  companion: Companion;
  desktop: CompanionDesktop | null;
  joining: boolean;
  error: string | null;
  openingDesktop: boolean;
  waking: boolean;
  /** The selected skills this surface could name; ids it cannot resolve are counted, not guessed. */
  skills: CompanionContextSkill[];
  onJoin: () => void;
  onDesktop: () => void;
  onWake: () => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const awake = companion.runtime.state === "running";
  const status = companionStatus(companion.runtime.state);
  const streamUrl = awake ? desktop?.desktop_url ?? null : null;
  const named = companion.selected_skill_ids
    .map((id) => skills.find((skill) => skill.id === id))
    .filter((skill): skill is CompanionContextSkill => skill !== undefined);
  const unnamed = companion.selected_skill_ids.length - named.length;

  return (
    <aside className="chat-context" aria-label={`${companion.name} context`}>
      <header className="chat-context__head">
        <h2>Context</h2>
        <button
          type="button"
          className="iconbtn chat-context__close"
          aria-label="Hide the context panel"
          onClick={onClose}
        >
          <Icon name="x" size={15} />
        </button>
      </header>

      <div className="chat-context__body">
        <section className="chat-context__block">
          <h3 className="chat-context__title">
            Screen
            {streamUrl && desktop?.transport && (
              <span className="chat-context__transport">{desktop.transport}</span>
            )}
          </h3>
          <div className="chat-context__screen">
            {streamUrl ? (
              /*
                The desktop is another origin's document, framed with nothing granted that would let
                it act as this app: no top-level navigation, no popups, and no access to anything of
                ours. `key` is the minted URL, so a fresh join replaces the frame rather than leaving
                the previous stream on screen while the new one connects. Pointer events stop at the
                card: this is the screen to watch, and the tab below it is the screen to drive.
              */
              <iframe
                key={streamUrl}
                className="chat-context__frame"
                src={streamUrl}
                title={`${companion.name}'s screen`}
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock"
                allow="clipboard-read; clipboard-write; fullscreen"
              />
            ) : (
              <div className="chat-context__tile">
                <Icon name={awake ? "monitor" : "moon"} size={20} />
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

          {error && <p className="chat-context__error" role="alert">{error}</p>}

          <p className="chat-context__caption">
            {awake ? (
              <>
                <button
                  type="button"
                  className="chat-context__link"
                  disabled={openingDesktop}
                  onClick={onDesktop}
                >
                  {companion.name}&apos;s screen · {openingDesktop ? "opening" : "open desktop"}
                </button>
                {!streamUrl && (
                  <button
                    type="button"
                    className="chat-context__link"
                    disabled={joining}
                    onClick={onJoin}
                  >
                    {joining ? "Connecting..." : "Reconnect"}
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                className="chat-context__link"
                disabled={waking}
                onClick={onWake}
              >
                {waking ? "Waking..." : `Wake ${companion.name}`}
              </button>
            )}
          </p>
        </section>

        <section className="chat-context__block">
          <h3 className="chat-context__title">
            Routines
            {/* The control is here so the section is not a claim without a shape, and it is disabled
                because nothing behind it exists yet. */}
            <button
              type="button"
              className="iconbtn chat-context__add"
              aria-label="Add a routine"
              disabled
            >
              <Icon name="plus" size={14} />
            </button>
          </h3>
          <p className="chat-context__empty">Routines are coming soon.</p>
        </section>

        <section className="chat-context__block">
          <h3 className="chat-context__title">
            Skills
            <button type="button" className="chat-context__link" onClick={onSettings}>
              Manage
            </button>
          </h3>
          {companion.selected_skill_ids.length === 0 ? (
            <p className="chat-context__empty">No library skills are attached.</p>
          ) : (
            <>
              <ul className="chat-context__chips">
                {named.map((skill) => (
                  <li key={skill.id} className="chat-context__chip mono">
                    <i aria-hidden="true" />
                    {skill.slug}
                  </li>
                ))}
                {unnamed > 0 && (
                  // Ids this reader cannot see belong to somebody's personal library; the count is
                  // honest about them rather than inventing a name for a skill they cannot read.
                  <li className="chat-context__chip chat-context__chip--quiet">
                    {unnamed} not visible to you
                  </li>
                )}
              </ul>
              <p className="chat-context__caption">
                Staged on the Box when {companion.name} wakes.
              </p>
            </>
          )}
        </section>
      </div>
    </aside>
  );
}
