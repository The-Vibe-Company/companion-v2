import type {
  SkillDependenciesResponse,
  SkillDependencyRow,
  SkillDependencyStatus,
  SkillDependentRow,
} from "@companion/contracts";
import { Icon } from "../Icon";

/** Status → badge label / class / icon. Un-versioned set (no "update available"). */
const DEP_STATUS: Record<SkillDependencyStatus, { label: string; cls: string; icon: string }> = {
  satisfied: { label: "Satisfied", cls: "satisfied", icon: "circle-check" },
  missing: { label: "Missing", cls: "missing", icon: "alert-triangle" },
  archived: { label: "Archived", cls: "archived", icon: "archive" },
  cycle: { label: "Cycle blocked", cls: "cycle", icon: "ban" },
};

const SUMMARY_DOT: Record<SkillDependencyStatus, "ok" | "warn" | "down" | "muted"> = {
  satisfied: "ok",
  missing: "down",
  archived: "muted",
  cycle: "down",
};
const SUMMARY_ORDER: SkillDependencyStatus[] = ["satisfied", "missing", "archived", "cycle"];

function StatusBadge({ status }: { status: SkillDependencyStatus }) {
  const meta = DEP_STATUS[status];
  return (
    <span className={"dpbadge dpbadge--" + meta.cls}>
      <Icon name={meta.icon} size={12} />
      {meta.label}
    </span>
  );
}

function VersionPill({ version }: { version: string | null | undefined }) {
  if (!version) return null;
  return <span className="dpver">{version}</span>;
}

function UpdateFlag({ row }: { row: SkillDependencyRow }) {
  if ((row.install_status ?? "none") !== "update") return null;
  return (
    <span className="dpupd">
      <Icon name="arrow-up-circle" size={12} />
      Update available
    </span>
  );
}

function BehindMeta({ row }: { row: SkillDependencyRow }) {
  if ((row.install_status ?? "none") !== "update" || !row.installed_version || !row.version) return null;
  return (
    <span className="dpbehind">
      <span className="dpbehind__old">{row.installed_version}</span>
      <span className="dpbehind__arrow">-&gt;</span>
      <span className="dpbehind__new">{row.version}</span>
    </span>
  );
}

function DependencyMeta({
  note,
  row,
  via,
}: {
  note: string | null;
  row: SkillDependencyRow;
  via?: string | null;
}) {
  const hasBehind = (row.install_status ?? "none") === "update" && !!row.installed_version && !!row.version;
  if (!note && !via && !hasBehind) return null;
  return (
    <div className="dpmeta">
      {via && (
        <span className="dpvia">
          via <span className="dpvia__parent">{via}</span>
        </span>
      )}
      <BehindMeta row={row} />
      {note && <span className="dpnote">{note}</span>}
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
          <VersionPill version={row.version} />
          <UpdateFlag row={row} />
          <StatusBadge status={row.status} />
        </div>
        <DependencyMeta note={row.note} row={row} />
      </div>
    </div>
  );
}

function TransitiveRow({ row, onOpen }: { row: SkillDependencyRow; onOpen: (slug: string) => void }) {
  return (
    <div className={"dprow dprow--via" + (row.status === "cycle" ? " dprow--blocked" : "")}>
      <span className="dpname__lead">
        <Icon name="corner-down-right" size={13} />
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
          <VersionPill version={row.version} />
          <UpdateFlag row={row} />
          <StatusBadge status={row.status} />
        </div>
        <DependencyMeta note={row.note} row={row} via={row.via} />
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
        {row.note && (
          <div className="dpmeta">
            <span className="dpnote">{row.note}</span>
          </div>
        )}
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
  const transitive = deps?.transitive ?? [];
  const usedBy = deps?.used_by ?? [];
  const updatesN =
    deps?.updates_n ??
    [...requires, ...transitive].filter((row) => row.install_status === "update").length;
  const transitiveN = deps?.transitive_n ?? transitive.length;

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
      {updatesN > 0 && (
        <div className="depbanner depbanner--warn" role="status">
          <Icon name="arrow-up-circle" size={15} />
          {updatesN} {updatesN === 1 ? "dependency has" : "dependencies have"} an update available.
        </div>
      )}

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

          {(summary.length > 0 || updatesN > 0) && (
            <div className="depsum">
              {summary.map((x) => (
                <span className="depsum__item" key={x.status}>
                  <span className={"depsum__dot depsum__dot--" + x.dot} /> <span className="n">{x.n}</span> {x.label}
                </span>
              ))}
              {updatesN > 0 && (
                <span className="depsum__item">
                  <span className="depsum__dot depsum__dot--warn" /> <span className="n">{updatesN}</span>{" "}
                  {updatesN === 1 ? "update available" : "updates available"}
                </span>
              )}
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

        {/* ALSO PULLS IN */}
        <div className="depsec">
          <div className="depsec__head">
            <span className="depsec__icon">
              <Icon name="git-branch" size={15} />
            </span>
            <span className="depsec__titles">
              <span className="depsec__title">Also pulls in</span>
              <span className="depsec__sub">Dependencies of this skill's dependencies.</span>
            </span>
            <span className="depsec__n">{transitiveN}</span>
          </div>

          {transitive.length > 0 ? (
            <div className="dptable">
              {transitive.map((r) => (
                <TransitiveRow key={r.slug} row={r} onOpen={onOpenSkill} />
              ))}
            </div>
          ) : (
            <div className="dptable">
              <div className="dpempty">
                <Icon name="git-branch" size={20} />
                This skill's dependencies pull in nothing further.
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
            <span className="deplegend__sw" style={{ background: "var(--color-danger)" }} /> Cycle blocked
          </span>
        </div>
      </div>
    </>
  );
}
