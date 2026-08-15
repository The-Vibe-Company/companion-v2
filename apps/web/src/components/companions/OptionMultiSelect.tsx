"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Icon } from "../Icon";

export type MultiSelectOption = {
  id: string;
  title: string;
  /** Mono line under the title (slug · version, account label, …). Searched together with the title. */
  mono: string;
  /** Small trailing descriptor (scope word, endpoint, …). Not searched. */
  meta?: string;
  /** Value matched against the active filter chip; options without one always pass. */
  filterKey?: string;
};

/**
 * Inline searchable multi-select shared by the Companion skill and plugin pickers. The current
 * selection is pinned in its own section above the available options so it stays visible without
 * scrolling; search narrows both sections, filter chips narrow only the available one. Selected ids
 * with no loaded option (another member's personal skill, an archived skill) render as removable
 * "missing" rows instead of silently round-tripping.
 */
export function OptionMultiSelect({
  legend,
  hint,
  options,
  selectedIds,
  disabled,
  error,
  searchPlaceholder,
  filters,
  emptyText,
  missingLabel,
  footer,
  onChange,
}: {
  legend: string;
  hint: string;
  options: MultiSelectOption[] | null;
  selectedIds: string[];
  disabled?: boolean;
  error?: string | null;
  searchPlaceholder: string;
  filters?: Array<{ key: string; label: string }>;
  emptyText: string;
  missingLabel: string;
  footer?: ReactNode;
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  const optionById = useMemo(
    () => new Map((options ?? []).map((option) => [option.id, option])),
    [options],
  );
  const needle = query.trim().toLowerCase();
  const matchesQuery = (option: MultiSelectOption) =>
    !needle
    || option.title.toLowerCase().includes(needle)
    || option.mono.toLowerCase().includes(needle);

  const selectedRows = useMemo(
    () =>
      selectedIds
        .map((id) => optionById.get(id) ?? { id, missing: true as const })
        .filter((row) => "missing" in row || matchesQuery(row)),
    // matchesQuery only depends on needle
    [selectedIds, optionById, needle],
  );
  const availableRows = useMemo(
    () =>
      (options ?? []).filter(
        (option) =>
          !selectedIds.includes(option.id)
          && matchesQuery(option)
          && (filter === "all" || !option.filterKey || option.filterKey === filter),
      ),
    [options, selectedIds, needle, filter],
  );

  const toggle = (id: string, checked: boolean) => {
    onChange(checked ? [...selectedIds, id] : selectedIds.filter((current) => current !== id));
  };

  const shown = selectedRows.length + availableRows.length;
  const filtering = needle !== "" || filter !== "all";
  const renderOption = (option: MultiSelectOption, checked: boolean) => (
    <label key={option.id} className={checked ? "is-selected" : undefined}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => toggle(option.id, event.target.checked)}
      />
      <span>
        <strong>{option.title}</strong>
        <code>{option.mono}</code>
        {option.meta ? <small>{option.meta}</small> : null}
      </span>
      {checked ? <Icon name="circle-check" size={14} /> : null}
    </label>
  );

  return (
    <fieldset disabled={disabled} className="companions-skills-picker__skills">
      <legend>{legend}</legend>
      <p className="companions-skills-picker__hint">{hint}</p>
      {error ? <div className="companions-error" role="alert">{error}</div> : null}
      {error ? (
        // A failed options fetch says nothing about the saved selection. Rendering it would show
        // every valid attachment as a removable "missing" row and invite the user to save the loss.
        null
      ) : options === null ? (
        <p className="companions-skills-picker__empty">Loading…</p>
      ) : options.length === 0 && selectedIds.length === 0 ? (
        <p className="companions-skills-picker__empty">{emptyText}</p>
      ) : (
        <>
          <div className="companions-skills-picker__toolbar">
            <div className="companions-skills-picker__search">
              <Icon name="search" size={14} />
              <input
                type="search"
                value={query}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
              />
            </div>
            {filters?.length ? (
              <div className="companions-skills-picker__chips" role="group" aria-label={`Filter ${legend.toLowerCase()}`}>
                {[{ key: "all", label: "All" }, ...filters].map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    aria-pressed={filter === chip.key}
                    onClick={() => setFilter(chip.key)}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div
            className="companions-skills-picker__list"
            role="group"
            aria-label={`${legend} this Companion may use`}
          >
            {selectedIds.length > 0 ? (
              <div className="companions-skills-picker__section">
                <span>Selected ({selectedIds.length})</span>
                <button
                  type="button"
                  className="companions-skills-picker__clear"
                  onClick={() => onChange([])}
                >
                  Clear all
                </button>
              </div>
            ) : null}
            {selectedRows.map((row) =>
              "missing" in row ? (
                <div key={row.id} className="companions-skills-picker__missing">
                  <span>
                    <strong>{missingLabel}</strong>
                    <code>{row.id}</code>
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${row.id}`}
                    onClick={() => toggle(row.id, false)}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ) : (
                renderOption(row, true)
              ),
            )}
            {selectedIds.length > 0 && availableRows.length > 0 ? (
              <div className="companions-skills-picker__section">
                <span>Available</span>
              </div>
            ) : null}
            {availableRows.map((option) => renderOption(option, false))}
            {filtering && shown === 0 ? (
              <p className="companions-skills-picker__empty">
                No {legend.toLowerCase()} match{needle ? ` "${query.trim()}"` : " this filter"}.
              </p>
            ) : null}
          </div>
        </>
      )}
      <div className="companions-skills-picker__foot">
        {selectedIds.length} selected
        {options !== null && filtering ? ` · ${shown} shown` : ""}
      </div>
      {footer}
    </fieldset>
  );
}
