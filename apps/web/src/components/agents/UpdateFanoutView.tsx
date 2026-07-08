"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AffectedAgentsResponse, AgentDetail, AgentStatus } from "@companion/contracts";
import { fetchAgent, fetchSkillUpdates, pushAgentSkill } from "@/lib/agentQueries";
import { relativeTime } from "@/lib/format";
import { Icon } from "../Icon";
import { statusDot } from "./derive";
import {
  allSelected,
  fanoutQueue,
  fanoutReducer,
  fanoutRowState,
  fanoutSummary,
  initFanout,
  type FanoutRowState,
} from "./fanout";

/**
 * The skill-update fan-out screen (`/agents?view=update&skill=<slug>`): a FROZEN snapshot of the
 * affected agents (names + prev versions survive the run), pushed strictly sequentially — one
 * agent at a time, polling each push's pending_op until updated | failed, then the next.
 */

const POLL_MS = 750;
const MONO_FAINT_11: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-faint)" };
const MONO_MUTED_11: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-muted)" };
const ACCENT_CHIP: CSSProperties = { background: "var(--color-accent-tint)", borderColor: "var(--color-accent-line)" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function Crumb({ onBack }: { onBack: () => void }) {
  return (
    <nav className="crumb">
      <button type="button" className="crumb__btn" onClick={onBack}>
        <Icon name="arrow-left" size={12} />
        Agents
      </button>
      <span className="crumb__sep">/</span>
      <b>Skill update</b>
    </nav>
  );
}

/** The right 108px status cell of one row. */
function RowStatusCell({ state }: { state: FanoutRowState }) {
  return (
    <span style={{ width: 108, display: "inline-flex", justifyContent: "flex-end" }}>
      {state === "idle" && <span style={MONO_FAINT_11}>—</span>}
      {(state === "pushing" || state === "restarting") && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, ...MONO_MUTED_11 }}>
          <Icon name="loader" size={11} className="ls-spin" />
          {state}
        </span>
      )}
      {state === "updated" && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-ok)" }}>
          <Icon name="check" size={11} />
          updated
        </span>
      )}
      {state === "failed" && (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-danger)" }}>failed</span>
      )}
      {state === "skipped" && <span style={MONO_FAINT_11}>skipped</span>}
    </span>
  );
}

