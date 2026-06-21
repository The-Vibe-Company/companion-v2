"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { mapSkill, type SkillVM } from "@/lib/types";
import { fetchSkillSearch } from "@/lib/queries";
import { visibilityMeta } from "./blocks";

export function CommandPalette({
  allSkills,
  onPick,
  onClose,
  onUpload,
}: {
  allSkills: SkillVM[];
  onPick: (id: string) => void;
  onClose: () => void;
  onUpload: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  // Results are tagged with the query that produced them so a slow/earlier response can never render
  // (or be selected) under a newer query.
  const [results, setResults] = useState<{ q: string; items: SkillVM[] }>({ q: "", items: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const ql = q.trim().toLowerCase();
  // Empty query: show the top of the already-loaded list, no network. Non-empty: debounced server-side
  // relevance search across slug, description, tools, owner, and the SKILL.md body (ranked by the API).
  useEffect(() => {
    if (!ql) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchSkillSearch(ql, controller.signal)
        .then((rows) => setResults({ q: ql, items: rows.map(mapSkill) }))
        .catch(() => {
          if (controller.signal.aborted) return;
          setResults({ q: ql, items: [] });
        });
    }, 150);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [ql]);

  // Only show results that belong to the current query; until they arrive we are still loading.
  const matched = ql !== "" && results.q === ql;
  const loading = ql !== "" && !matched;
  const skills = ql === "" ? allSkills.slice(0, 7) : matched ? results.items : [];
  const actions = [{ id: "upload", label: "Upload skill", icon: "upload" }].filter(
    (a) => !ql || a.label.toLowerCase().includes(ql),
  );
  type Item = { kind: "action"; id: string } | { kind: "skill"; id: string };
  const items: Item[] = [
    ...actions.map((a) => ({ kind: "action" as const, id: a.id })),
    ...skills.map((s) => ({ kind: "skill" as const, id: s.id })),
  ];
  useEffect(() => {
    setSel(0);
  }, [q]);

  const run = (it: Item | undefined) => {
    if (!it) return;
    if (it.kind === "skill") onPick(it.id);
    else {
      onClose();
      onUpload();
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((v) => Math.min(v + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((v) => Math.max(v - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(items[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="cpal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cpal" onKeyDown={onKey} role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cpal__search">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            className="cpal__input"
            placeholder="Search skills or run a command…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="cpal__kbd">esc</span>
        </div>
        <div className="cpal__results">
          {actions.length > 0 && <div className="cpal__group">Actions</div>}
          {actions.map((a, idx) => (
            <div
              key={a.id}
              className={"cpal__item" + (sel === idx ? " is-sel" : "")}
              onMouseEnter={() => setSel(idx)}
              onClick={() => run(items[idx])}
            >
              <span className="ico">
                <Icon name={a.icon} size={16} />
              </span>
              <span className="cpal__name cpal__name--ui">{a.label}</span>
            </div>
          ))}
          {skills.length > 0 && <div className="cpal__group">Skills</div>}
          {skills.map((s, idx) => {
            const fi = actions.length + idx;
            const visibility = visibilityMeta(s);
            return (
              <div
                key={s.id}
                className={"cpal__item" + (sel === fi ? " is-sel" : "")}
                onMouseEnter={() => setSel(fi)}
                onClick={() => run(items[fi])}
              >
                <span className="ico">
                  <Icon name="package" size={16} />
                </span>
                <span className="cpal__name">{s.id}</span>
                <span className="cpal__desc">{s.description}</span>
                <span className={"cpal__star" + (s.starred ? " is-on" : "")}>
                  <Icon name="star" size={11} />
                  <span className="tnum">{s.stars}</span>
                </span>
                <span className="cpal__scope">
                  <Icon name={visibility.icon} size={11} />
                  {visibility.label}
                </span>
              </div>
            );
          })}
          {items.length === 0 && loading && <div className="cpal__empty">Searching&hellip;</div>}
          {items.length === 0 && !loading && <div className="cpal__empty">No matches for &ldquo;{q}&rdquo;.</div>}
        </div>
        <div className="cpal__foot">
          <span className="cpal__hint">
            <span className="k">↑</span>
            <span className="k">↓</span> navigate
          </span>
          <span className="cpal__hint">
            <span className="k">↵</span> open
          </span>
          <span className="cpal__hint">
            <span className="k">esc</span> close
          </span>
        </div>
      </div>
    </div>
  );
}
