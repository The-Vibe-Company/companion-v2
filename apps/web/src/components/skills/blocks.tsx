import type { ValidationState, VisibilityFilter } from "@companion/contracts";
import type { SkillVM } from "@/lib/types";
import { Icon } from "../Icon";

export const VISIBILITY_ICON: Record<string, string> = {
  private: "lock",
  team: "users",
  everyone: "building-2",
};

export function visibilityKind(s: SkillVM): VisibilityFilter {
  if (s.visibility.everyone) return "everyone";
  if (s.visibility.teams.length) return "team";
  return "private";
}

export function visibilityMeta(s: SkillVM): { icon: string; label: string } {
  const teams = s.visibility.teams;
  if (s.visibility.everyone && teams.length > 0) {
    return { icon: "building-2", label: `Everyone + ${teams.length} team${teams.length === 1 ? "" : "s"}` };
  }
  if (s.visibility.everyone) return { icon: "building-2", label: "Everyone" };
  if (teams.length === 1) return { icon: "users", label: teams[0]!.name };
  if (teams.length > 1) return { icon: "users", label: `${teams.length} teams` };
  return { icon: "lock", label: "Private" };
}

export const VISIBILITY_DESC: Record<VisibilityFilter, string> = {
  private: "only you",
  team: "selected teams",
  everyone: "everyone in the workspace",
};
export const VISIBILITY_ORDER: VisibilityFilter[] = ["everyone", "team", "private"];

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

export function VisibilityChip({ skill }: { skill: SkillVM }) {
  const meta = visibilityMeta(skill);
  return (
    <span className="scopechip">
      <Icon name={meta.icon} size={11} />
      {meta.label}
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
