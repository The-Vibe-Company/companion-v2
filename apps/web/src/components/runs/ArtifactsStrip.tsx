"use client";

import type { SkillRunArtifactRow } from "@companion/contracts";
import { Icon } from "../Icon";

/**
 * Horizontal strip of published run artifacts (Vanish links). Shown pinned above the composer in
 * the live chat and inside read-only transcripts. Expired links render disabled.
 */

function artifactIcon(artifact: SkillRunArtifactRow): string {
  const ct = artifact.content_type ?? "";
  if (ct.startsWith("image/")) return "image";
  if (ct === "text/html") return "globe";
  if (ct === "application/pdf") return "file-text";
  if (ct === "text/csv" || ct === "application/json") return "braces";
  return "file";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function ArtifactsStrip({ artifacts }: { artifacts: SkillRunArtifactRow[] }) {
  if (artifacts.length === 0) return null;
  const now = Date.now();
  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 16px",
        borderTop: "1px solid var(--color-line)",
        background: "var(--color-surface-sunken)",
        overflowX: "auto",
      }}
      aria-label="Run artifacts"
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "var(--tracking-wide)",
          color: "var(--color-faint)",
          flex: "none",
        }}
      >
        Artifacts
      </span>
      {artifacts.map((artifact) => {
        const expired = artifact.expires_at !== null && new Date(artifact.expires_at).getTime() < now;
        const chipStyle = {
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 26,
          padding: "0 10px",
          border: "1px solid var(--color-line)",
          borderRadius: "var(--radius-md)",
          background: "var(--color-surface)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: expired ? "var(--color-faint)" : "var(--color-fg)",
          whiteSpace: "nowrap",
          textDecoration: "none",
          opacity: expired ? 0.6 : 1,
          flex: "none",
        } as const;
        const body = (
          <>
            <Icon name={artifactIcon(artifact)} size={12} style={{ color: "var(--color-muted)" }} />
            <span>{artifact.file_name}</span>
            <span style={{ color: "var(--color-faint)" }}>{formatBytes(artifact.byte_size)}</span>
            {!expired && <Icon name="arrow-right" size={11} style={{ color: "var(--color-faint)" }} />}
          </>
        );
        return expired ? (
          <span key={artifact.id} style={chipStyle} title="expired">
            {body}
          </span>
        ) : (
          <a
            key={artifact.id}
            href={artifact.url}
            target="_blank"
            rel="noopener noreferrer"
            style={chipStyle}
            title={`Open ${artifact.file_name}`}
          >
            {body}
          </a>
        );
      })}
    </div>
  );
}
