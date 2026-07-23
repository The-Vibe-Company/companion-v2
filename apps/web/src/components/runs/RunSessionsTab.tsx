"use client";

import type { SkillRunRow, SkillRunStatus } from "@companion/contracts";
import { Icon } from "../Icon";
import { relativeTime } from "@/lib/format";

/**
 * The skill detail's Sessions tab: the CALLER's past runs of this skill, newest first. Sessions are
 * private to the launcher (creator-only, no admin override) — the empty state says so out loud so
 * the privacy model is visible in the UI.
 */

function statusChip(status: SkillRunStatus): { cls: string; label: string; pulsing: boolean } {
  switch (status) {
    case "queued":
      return { cls: "ls-badge--neutral", label: "queued", pulsing: false };
    case "starting":
      return { cls: "ls-badge--warn", label: "starting", pulsing: true };
    case "running":
      return { cls: "ls-badge--ok", label: "running", pulsing: true };
    case "frozen":
      return { cls: "ls-badge--neutral", label: "ended", pulsing: false };
    case "interrupted":
      return { cls: "ls-badge--warn", label: "interrupted", pulsing: false };
    case "error":
      return { cls: "vbadge--down", label: "error", pulsing: false };
    case "canceled":
      return { cls: "ls-badge--neutral", label: "canceled", pulsing: false };
  }
}

export function RunSessionsTab({
  runs,
  loading,
  error,
  onRetry,
  onOpen,
}: {
  runs: SkillRunRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpen: (runId: string) => void;
}) {
  if (loading && runs.length === 0) {
    return <div className="ddoc run-sessions__state" role="status">Loading your private sessions…</div>;
  }
  if (error && runs.length === 0) {
    return (
      <div className="ddoc run-sessions__state" role="alert">
        <span>{error}</span>
        <button type="button" className="btn-sec" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="ddoc">
        <div style={{ padding: "38px 0", textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-fg)", fontWeight: 500 }}>
            You haven&rsquo;t run this skill yet.
          </p>
          <p style={{ margin: "6px 0 0", fontSize: "var(--text-xs)", color: "var(--color-muted)" }}>
            Sessions are private to you; other members never see your runs. Click &ldquo;Run skill&rdquo; to start one.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="ddoc">
      {error && (
        <div className="run-sessions__refresh-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn-sec" onClick={onRetry}>Retry</button>
        </div>
      )}
      <ul className="run-sessions" aria-label="Your runs" aria-busy={loading || undefined}>
        {runs.map((run) => {
          const chip = statusChip(run.status);
          return (
            <li key={run.id}>
              <button type="button" className="run-session" onClick={() => onOpen(run.id)} title="Open this session">
                <Icon name="play" size={13} className="run-session__play" />
                <span className="run-session__prompt">{run.prompt_excerpt || "(no prompt)"}</span>
                <span
                  className="run-session__model mono"
                  title={run.run_config_name_snapshot ? `${run.run_config_name_snapshot} · ${run.model}` : run.model}
                >
                  {run.run_config_name_snapshot ? `${run.run_config_name_snapshot} · ` : ""}{run.model}
                </span>
                <span className={`ls-badge ${chip.cls} run-session__status`}>
                  {chip.pulsing && <Icon name="loader" size={9} className="ls-spin" />}
                  {chip.label}
                </span>
                <span className="run-session__time mono">{relativeTime(run.last_active_at ?? run.created_at)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
