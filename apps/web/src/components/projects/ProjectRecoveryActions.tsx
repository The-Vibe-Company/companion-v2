"use client";

import { Icon } from "../Icon";

export function ProjectRecoveryActions({
  busy,
  error,
  onRetry,
  onSettings,
}: {
  busy: boolean;
  error: string | null;
  onRetry: () => void;
  onSettings: () => void;
}) {
  return (
    <div className="cowork-recovery" aria-busy={busy}>
      {error && (
        <span className="cowork-recovery__error" role="alert">
          {error}
        </span>
      )}
      <div className="cowork-recovery__actions">
        <button
          type="button"
          className="cds-btn cds-btn--primary cds-btn--sm"
          disabled={busy}
          onClick={onRetry}
        >
          <Icon
            name={busy ? "loader" : "refresh-cw"}
            size={13}
            className={busy ? "ls-spin" : undefined}
          />
          <span aria-live="polite">{busy ? "Trying…" : "Try again"}</span>
        </button>
        <button
          type="button"
          className="cds-btn cds-btn--secondary cds-btn--sm"
          onClick={onSettings}
        >
          Project settings
        </button>
      </div>
    </div>
  );
}
