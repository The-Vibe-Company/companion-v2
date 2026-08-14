"use client";

import { useEffect, useState } from "react";
import type { SkillListRow } from "@companion/contracts";
import { apiFetch } from "@/lib/apiClient";
import { Icon } from "../Icon";

export type CompanionSkillOption = {
  id: string;
  slug: string;
  name: string;
  version: string | null;
  scope: "personal" | "org";
};

async function loadPickerSkills(orgId: string): Promise<CompanionSkillOption[]> {
  const rows = await apiFetch<SkillListRow[]>("/v1/skills?lib=accessible", {
    headers: { "x-companion-org": orgId },
  }).catch(() => [] as SkillListRow[]);
  return rows
    .filter((skill) => !skill.archived && skill.validation === "valid" && skill.current_version)
    .map((skill) => ({
      id: skill.id,
      slug: skill.slug,
      name: skill.display?.name ?? skill.slug,
      version: skill.current_version,
      scope: skill.scope === "personal" ? "personal" : "org",
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

/**
 * Skills-page language multi-select for which library skills a Companion may stage onto its Box.
 * Native apps never render this control (THE-320 chat-only).
 */
export function CompanionSkillPicker({
  orgId,
  selectedSkillIds,
  canWriteSkills,
  disabled,
  onSelectedSkillIdsChange,
  onCanWriteSkillsChange,
}: {
  orgId: string;
  selectedSkillIds: string[];
  canWriteSkills: boolean;
  disabled?: boolean;
  onSelectedSkillIdsChange: (ids: string[]) => void;
  onCanWriteSkillsChange: (value: boolean) => void;
}) {
  const [skills, setSkills] = useState<CompanionSkillOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPickerSkills(orgId).then((rows) => {
      if (cancelled) return;
      setSkills(rows);
    }).catch((cause) => {
      if (cancelled) return;
      setError(cause instanceof Error ? cause.message : "Skills could not be loaded.");
      setSkills([]);
    });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const toggle = (id: string, checked: boolean) => {
    onSelectedSkillIdsChange(
      checked
        ? [...selectedSkillIds, id]
        : selectedSkillIds.filter((current) => current !== id),
    );
  };

  return (
    <div className="companions-skills-picker">
      <fieldset disabled={disabled} className="companions-skills-picker__skills">
        <legend>Skills</legend>
        <p className="companions-skills-picker__hint">
          Choose which Skills Hub packages this Companion may use. Empty means only the bundled
          Companion agent skill stays on the Box.
        </p>
        {error ? <div className="companions-error" role="alert">{error}</div> : null}
        {skills === null ? (
          <p className="companions-skills-picker__empty">Loading skills…</p>
        ) : skills.length === 0 ? (
          <p className="companions-skills-picker__empty">No skills in your library yet.</p>
        ) : (
          <div className="companions-skills-picker__list" role="group" aria-label="Skills this Companion may use">
            {skills.map((skill) => {
              const checked = selectedSkillIds.includes(skill.id);
              return (
                <label key={skill.id} className={checked ? "is-selected" : undefined}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => toggle(skill.id, event.target.checked)}
                  />
                  <span>
                    <strong>{skill.name}</strong>
                    <code>
                      {skill.slug}
                      {skill.version ? ` · v${skill.version}` : ""}
                    </code>
                    <small>{skill.scope === "personal" ? "Personal" : "Organization"}</small>
                  </span>
                  {checked ? <Icon name="circle-check" size={14} /> : null}
                </label>
              );
            })}
          </div>
        )}
        <div className="companions-skills-picker__foot">
          {selectedSkillIds.length} selected
        </div>
      </fieldset>

      <label className="companions-skills-picker__write">
        <input
          type="checkbox"
          checked={canWriteSkills}
          disabled={disabled}
          onChange={(event) => onCanWriteSkillsChange(event.target.checked)}
        />
        <span>
          <strong>May create and update skills on my behalf</strong>
          <small>Off by default. When on, skills this Companion publishes appear under your account.</small>
        </span>
      </label>
    </div>
  );
}
