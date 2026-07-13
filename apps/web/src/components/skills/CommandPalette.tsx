"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { mapSkill, type SkillVM } from "@/lib/types";
import { fetchSkillSearch } from "@/lib/queries";
import { resolveSkillActions, skillActionPermissions, type SkillAction } from "./skillActions";

export function CommandPalette({
  allSkills,
  onPick,
  onClose,
  onUpload,
  currentSkill,
  actorId,
  onPrimaryAction,
}: {
  allSkills: SkillVM[];
  onPick: (id: string) => void;
  onClose: () => void;
  onUpload: () => void;
  currentSkill: SkillVM | null;
  actorId: string;
  onPrimaryAction: (skill: SkillVM, action: SkillAction) => void;
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
  // relevance search across slug, description, tools, and the SKILL.md body (ranked by the API).
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
  const currentPrimary = currentSkill
    ? resolveSkillActions(currentSkill, skillActionPermissions(currentSkill, actorId)).primary
    : null;
  const actions = [
    { id: "add", label: "Add skill", icon: "plus", description: null, action: null },
    ...(currentSkill && currentPrimary
      ? [
          {
            id: `skill:${currentSkill.id}:${currentPrimary.id}`,
            label: currentPrimary.label,
            icon: currentPrimary.icon,
            description: currentSkill.id,
            action: currentPrimary,
          },
        ]
      : []),
  ].filter((action) =>
    !ql || action.label.toLowerCase().includes(ql) || action.description?.toLowerCase().includes(ql),
  );
  type Item = { kind: "action"; id: string } | { kind: "skill"; id: string };
  const items: Item[] = [
    ...actions.map((a) => ({ kind: "action" as const, id: a.id })),
    ...skills.map((s) => ({ kind: "skill" as const, id: s.id })),
  ];
  const activeOptionId = items[sel] ? `command-palette-option-${sel}` : undefined;
  useEffect(() => {
    setSel(0);
  }, [q]);

  const run = (it: Item | undefined) => {
    if (!it) return;
    if (it.kind === "skill") onPick(it.id);
    else {
      const action = actions.find((candidate) => candidate.id === it.id);
      onClose();
      if (action?.action && currentSkill) onPrimaryAction(currentSkill, action.action);
      else onUpload();
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((v) => (items.length > 0 ? Math.min(v + 1, items.length - 1) : 0));
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
            role="combobox"
            aria-label="Search skills or commands"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={activeOptionId}
            placeholder="Search skills or run a command…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="cpal__kbd">esc</span>
        </div>
        <div className="cpal__results" id="command-palette-results" role="listbox" aria-label="Commands and skills">
          {actions.length > 0 && <div className="cpal__group" role="presentation">Actions</div>}
          {actions.map((a, idx) => (
            <div
              key={a.id}
              id={`command-palette-option-${idx}`}
              role="option"
              aria-selected={sel === idx}
              className={"cpal__item" + (sel === idx ? " is-sel" : "")}
              onMouseEnter={() => setSel(idx)}
              onClick={() => run(items[idx])}
            >
              <span className="ico">
                <Icon name={a.icon} size={16} />
              </span>
              <span className="cpal__name cpal__name--ui">{a.label}</span>
              {a.description && <span className="cpal__desc">{a.description}</span>}
            </div>
          ))}
          {skills.length > 0 && <div className="cpal__group" role="presentation">Skills</div>}
          {skills.map((s, idx) => {
            const fi = actions.length + idx;
            const label = s.labels[0];
            return (
              <div
                key={s.id}
                id={`command-palette-option-${fi}`}
                role="option"
                aria-selected={sel === fi}
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
                {label && (
                  <span className="cpal__scope">
                    <Icon name="folder" size={11} />
                    {label}
                  </span>
                )}
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
