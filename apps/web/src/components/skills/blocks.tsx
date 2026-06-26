import type { ValidationState } from "@companion/contracts";
import { Icon } from "../Icon";
import { UserAvatar } from "../UserAvatar";

export function vdot(v: ValidationState): "ok" | "down" | "unknown" {
  return v === "valid" ? "ok" : v === "invalid" ? "down" : "unknown";
}

export function syncView(s: string): { dot: "ok" | "warn" | "unknown" } {
  if (/^synced/.test(s)) return { dot: "ok" };
  if (s === "pending") return { dot: "unknown" };
  return { dot: "warn" };
}

export function Avatar({
  initials,
  avatarUrl = null,
  size = 18,
}: {
  initials: string;
  avatarUrl?: string | null;
  size?: number;
}) {
  return (
    <UserAvatar
      className="avatar"
      avatarUrl={avatarUrl}
      initials={initials}
      style={{ width: size, height: size, fontSize: size <= 18 ? 8 : 9 }}
    />
  );
}

export function ValidBadge({ v }: { v: ValidationState }) {
  if (v === "valid")
    return (
      <span className="vbadge vbadge--ok">
        <span className="vdot vdot--ok" />
        Valid
      </span>
    );
  if (v === "invalid")
    return (
      <span className="vbadge vbadge--down">
        <span className="vdot vdot--down" />
        Invalid
      </span>
    );
  return (
    <span className="vbadge vbadge--warn">
      <span className="vdot vdot--unknown" />
      Validating
    </span>
  );
}

export type InstallState = "none" | "installed" | "update";

/**
 * Per-user install indicator. Returns null for "none" so list rows stay quiet (only Installed /
 * Update available ever show). Color is always paired with a label per the DESIGN.md status rule.
 */
export function InstallBadge({ state }: { state: InstallState }) {
  if (state === "installed")
    return (
      <span className="ibadge ibadge--ok">
        <span className="ibadge__dot" />
        Installed
      </span>
    );
  if (state === "update")
    return (
      <span className="ibadge ibadge--warn">
        <span className="ibadge__dot" />
        Update available
      </span>
    );
  return null;
}

/**
 * Compact icon-only install indicator for dense list rows (the full text badge lives in the detail
 * header). The icon shape carries the meaning, not just color; the label is exposed via title/aria.
 */
export function InstallMark({ state }: { state: InstallState }) {
  if (state === "installed")
    return (
      <span className="imark imark--ok" title="Installed" aria-label="Installed">
        <Icon name="circle-check" size={13} />
      </span>
    );
  if (state === "update")
    return (
      <span className="imark imark--warn" title="Update available" aria-label="Update available">
        <Icon name="arrow-up-circle" size={13} />
      </span>
    );
  return null;
}

/** GitHub-style star toggle (detail topbar). */
export function StarButton({
  starred,
  count,
  onToggle,
}: {
  starred: boolean;
  count: number;
  onToggle: () => void;
}) {
  return (
    <button
      className={"starbtn" + (starred ? " is-on" : "")}
      onClick={onToggle}
      title={starred ? "Unstar this skill" : "Star this skill"}
      aria-pressed={starred}
    >
      <Icon name="star" size={14} />
      <span>{starred ? "Starred" : "Star"}</span>
      <span className="starbtn__count tnum">{count}</span>
    </button>
  );
}

/** key: value highlighter for the SKILL.md frontmatter preview. */
export function Frontmatter({ text }: { text: string }) {
  return (
    <div className="code">
      {text.split("\n").map((ln, i) => {
        const m = ln.match(/^(\s*[\w.-]+:)(.*)$/);
        return (
          <div key={i}>
            {m ? (
              <>
                <span className="k">{m[1]}</span>
                <span className="s">{m[2]}</span>
              </>
            ) : (
              <span className="s">{ln || " "}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function SkillBody({ description }: { description: string }) {
  return (
    <div className="prose">
      <h4>What it does</h4>
      <p>{description}</p>
      <h4>Usage</h4>
      <p>
        Install the skill on an agent you can edit. It is delivered as a versioned SKILL.md package and
        runs against the agent&apos;s declared tools on its next reconcile.
      </p>
    </div>
  );
}