function FanoutLoaded({
  skillSlug,
  data,
  onBack,
  onAgentDetail,
}: {
  skillSlug: string;
  data: AffectedAgentsResponse;
  onBack: () => void;
  onAgentDetail: (row: AgentDetail) => void;
}) {
  const [state, dispatch] = useReducer(
    fanoutReducer,
    data.agents.map((a) => ({ id: a.slug, prevVersion: a.pinned_version, status: a.status })),
    initFanout,
  );
  // Live status dots (from the last fetched detail per agent) layered over the frozen snapshot.
  const [live, setLive] = useState<Record<string, AgentStatus>>({});

  // Synchronous mirrors: the runner is gated on runningRef (StrictMode-safe — never on a flag set
  // inside a setState updater) and reads the current selection via stateRef.
  const stateRef = useRef(state);
  stateRef.current = state;
  const runningRef = useRef(false);
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  const startPush = () => {
    if (runningRef.current) return;
    const current = stateRef.current;
    if (current.running || current.done) return;
    const queue = fanoutQueue(current);
    if (queue.length === 0) return;
    runningRef.current = true;
    dispatch({ kind: "start" });
    void (async () => {
      for (const slug of queue) {
        if (disposedRef.current) return;
        dispatch({ kind: "progress", id: slug, phase: "pushing" });
        try {
          await pushAgentSkill(slug, skillSlug);
          // Poll the agent (~750ms) until this push's pending_op reports updated | failed.
          for (;;) {
            if (disposedRef.current) return;
            const row = await fetchAgent(slug);
            if (disposedRef.current) return;
            setLive((m) => ({ ...m, [row.slug]: row.status }));
            onAgentDetail(row);
            const op = row.pending_op;
            if (!op || op.skill_slug !== skillSlug || op.phase === "updated" || op.phase === "failed") {
              const failed = op?.skill_slug === skillSlug && op.phase === "failed";
              dispatch({ kind: "progress", id: slug, phase: failed ? "failed" : "updated" });
              break;
            }
            dispatch({ kind: "progress", id: slug, phase: op.phase });
            await sleep(POLL_MS);
          }
        } catch {
          if (disposedRef.current) return;
          // A failed push (409 busy, network, …) marks the row failed and CONTINUES to the next.
          dispatch({ kind: "progress", id: slug, phase: "failed" });
        }
      }
      if (!disposedRef.current) dispatch({ kind: "finish" });
      runningRef.current = false;
    })();
  };

  const latest = data.skill.latest_version;
  const allOn = allSelected(state);
  const selectedCount = state.selected.length;

  return (
    <div data-screen-label="Skill update fan-out" className="dpage">
      <div className="dtop">
        <Crumb onBack={onBack} />
        <span className="dtop__spacer" />
        {!state.done ? (
          <button type="button" className="btn-primary" onClick={startPush} disabled={state.running || selectedCount === 0}>
            {state.running ? "Pushing…" : `Push update to ${selectedCount} ${selectedCount === 1 ? "agent" : "agents"}`}
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={onBack}>
            Done
          </button>
        )}
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "32px 40px 64px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h1 className="dtitle">{data.skill.slug}</h1>
            <span className="chip" style={{ ...ACCENT_CHIP, color: "var(--color-fg)" }}>
              {latest}
            </span>
            {data.skill.released_at && <span style={MONO_FAINT_11}>released {relativeTime(data.skill.released_at)}</span>}
          </div>
          <p className="ddesc">{data.skill.description}</p>

          {data.skill.changelog.length > 0 && (
            <div style={{ marginTop: 22 }}>
              <div className="seclabel">What changed</div>
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5, fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>
                {data.skill.changelog.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ marginTop: 28 }}>
            <div className="seclabel">
              Affected agents <span className="seclabel__n">{state.snapshot.length} on older versions</span>
            </div>
            <div style={{ border: "1px solid var(--color-line)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  borderBottom: "1px solid var(--color-line)",
                  background: "var(--color-surface-sunken)",
                }}
              >
                <button
                  type="button"
                  onClick={() => dispatch({ kind: "toggleAll" })}
                  className={"addfolder__check" + (allOn ? " is-on" : "")}
                  style={{ cursor: "pointer" }}
                  aria-label="Select all"
                >
                  {allOn && <Icon name="check" size={11} />}
                </button>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--color-muted)" }}>
                  {selectedCount} of {state.snapshot.length} selected
                </span>
                <span style={{ flex: 1 }} />
                {state.running && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, ...MONO_MUTED_11 }}>
                    <Icon name="loader" size={12} className="ls-spin" />
                    pushing
                  </span>
                )}
              </div>
              {state.snapshot.map((row) => {
                const checked = state.selected.includes(row.id);
                const rowState = fanoutRowState(state, row.id);
                return (
                  <div
                    key={row.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "9px 12px",
                      borderBottom: "1px solid color-mix(in oklab, var(--color-line) 55%, transparent)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => dispatch({ kind: "toggle", id: row.id })}
                      className={"addfolder__check" + (checked ? " is-on" : "")}
                      style={{ cursor: "pointer" }}
                      aria-label={`${checked ? "Deselect" : "Select"} ${row.id}`}
                    >
                      {checked && <Icon name="check" size={11} />}
                    </button>
                    <span className={statusDot(live[row.id] ?? row.status)} />
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--color-fg)", flex: "none" }}>
                      {row.id}
                    </span>
                    {row.status === "sleeping" && <span style={MONO_FAINT_11}>sleeping · wakes to update</span>}
                    <span style={{ flex: 1 }} />
                    <span className="chip">{row.prevVersion}</span>
                    <span style={MONO_FAINT_11}>→</span>
                    <span className="chip" style={ACCENT_CHIP}>
                      {latest}
                    </span>
                    <RowStatusCell state={rowState} />
                  </div>
                );
              })}
            </div>
            {state.done && (
              <div className="ls-confirm" style={{ marginTop: 12 }}>
                <Icon name="check" size={14} />
                {fanoutSummary(state, latest)}
              </div>
            )}
            <p style={{ margin: "12px 0 0", fontSize: "var(--text-xs)", color: "var(--color-faint)", maxWidth: "68ch" }}>
              Pushing replaces the skill folder in each sandbox and restarts the server. Sleeping agents wake, update,
              and go back to sleep. Active sessions are not interrupted.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function UpdateFanoutView({
  skillSlug,
  onBack,
  onAgentDetail,
}: {
  skillSlug: string;
  onBack: () => void;
  /** Feeds each polled detail back to the console (AgentsApp owns the agent lists). */
  onAgentDetail: (row: AgentDetail) => void;
}) {
  const [data, setData] = useState<AffectedAgentsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    fetchSkillUpdates(skillSlug)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Could not load the skill update.");
      });
    return () => {
      cancelled = true;
    };
  }, [skillSlug]);

  if (!data) {
    return (
      <div data-screen-label="Skill update fan-out" className="dpage">
        <div className="dtop">
          <Crumb onBack={onBack} />
          <span className="dtop__spacer" />
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          <div style={{ maxWidth: 720, margin: "0 auto", padding: "32px 40px 64px" }}>
            {loadError ? (
              <pre className="errblock" style={{ margin: 0 }}>
                {loadError}
              </pre>
            ) : (
              <div style={MONO_FAINT_11}>Loading…</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // The snapshot is built ONCE from the fetched response when the loaded view mounts (frozen rows).
  return <FanoutLoaded skillSlug={skillSlug} data={data} onBack={onBack} onAgentDetail={onAgentDetail} />;
}
