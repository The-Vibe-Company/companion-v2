import type {
  SkillDependenciesResponse,
  SkillDependencyRow,
  SkillDependencyStatus,
  SkillDependentRow,
  SkillOwnerKind,
} from "@companion/contracts";
import { Icon } from "../Icon";

/** Status → badge label / class / icon. Un-versioned set (no "update available"). */
const DEP_STATUS: Record<SkillDependencyStatus, { label: string; cls: string; icon: string }> = {
  satisfied: { label: "Satisfied", cls: "satisfied", icon: "circle-check" },
  missing: { label: "Missing", cls: "missing", icon: "alert-triangle" },
  archived: { label: "Archived", cls: "archived", icon: "archive" },
  visibility: { label: "Visibility mismatch", cls: "visibility", icon: "eye-off" },
  cycle: { label: "Cycle blocked", cls: "cycle", icon: "ban" },
};

const SUMMARY_DOT: Record<SkillDependencyStatus, "ok" | "warn" | "down" | "muted"> = {
  satisfied: "ok",
  visibility: "warn",
  missing: "down",
  archived: "muted",
  cycle: "down",
};
const SUMMARY_ORDER: SkillDependencyStatus[] = ["satisfied", "visibility", "missing", "archived", "cycle"];

function depOwnerMeta(kind: SkillOwnerKind | null): { icon: string; label: string } {
  if (kind === "team") return { icon: "users", label: "Team-owned" };
  if (kind === "user") return { icon: "lock", label: "Personal" };
  return { icon: "circle-x", label: "—" };
}

function StatusBadge({ status }: { status: SkillDependencyStatus }) {
  const meta = DEP_STATUS[status];
  return (
    <span className={"dpbadge dpbadge--" + meta.cls}>
      <Icon name={meta.icon} size={12} />
      {meta.label}
    </span>
  );
}

function MetaLine({
  ownerKind,
  note,
  warnVis,
}: {
  ownerKind: SkillOwnerKind | null;
  note: string | null;
  warnVis: boolean;
}) {
  const vm = depOwnerMeta(ownerKind);
  return (
    <div className="dpmeta">
      <span className={"dpvis" + (warnVis ? " dpvis--warn" : "")}>
        <Icon name={vm.icon} size={11} />
        {vm.label}
      </span>
      {note && (
        <>
          <span className="dpmeta__sep">·</span> <span className="dpnote">{note}</span>
        </>
      )}
    </div>
  );
}

function RequiresRow({ row, onOpen }: { row: SkillDependencyRow; onOpen: (slug: string) => void }) {
  return (
    <div className={"dprow" + (row.status === "cycle" ? " dprow--blocked" : "")}>
      <span className="dpname__lead">
        <Icon name="package" size={13} />
      </span>
      <div className="dpmain">
        <div className="dpline1">
          <span className="dpslug">
            {row.can_open ? (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onOpen(row.slug);
                }}
              >
                {row.slug}
              </a>
            ) : (
              row.slug
            )}
          </span>
          <StatusBadge status={row.status} />
        </div>
        <MetaLine ownerKind={row.owner_kind} note={row.note} warnVis={row.status === "visibility"} />
      </div>
    </div>
  );
}

function UsedByRow({ row, onOpen }: { row: SkillDependentRow; onOpen: (slug: string) => void }) {
  return (
    <div className={"dprow" + (row.status === "cycle" ? " dprow--blocked" : "")}>
      <span className="dpname__lead">
        <Icon name={row.archived ? "archive" : "package"} size={13} />
      </span>
      <div className="dpmain">
        <div className="dpline1">
          <span className="dpslug">
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onOpen(row.slug);
              }}
            >
              {row.slug}
            </a>
          </span>
          <StatusBadge status={row.status} />
        </div>
        <MetaLine ownerKind={row.owner_kind} note={row.note} warnVis={row.status === "visibility"} />
      </div>
    </div>
  );
}

