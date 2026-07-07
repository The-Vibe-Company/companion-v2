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
    case "starting":
      return { cls: "ls-badge--warn", label: "starting", pulsing: true };
    case "running":
      return { cls: "ls-badge--ok", label: "running", pulsing: true };
    case "frozen":
      return { cls: "ls-badge--neutral", label: "ended", pulsing: false };
    case "error":
      return { cls: "vbadge--down", label: "error", pulsing: false };
  }
}

export function RunSessionsTab({
  runs,
  onOpen,
}: {
  runs: SkillRunRow[];
  onOpen: (runId: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <div className="ddoc">
        <div style={{ padding: "38px 0", textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-fg)", fontWeight: 500 }}>
            You haven&rsquo;t run this skill yet.
          </p>
          <p style={{ margin: "6px 0 0", fontSize: "var(--text-xs)", color: "var(--color-muted)" }}>
            Sessions are private to you — other members never see your runs. Click &ldquo;Run skill&rdquo; to start one.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="ddoc">
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 0" }} role="list" aria-label="Your runs">
        {runs.map((run) => {
          const chip = statusChip(run.status);
          return (
            <button
              key={run.id}
              type="button"
              role="listitem"
              onClick={() => onOpen(run.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                textAlign: "left",
                border: "1px solid var(--color-line)",
                borderRadius: "var(--radius-md)",
                background: "var(--color-surface)",
                padding: "10px 12px",
                cursor: "pointer",
              }}
              title="Open this session"
            >
              <Icon name="play" size={13} style={{ color: "var(--color-muted)", flex: "none" }} />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: "var(--text-sm)",
                  color: "var(--color-fg)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {run.prompt_excerpt || "(no prompt)"}
              </span>
              {run.artifacts_count > 0 && (
                <span className="mono" style={{ fontSize: 10, color: "var(--color-muted)", flex: "none" }} title="Published artifacts">
                  <Icon name="link-2" size={10} style={{ marginRight: 3 }} />
                  {run.artifacts_count}
                </span>
              )}
              <span className="mono" style={{ fontSize: 10, color: "var(--color-faint)", flex: "none" }}>
                {run.model}
              </span>
              <span className={`ls-badge ${chip.cls}`} style={{ flex: "none" }}>
                {chip.pulsing && <Icon name="loader" size={9} className="ls-spin" style={{ marginRight: 3 }} />}
                {chip.label}
              </span>
              <span className="mono" style={{ fontSize: 10, color: "var(--color-faint)", flex: "none", minWidth: 60, textAlign: "right" }}>
                {relativeTime(run.last_active_at ?? run.created_at)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
