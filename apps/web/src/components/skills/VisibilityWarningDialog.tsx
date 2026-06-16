"use client";

import { useEffect, useState } from "react";
import {
  visibilityCovers,
  type SkillVisibility,
  type SkillVisibilityInput,
} from "@companion/contracts";
import { Dialog } from "../org/primitives";
import { Icon } from "../Icon";
import { fetchSkillDependencies } from "@/lib/queries";
import type { TeamVM } from "@/lib/types";

/** Which side of the dependency graph a visibility change would break. */
export type VisWarnDirection = "broaden" | "narrow";

type AffectedRow = { slug: string; visibility: SkillVisibility | null };

/** Short visibility label for a resolved (name-bearing) visibility. */
function visLabel(v: SkillVisibility | null): string {
  if (!v) return "Private";
  if (v.everyone && v.teams.length) return `Everyone + ${v.teams.length} team${v.teams.length === 1 ? "" : "s"}`;
  if (v.everyone) return "Everyone";
  if (v.teams.length === 1) return v.teams[0]!.name;
  if (v.teams.length > 1) return `${v.teams.length} teams`;
  return "Private";
}

/** Label for the proposed visibility (team values are slugs — resolve names via `teams`). */
function proposedLabel(v: SkillVisibilityInput, teams: TeamVM[]): string {
  const names = v.teams.map((slug) => teams.find((t) => t.id === slug)?.name ?? slug);
  if (v.everyone && names.length) return `Everyone + ${names.length} team${names.length === 1 ? "" : "s"}`;
  if (v.everyone) return "Everyone";
  if (names.length === 1) return names[0]!;
  if (names.length > 1) return `${names.length} teams`;
  return "Private";
}

const COPY: Record<VisWarnDirection, { title: (slug: string, t: string) => string; desc: (slug: string, t: string) => string; icon: string }> = {
  broaden: {
    icon: "alert-triangle",
    title: () => "Update sub-skills too?",
    desc: (slug, target) =>
      `Making “${slug}” visible to ${target} would leave the skills it requires less visible. Raise them to match so everyone who can see “${slug}” can use them.`,
  },
  narrow: {
    icon: "alert-triangle",
    title: () => "Reduce dependent skills too?",
    desc: (slug, target) =>
      `Making “${slug}” visible to ${target} would leave skills that depend on it more visible than “${slug}” itself. Reduce them to match, or some viewers could install a skill they cannot use.`,
  },
};

/**
 * Shown when a visibility change would break the dependency cover invariant. For "broaden" it lists
 * required sub-skills that must be raised; for "narrow" it lists dependent skills that must be
 * reduced. Offers to cascade the change to them so the invariant is restored.
 */
export function VisibilityWarningDialog({
  slug,
  visibility,
  direction,
  teams,
  onCancel,
  onConfirm,
}: {
  slug: string;
  visibility: SkillVisibilityInput;
  direction: VisWarnDirection;
  teams: TeamVM[];
  onCancel: () => void;
  /** Apply the visibility with cascade. Rejects on failure (e.g. a sub-skill the actor can't edit). */
  onConfirm: () => Promise<void>;
}) {
  const [affected, setAffected] = useState<AffectedRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const target = { everyone: visibility.everyone, teams: visibility.teams };
    const slugsOf = (v: SkillVisibility) => v.teams.map((t) => t.slug);
    fetchSkillDependencies(slug, null)
      .then((deps) => {
        if (!live) return;
        const rows: AffectedRow[] =
          direction === "broaden"
            ? deps.requires
                .filter((r) => r.can_open && r.visibility && !visibilityCovers(target, { everyone: r.visibility.everyone, teams: slugsOf(r.visibility) }))
                .map((r) => ({ slug: r.slug, visibility: r.visibility }))
            : deps.used_by
                .filter((r) => r.can_open && !visibilityCovers({ everyone: r.visibility.everyone, teams: slugsOf(r.visibility) }, target))
                .map((r) => ({ slug: r.slug, visibility: r.visibility }));
        setAffected(rows);
      })
      .catch(() => {
        if (live) setAffected([]);
      });
    return () => {
      live = false;
    };
  }, [slug, visibility, direction]);

  const target = proposedLabel(visibility, teams);
  const copy = COPY[direction];
  const count = affected?.length ?? 0;
  const noun = direction === "broaden" ? "sub-skill" : "dependent skill";

  const confirm = () => {
    setBusy(true);
    setError(null);
    onConfirm().catch((err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : `Could not update the ${noun}s.`);
    });
  };

  return (
    <Dialog
      icon={copy.icon}
      title={copy.title(slug, target)}
      desc={copy.desc(slug, target)}
      onClose={onCancel}
      foot={
        <>
          <button className="btn-sec" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={confirm} disabled={busy || affected === null}>
            {busy ? "Updating…" : count > 0 ? `Update ${count} ${noun}${count === 1 ? "" : "s"}` : `Update ${noun}s`}
          </button>
        </>
      }
    >
      {affected === null ? (
        <p className="og-field__hint">Checking dependencies…</p>
      ) : count === 0 ? (
        // The direct edges are all fine, but the server still flagged the change — deeper skills in
        // the dependency graph need updating. Confirming cascades to them.
        <p className="og-field__hint">Skills deeper in the dependency graph will be updated to match.</p>
      ) : (
        <ul className="viswarn__list">
          {affected.map((row) => {
            // Show each skill's ACTUAL resulting visibility: broadening unions its audience with the
            // target, narrowing intersects it — so e.g. narrowing a Data-only skill to Platform makes
            // it Private, not Platform.
            const rowSlugs = row.visibility?.teams.map((t) => t.slug) ?? [];
            const rowEveryone = row.visibility?.everyone ?? false;
            const resultEveryone = direction === "broaden" ? rowEveryone || visibility.everyone : rowEveryone && visibility.everyone;
            const resultSlugs =
              direction === "broaden"
                ? [...new Set([...rowSlugs, ...visibility.teams])]
                : visibility.everyone
                  ? rowSlugs
                  : rowEveryone
                    ? [...visibility.teams]
                    : rowSlugs.filter((s) => visibility.teams.includes(s));
            const nameFor = (slug: string) =>
              row.visibility?.teams.find((t) => t.slug === slug)?.name ?? teams.find((t) => t.id === slug)?.name ?? slug;
            const resultLabel =
              resultEveryone && resultSlugs.length
                ? `Everyone + ${resultSlugs.length} team${resultSlugs.length === 1 ? "" : "s"}`
                : resultEveryone
                  ? "Everyone"
                  : resultSlugs.length === 1
                    ? nameFor(resultSlugs[0]!)
                    : resultSlugs.length > 1
                      ? `${resultSlugs.length} teams`
                      : "Private";
            return (
              <li key={row.slug} className="viswarn__row">
                <span className="viswarn__slug">{row.slug}</span>
                <span className="dpvis dpvis--warn">
                  <Icon name="lock" size={12} />
                  {visLabel(row.visibility)}
                  <Icon name="arrow-right" size={12} />
                  {resultLabel}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="viswarn__err" role="alert">{error}</p>}
    </Dialog>
  );
}