export function DependenciesTab({
  slug,
  version,
  deps,
  onOpenSkill,
}: {
  slug: string;
  version: string | null;
  deps: SkillDependenciesResponse | null;
  onOpenSkill: (slug: string) => void;
}) {
  const requires = deps?.requires ?? [];
  const usedBy = deps?.used_by ?? [];

  const counts = requires.reduce<Partial<Record<SkillDependencyStatus, number>>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const summary = SUMMARY_ORDER.filter((s) => counts[s]).map((s) => ({
    status: s,
    n: counts[s]!,
    label: DEP_STATUS[s].label.toLowerCase(),
    dot: SUMMARY_DOT[s],
  }));

  return (
    <>
      <h1 className="dtitle" style={{ fontSize: 20 }}>
        Dependencies
      </h1>
      <p
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--color-muted)",
          margin: "8px 0 0",
        }}
      >
        {slug} <span style={{ color: "var(--color-faint)" }}>·</span> {version ?? "—"}
      </p>

      <div className="deps" style={{ marginTop: 26 }}>
        {/* REQUIRES */}
        <div className="depsec">
          <div className="depsec__head">
            <span className="depsec__icon">
              <Icon name="package" size={15} />
            </span>
            <span className="depsec__titles">
              <span className="depsec__title">Requires</span>
              <span className="depsec__sub">Skills this version pulls in when it is installed.</span>
            </span>
            <span className="depsec__n">{requires.length}</span>
          </div>

          {summary.length > 0 && (
            <div className="depsum">
              {summary.map((x) => (
                <span className="depsum__item" key={x.status}>
                  <span className={"depsum__dot depsum__dot--" + x.dot} /> <span className="n">{x.n}</span> {x.label}
                </span>
              ))}
            </div>
          )}

          {requires.length > 0 ? (
            <div className="dptable">
              {requires.map((r) => (
                <RequiresRow key={r.slug} row={r} onOpen={onOpenSkill} />
              ))}
            </div>
          ) : (
            <div className="dptable">
              <div className="dpempty">
                <Icon name="package-open" size={20} />
                This skill declares no dependencies. It installs standalone.
              </div>
            </div>
          )}
        </div>

        {/* USED BY */}
        <div className="depsec">
          <div className="depsec__head">
            <span className="depsec__icon">
              <Icon name="corner-down-right" size={15} />
            </span>
            <span className="depsec__titles">
              <span className="depsec__title">Used by</span>
              <span className="depsec__sub">Skill versions that declare {slug} as a dependency.</span>
            </span>
            <span className="depsec__n">{usedBy.length}</span>
          </div>

          {usedBy.length > 0 ? (
            <div className="dptable">
              {usedBy.map((u) => (
                <UsedByRow key={u.slug} row={u} onOpen={onOpenSkill} />
              ))}
            </div>
          ) : (
            <div className="dptable">
              <div className="dpempty">
                <Icon name="boxes" size={20} />
                No other skill depends on this one yet.
              </div>
            </div>
          )}
        </div>

        {/* LEGEND */}
        <div className="deplegend">
          <span className="deplegend__item">
            <span className="deplegend__sw" style={{ background: "var(--color-ok)" }} /> Satisfied
          </span>
          <span className="deplegend__item">
            <span className="deplegend__sw" style={{ background: "var(--color-danger)" }} /> Missing
          </span>
          <span className="deplegend__item">
            <span className="deplegend__sw" style={{ background: "var(--color-unknown)" }} /> Archived
          </span>
          <span className="deplegend__item">
            <span className="deplegend__sw" style={{ background: "var(--color-warn)" }} /> Visibility mismatch
          </span>
          <span className="deplegend__item">
            <span className="deplegend__sw" style={{ background: "var(--color-danger)" }} /> Cycle blocked
          </span>
        </div>
      </div>
    </>
  );
}
