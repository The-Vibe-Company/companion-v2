"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { SkillListRow } from "@companion/contracts";
import { apiFetch } from "@/lib/apiClient";
import { OptionMultiSelect } from "./OptionMultiSelect";

export type CompanionSkillOption = {
  id: string;
  slug: string;
  name: string;
  version: string | null;
  scope: "personal" | "org";
};

async function fetchPickerSkills(orgId: string): Promise<CompanionSkillOption[]> {
  const rows = await apiFetch<SkillListRow[]>("/v1/skills?lib=accessible", {
    headers: { "x-companion-org": orgId },
  });
  return rows
    .filter((skill) => !skill.archived && skill.validation === "valid" && skill.current_version)
    .map((skill): CompanionSkillOption => ({
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
 * Native apps never render this control (THE-320 chat-only). Publishing rights are not a staging
 * choice: every Companion may use the whole Skills Hub API from its Box.
 */
export function CompanionSkillPicker({
  orgId,
  selectedSkillIds,
  disabled,
  footer,
  onSelectedSkillIdsChange,
}: {
  orgId: string;
  selectedSkillIds: string[];
  disabled?: boolean;
  /** Rendered under the skill list — the Box sync status line in settings. */
  footer?: ReactNode;
  onSelectedSkillIdsChange: (ids: string[]) => void;
}) {
  const [skills, setSkills] = useState<CompanionSkillOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSkills(null);
    void fetchPickerSkills(orgId)
      .then((rows) => {
        if (cancelled) return;
        setSkills(rows);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Skills could not be loaded.");
        setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return (
    <div className="companions-skills-picker">
      <OptionMultiSelect
        legend="Skills"
        hint="Choose which Skills Hub packages this Companion may use. Empty means only the bundled Companion agent skill stays on the Box."
        options={skills?.map((skill) => ({
          id: skill.id,
          title: skill.name,
          mono: `${skill.slug}${skill.version ? ` · v${skill.version}` : ""}`,
          meta: skill.scope === "personal" ? "Personal" : "Organization",
          filterKey: skill.scope,
        })) ?? null}
        selectedIds={selectedSkillIds}
        disabled={disabled}
        error={error}
        searchPlaceholder="Search skills…"
        filters={[
          { key: "org", label: "Organization" },
          { key: "personal", label: "Personal" },
        ]}
        emptyText="No skills in your library yet."
        missingLabel="Not in your library"
        footer={footer}
        onChange={onSelectedSkillIdsChange}
      />
    </div>
  );
}
