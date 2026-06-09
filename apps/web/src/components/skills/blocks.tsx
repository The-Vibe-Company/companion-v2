import type { Scope, ValidationState } from "@companion/contracts";
import type { SkillVM } from "@/lib/types";
import { Icon } from "../Icon";

export const SCOPE_ICON: Record<string, string> = {
  private: "lock",
  team: "users",
  public: "globe",
};

/**
 * The list "Scope" cell, context-aware: each scope has a distinct icon for quick
 * differentiation, and the label carries the specific identity —
 *   public -> "public" · team -> the team display name · private -> the owner's short name.
 */
export function scopeMeta(s: SkillVM): { icon: string; label: string } {
  switch (s.scope) {
    case "public":
      return { icon: "globe", label: "public" };
    case "team":
      return { icon: "users", label: s.team ?? s.teamSlug ?? "team" };
    case "private":
      return { icon: "lock", label: s.owner.handle ?? s.owner.initials.toLowerCase() };
    default:
      return { icon: "circle", label: String(s.scope) };
  }
}
export const SCOPE_DESC: Record<string, string> = {
  private: "only you",
  team: "your team",
  public: "anyone with the link",
};
/** Order shown in the scope filter + visibility menu (broadest first). */
export const SCOPE_ORDER: Scope[] = ["public", "team", "private"];

export function vdot(v: ValidationState): "ok" | "down" | "unknown" {
  return v === "valid" ? "ok" : v === "invalid" ? "down" : "unknown";
}

export function syncView(s: string): { dot: "ok" | "warn" | "unknown" } {
  if (/^synced/.test(s)) return { dot: "ok" };
  if (s === "pending") return { dot: "unknown" };
  return { dot: "warn" };
}

export function Avatar({ initials, size = 18 }: { initials: string; size?: number }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size <= 18 ? 8 : 9 }}
    >
      {initials}
    </span>
  );
}

export function ScopeChip({ scope }: { scope: Scope }) {
  return (
    <span className="scopechip">
      <Icon name={SCOPE_ICON[scope] ?? "circle"} size={11} />
      {scope}
    </span>
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
