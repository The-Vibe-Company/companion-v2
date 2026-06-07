"use client";

import { useEffect, useState } from "react";
import type { Scope, SkillCommentRow, SkillVersionRow } from "@companion/contracts";
import { Icon } from "../Icon";
import { addComment as addCommentRpc, fetchSkillDetail, fetchSkillDownloadUrl } from "@/lib/queries";
import type { MeVM, SkillVM } from "@/lib/types";
import { ScopeChip, StarButton, SkillBody, ValidBadge, Frontmatter } from "./blocks";
import { Activity, Comments, PropList } from "./detailParts";

export function DetailView({
  skill,
  index,
  total,
  me,
  onBack,
  onPrev,
  onNext,
  onToggleStar,
  onChangeVisibility,
}: {
  skill: SkillVM;
  index: number;
  total: number;
  me: MeVM;
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToggleStar: () => void;
  onChangeVisibility: (s: Scope) => void;
}) {
  const invalid = skill.validation === "invalid";
  const [versions, setVersions] = useState<SkillVersionRow[]>([]);
  const [comments, setComments] = useState<SkillCommentRow[]>([]);
  const [frontmatter, setFrontmatter] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchSkillDetail(skill.id, skill.version)
      .then((d) => {
        if (!active) return;
        setVersions(d.versions);
        setComments(d.comments);
        setFrontmatter(d.frontmatter);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [skill.id, skill.version]);

  const download = async () => {
    const url = await fetchSkillDownloadUrl(skill.id, skill.version);
    window.location.href = url;
  };

  const onAddComment = (text: string) => {
    // optimistic
    const optimistic: SkillCommentRow = {
      id: `tmp-${comments.length}`,
      skill_id: skill.uuid,
      author_id: me.id,
      body: text,
      created_at: new Date().toISOString(),
      author_name: me.name,
      author_initials: me.initials,
    };
    setComments((c) => [...c, optimistic]);
    addCommentRpc(skill.id, text)
      .then((row) =>
        setComments((c) =>
          c.map((x) =>
            x.id === optimistic.id
              ? { ...row, author_name: me.name, author_initials: me.initials }
              : x,
          ),
        ),
      )
      .catch(() => setComments((c) => c.filter((x) => x.id !== optimistic.id)));
  };

  const fm = frontmatter ? frontmatter.replace(/scope: .*/, "scope: " + skill.scope) : null;

  return (
    <div className="dpage">
      <div className="dtop">
        <div className="crumb">
          <button className="crumb__btn" onClick={onBack}>
            <Icon name="package" size={13} />
            Skills
          </button>
          <span className="crumb__sep">/</span> <b>{skill.id}</b>
        </div>
        <span className="dtop__spacer" />
        <span className="navpair">
          <button title="Previous skill" onClick={onPrev} disabled={index <= 0}>
            <Icon name="chevron-up" size={15} />
          </button>
          <button title="Next skill" onClick={onNext} disabled={index >= total - 1}>
            <Icon name="chevron-down" size={15} />
          </button>
        </span>
        <span className="count tnum">
          {index + 1} / {total}
        </span>
        <StarButton starred={skill.starred} count={skill.stars} onToggle={onToggleStar} />
        <button
          className="btn-primary"
          disabled={invalid}
          onClick={download}
          title={invalid ? "Resolve validation errors first" : "Install skill"}
        >
          <Icon name="download" size={14} />
          Install skill
        </button>
        <button className="iconbtn" title="Download package" onClick={download}>
          <Icon name="package-2" size={15} />
        </button>
        <button className="iconbtn" title="More">
          <Icon name="more-horizontal" size={15} />
        </button>
      </div>

      <div className="dbody">
        <div className="dcontent">
          <div className="dcontent__inner">
            <h1 className="dtitle">{skill.id}</h1>
            <div className="dchips">
              <ScopeChip scope={skill.scope} />
              <ValidBadge v={skill.validation} />
              <span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--color-muted)" }}>
                {skill.version ?? "—"}
              </span>
            </div>
            <div className="dblocks">
              {invalid && skill.error && (
                <div>
                  <p className="seclabel" style={{ color: "var(--color-danger)" }}>
                    Validation error
                  </p>
                  <div className="errblock">{skill.error}</div>
                </div>
              )}
              <SkillBody description={skill.description} />
              {fm && (
                <div>
                  <p className="seclabel">SKILL.md frontmatter</p>
                  <Frontmatter text={fm} />
                </div>
              )}
              <div>
                <p className="seclabel">
                  Activity <span className="seclabel__n">{versions.length}</span>
                </p>
                <Activity versions={versions} ownerName={skill.owner.name} />
              </div>
              <Comments list={comments} me={me} onAdd={onAddComment} />
            </div>
          </div>
        </div>
        <aside className="dsidebar">
          <p className="railhead">Properties</p>
          <PropList skill={skill} onChangeVisibility={onChangeVisibility} />
        </aside>
      </div>
    </div>
  );
}
