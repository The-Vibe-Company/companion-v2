"use client";

import { Icon } from "../Icon";
import type { SkillVM } from "@/lib/types";
import { fetchSkillDownloadUrl } from "@/lib/queries";
import {
  resolveSkillActions,
  skillActionPermissions,
  type SkillAction,
} from "./skillActions";

const ARCH_GRID = { gridTemplateColumns: "14px minmax(0,1fr) 220px 236px" } as const;

/**
 * Archived skills list. Archived skills are hidden from normal lists but stay viewable, restorable,
 * and downloadable while a published version still references them (so existing installs never break).
 */
export function ArchivedListView({
  skills,
  onOpen,
  onUpload,
  actorId,
  onPrimaryAction,
}: {
  skills: SkillVM[];
  onOpen: (id: string) => void;
  onUpload: () => void;
  actorId: string;
  onPrimaryAction: (skill: SkillVM, action: SkillAction) => void;
}) {
  const download = async (slug: string) => {
    try {
      const url = await fetchSkillDownloadUrl(slug, null);
      window.location.href = url;
    } catch {
      /* ignore — the button is only enabled when a referencing version exists */
    }
  };

  return (
    <>
      <header className="sh">
        <h2 className="sh__title">Archived skills</h2>
        <span className="sh__count tnum">{skills.length}</span>
        <span className="sh__spacer" />
        <button className="btn-primary" onClick={onUpload}>
          <Icon name="plus" size={14} />
          Add skill
        </button>
      </header>

      <div className="archnote">
        <Icon name="info" size={15} />
        <p>
          Archived skills are hidden from active organization and search lists. They stay viewable,{" "}
          <b>restorable</b>, and remain <b>downloadable while a published version still references them</b>, so
          existing installs never break.
        </p>
      </div>

      <div className="clist">
        <div className="chead" style={ARCH_GRID}>
          <span></span>
          <span>Skill</span>
          <span>Reference</span>
          <span className="r">Actions</span>
        </div>
        {skills.map((s) => {
          const primary = resolveSkillActions(s, skillActionPermissions(s, actorId)).primary;
          // Downloadable while ANY published version references it (matches the API gate); the count
          // reflects current-version dependents, so an older-version-only reference still enables it.
          const downloadable = s.referenced ?? s.usedByCount > 0;
          const refLabel = !downloadable
            ? "Not referenced by any version"
            : s.usedByCount > 0
              ? `Referenced by ${s.usedByCount} published version${s.usedByCount === 1 ? "" : "s"}`
              : "Referenced by an earlier published version";
          return (
            <div key={s.id} className="crow crow--archived" style={ARCH_GRID}>
              <button type="button" className="crow__hit" aria-label={`Open skill ${s.id}`} onClick={() => onOpen(s.id)} />
              <span className="vdot vdot--unknown" />
              <span className="crow__name">
                {s.id}
                <span className="arch-pill">
                  <Icon name="archive" size={10} />
                  archived
                </span>
              </span>
              <span className="archbar__ref">
                <Icon name={downloadable ? "link-2" : "circle-x"} size={12} />
                {refLabel}
              </span>
              <span className="rowacts">
                {primary && (
                  <button
                    className="rowact"
                    aria-label={`${primary.label} ${s.id}`}
                    title={primary.label}
                    onClick={() => onPrimaryAction(s, primary)}
                  >
                    <Icon name={primary.icon} size={12} />
                    {primary.contextualLabel ?? primary.label}
                  </button>
                )}
                {downloadable ? (
                  <button className="rowact" onClick={() => download(s.id)}>
                    <Icon name="download" size={12} />
                    Download package
                  </button>
                ) : (
                  <button
                    className="rowact"
                    disabled
                    style={{ opacity: 0.45, cursor: "not-allowed" }}
                    title="No published version references this skill"
                  >
                    <Icon name="download" size={12} />
                    Download package
                  </button>
                )}
              </span>
            </div>
          );
        })}
        {!skills.length && (
          <div className="empty">
            <Icon name="archive" size={22} style={{ color: "var(--color-faint)" }} />
            <div className="empty__title">No archived skills</div>
            <div className="empty__desc">Archived skills are hidden from active lists but kept here for restoration.</div>
          </div>
        )}
      </div>
    </>
  );
}
