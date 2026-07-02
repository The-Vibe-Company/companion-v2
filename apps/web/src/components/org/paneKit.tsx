"use client";

import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../Icon";

/** Pane header — title, optional description, and an optional right-aligned action. */
export function PaneHead({
  title,
  desc,
  action,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="sx-head">
      <div className="sx-head__row">
        <div>
          <h1 className="sx-title">{title}</h1>
          {desc && <p className="sx-desc">{desc}</p>}
        </div>
        {action ?? null}
      </div>
    </div>
  );
}

/**
 * Editable single-line field. Save/Cancel surface only when dirty; Enter saves, Escape resets.
 * When `locked`, the value is shown read-only (no edits, no Save) — used to mirror the backend
 * capability gate for non-managers so the UI doesn't offer an edit that would 403 on submit.
 */
export function EditField({
  label,
  hint,
  value,
  mono,
  prefix,
  placeholder,
  locked,
  onSave,
}: {
  label: string;
  hint?: string;
  value: string;
  mono?: boolean;
  prefix?: string;
  placeholder?: string;
  locked?: boolean;
  onSave: (next: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const dirty = !locked && v.trim() !== value && v.trim().length > 0;
  const inputId = useId();
  const wrapStyle: CSSProperties | undefined = prefix
    ? ({ "--pfx": "calc(" + prefix.length + "ch + 18px)" } as CSSProperties)
    : undefined;
  return (
    <div className="sx-field">
      <label className="sx-field__label" htmlFor={inputId}>{label}</label>
      <div className="sx-inputwrap" style={wrapStyle}>
        {prefix && <span className="pfx">{prefix}</span>}
        <input
          id={inputId}
          className={"sx-input" + (mono ? " sx-input--mono" : "")}
          value={v}
          placeholder={placeholder}
          readOnly={locked}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (locked) return;
            if (e.key === "Enter" && dirty) onSave(v.trim());
            if (e.key === "Escape") setV(value);
          }}
        />
      </div>
      {hint && <span className="sx-field__hint">{hint}</span>}
      {dirty && (
        <div className="sx-row-actions">
          <button className="btn-primary" onClick={() => onSave(v.trim())}>
            <Icon name="check" size={14} />
            Save
          </button>
          <button className="btn-sec" onClick={() => setV(value)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Editable multi-line field. Unlike EditField, an empty value can be saved so nullable settings can
 * be cleared from the UI. Enter inserts a newline; only the explicit actions save or reset.
 */
export function EditTextArea({
  label,
  hint,
  value,
  placeholder,
  locked,
  maxLength,
  rows = 6,
  removeLabel,
  onSave,
  onRemove,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  locked?: boolean;
  maxLength?: number;
  rows?: number;
  removeLabel?: string;
  onSave: (next: string) => void;
  onRemove?: () => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const dirty = !locked && v !== value;
  const inputId = useId();
  const countId = useId();
  const remaining = maxLength === undefined ? null : maxLength - v.length;
  const overLimit = remaining !== null && remaining < 0;
  return (
    <div className="sx-field">
      <label className="sx-field__label" htmlFor={inputId}>{label}</label>
      <textarea
        id={inputId}
        className="sx-textarea"
        value={v}
        placeholder={placeholder}
        readOnly={locked}
        rows={rows}
        maxLength={maxLength}
        aria-describedby={countId}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (locked) return;
          if (e.key === "Escape") setV(value);
        }}
      />
      <div className="sx-field__meta">
        {hint && <span className="sx-field__hint">{hint}</span>}
        {maxLength !== undefined && (
          <span
            className={"sx-field__count" + (overLimit ? " sx-field__count--error" : "")}
            id={countId}
            aria-live="polite"
          >
            {v.length}/{maxLength}
          </span>
        )}
      </div>
      {!locked && (dirty || (onRemove && value.trim().length > 0)) && (
        <div className="sx-row-actions">
          {dirty && (
            <>
              <button className="btn-primary" onClick={() => onSave(v)} disabled={overLimit}>
                <Icon name="check" size={14} />
                Save
              </button>
              <button className="btn-sec" onClick={() => setV(value)}>
                Cancel
              </button>
            </>
          )}
          {onRemove && value.trim().length > 0 && (
            <button
              className="btn-sec"
              onClick={() => {
                setV("");
                onRemove();
              }}
            >
              <Icon name="x" size={14} />
              {removeLabel ?? "Remove"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
