"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  DependencyPlan,
  SkillDependenciesResponse,
  ValidationResult,
} from "@companion/contracts";
import type { SkillVM } from "@/lib/types";
import {
  apiBase,
  archiveSkill,
  createSkillInline,
  fetchSkillDependencies,
  issueToken,
  publishSkillPackage,
  validateSkillPackage,
  versionPackageUrl,
} from "@/lib/queries";
import { Icon } from "../Icon";

/* ------------------------------------------------------------------ helpers */

/**
 * Skills carry no owner / visibility axis — every skill is visible to every org member. Labels
 * ("folders", e.g. `marketing/seo`) are the only organizing axis: org-wide shared, applied on the
 * upload request as repeatable `label` fields and never written into SKILL.md.
 */
function skillUploadQuery(
  target?: { slug: string; skillId: string; version?: string },
  action?: "validate",
): string {
  const qs = new URLSearchParams();
  if (action) qs.set("action", action);
  if (target) {
    qs.set("expect_slug", target.slug);
    qs.set("expect_skill_id", target.skillId);
    if (target.version) qs.set("version", target.version);
  }
  return qs.toString();
}

/** Bump the patch component of a semver-ish version string. */
function nextVersion(v: string | null): string {
  const m = String(v || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return "1.0.0";
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function maskToken(t: string): string {
  if (!t) return "";
  const body = t.slice(8);
  return "cmp_pat_" + "•".repeat(Math.max(0, body.length - 4)) + body.slice(-4);
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

/** Where a skill gets installed locally (machine / Claude Code / Codex). */
const UP_TARGETS = [
  { id: "claude", name: "Claude Code", icon: "sparkles", path: (id: string) => `~/.claude/skills/${id}` },
  { id: "codex", name: "Codex", icon: "code", path: (id: string) => `~/.codex/skills/${id}` },
  { id: "local", name: "Local folder", icon: "folder", path: (id: string) => `./skills/${id}` },
] as const;
type TargetId = (typeof UP_TARGETS)[number]["id"];
function targetPath(t: TargetId, id: string): string {
  return (UP_TARGETS.find((u) => u.id === t) ?? UP_TARGETS[0]).path(id);
}
function targetName(t: TargetId): string {
  return (UP_TARGETS.find((u) => u.id === t) ?? UP_TARGETS[0]).name;
}

/** Render a code string, dimming whole-line `#` comments. */
function CodeText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((ln, i) => {
        const isComment = ln.trimStart().startsWith("#");
        return (
          <span key={i}>
            {isComment ? <span className="cm">{ln}</span> : ln}
            {i < lines.length - 1 ? "\n" : ""}
          </span>
        );
      })}
    </>
  );
}

/** Code block with a copy button. `resolveText` (optional) mints fresh content before copy. */
export function CodeBlock({
  text,
  scroll,
  copyLabel = "Copy",
  resolveText,
}: {
  text: string;
  scroll?: boolean;
  copyLabel?: string;
  resolveText?: () => Promise<string>;
}) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    let value = text;
    if (resolveText) {
      try {
        value = await resolveText();
      } catch {
        /* fall back to the displayed text */
      }
    }
    if (navigator.clipboard) await navigator.clipboard.writeText(value).catch(() => {});
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  };
  return (
    <div className={"up-code" + (scroll ? " up-code--scroll" : "")}>
      <pre>
        <CodeText text={text} />
      </pre>
      <button className={"up-copy" + (done ? " is-done" : "")} onClick={copy} type="button">
        <Icon name={done ? "check" : "copy"} size={13} />
        {done ? "Copied" : copyLabel}
      </button>
    </div>
  );
}

function ValidationList({ result }: { result: ValidationResult }) {
  return (
    <div className="up-checks">
      {result.checks.map((check) => {
        const icon = check.status === "pass" ? "check" : check.status === "warn" ? "alert-triangle" : "x";
        const statusText = check.status === "pass" ? "Passed" : check.status === "warn" ? "Warning" : "Failed";
        return (
          <div className={`up-checkrow up-checkrow--${check.status}`} key={check.id}>
            <Icon name={icon} size={13} />
            <span>
              <span className="sr-only">{statusText}: </span>
              {check.label}
              {check.detail && <span className="up-checkrow__detail"> · {check.detail}</span>}
              {check.suggestion && <span className="up-checkrow__suggestion">{check.suggestion}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Optional initial label picker for a brand-new skill: file it under one or more org-wide shared
 * folders on publish. Existing paths are selectable from the dropdown; a typed, not-yet-existing
 * kebab path can be added inline. Locked (hidden trigger) on update — labels are managed from the
 * skill detail's "Add to folder", not the version dialog.
 */
function LabelPicker({
  value,
  onChange,
  allLabels,
}: {
  value: string[];
  onChange: (labels: string[]) => void;
  allLabels: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLSpanElement>(null);
  const selected = new Set(value);
  const q = query.trim().toLowerCase();
  const matches = allLabels
    .filter((p) => !q || p.toLowerCase().includes(q))
    .sort((a, b) => a.localeCompare(b));
  const typed = query.trim();
  const canCreate = typed.length > 0 && !allLabels.includes(typed) && !selected.has(typed);
  const toggle = (path: string) => {
    onChange(selected.has(path) ? value.filter((p) => p !== path) : [...value, path]);
  };
  const create = () => {
    if (!canCreate) return;
    onChange([...value, typed]);
    setQuery("");
  };
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", h);
    return () => document.removeEventListener("click", h);
  }, [open]);
  return (
    <span
      className="up-labelsel"
      ref={ref}
      data-modal-menu-open={open ? "true" : undefined}
      onKeyDown={(event) => {
        if (!open || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        ref.current?.querySelector("button")?.focus();
      }}
    >
      <button
        className="up-labelsel__btn"
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="folder" size={13} style={{ color: "var(--color-faint)" }} />
        <span className="up-labelsel__name">
          {value.length === 0 ? "No folders" : value.length === 1 ? value[0] : `${value.length} folders`}
        </span>
        <Icon name="chevron-down" size={13} style={{ color: "var(--color-faint)" }} />
      </button>
      {open && (
        <div className="up-labelsel__menu" role="menu">
          <div className="up-labelsel__search">
            <Icon name="search" size={13} />
            <input
              className="up-labelsel__input"
              placeholder="Search or create marketing/seo…"
              value={query}
              aria-label="Search or create a folder"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate) {
                  e.preventDefault();
                  create();
                }
              }}
            />
          </div>
          <div className="up-labelsel__list">
            {matches.map((path) => {
              const on = selected.has(path);
              return (
                <button
                  key={path}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  className={"up-labelsel__item" + (on ? " is-sel" : "")}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggle(path);
                  }}
                  onClick={(event) => {
                    if (event.detail === 0) toggle(path);
                  }}
                >
                  <span className={"up-labelsel__check" + (on ? " is-on" : "")}>
                    {on && <Icon name="check" size={11} />}
                  </span>
                  <Icon name="folder" size={13} />
                  <span className="up-labelsel__iname">{path}</span>
                </button>
              );
            })}
            {matches.length === 0 && !canCreate && (
              <div className="up-labelsel__empty">No matching folders.</div>
            )}
          </div>
          {canCreate && (
            <button
              type="button"
              role="menuitem"
              className="up-labelsel__create"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                create();
              }}
              onClick={(event) => {
                if (event.detail === 0) create();
              }}
            >
              <Icon name="plus" size={13} />
              <span>
                Create <span className="mono">{typed}</span>
              </span>
            </button>
          )}
        </div>
      )}
    </span>
  );
}

export function StepLabel({ n, children }: { n?: string; children: React.ReactNode }) {
  return (
    <div className="up-fieldlabel">
      {n != null && <span className="n">{n}</span>}
      {children}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal a11y for the dialogs: focus the panel on open, trap Tab inside it, restore focus to the
 * opener on close, and close on Escape. Escape is handled in the capture phase + `stopPropagation`
 * so it never reaches the list/detail keyboard handler behind the scrim.
 */
export function useModalA11y(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    (el?.querySelector<HTMLElement>(FOCUSABLE) ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (el?.querySelector('[data-modal-menu-open="true"]')) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (x) => x.offsetParent !== null,
      );
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, [ref, onClose]);
}

/** Token row: lazily mints a scoped token on first reveal / copy / regenerate. */
export function TokenRow({
  token,
  ensure,
  regen,
  hint,
}: {
  token: string | null;
  ensure: () => Promise<string>;
  regen: () => Promise<string>;
  hint: React.ReactNode;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const reveal = async () => {
    if (!token) {
      setBusy(true);
      try {
        await ensure();
        setRevealed(true);
      } finally {
        setBusy(false);
      }
      return;
    }
    setRevealed((r) => !r);
  };
  const copy = async () => {
    setBusy(true);
    try {
      const t = token ?? (await ensure());
      if (navigator.clipboard) await navigator.clipboard.writeText(t).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } finally {
      setBusy(false);
    }
  };
  const regenerate = async () => {
    setBusy(true);
    try {
      await regen();
      setRevealed(true);
    } finally {
      setBusy(false);
    }
  };

  const display = token
    ? revealed
      ? token
      : maskToken(token)
    : "click reveal to generate a token";

  return (
    <>
      <div className="up-token">
        <span className="up-token__key">
          <Icon name="key-round" size={14} />
        </span>
        <span className={"up-token__val" + (token && revealed ? "" : " is-masked")}>{display}</span>
        <button
          className="up-token__btn"
          type="button"
          title={token && revealed ? "Hide" : "Reveal"}
          onClick={reveal}
          disabled={busy}
        >
          <Icon name={token && revealed ? "eye-off" : "eye"} size={14} />
        </button>
        <button
          className={"up-token__btn" + (copied ? " is-done" : "")}
          type="button"
          title="Copy token"
          onClick={copy}
          disabled={busy}
        >
          <Icon name={copied ? "check" : "copy"} size={14} />
        </button>
        <button
          className="up-token__btn"
          type="button"
          title="Generate a new token"
          onClick={regenerate}
          disabled={busy}
        >
          <Icon name="refresh-cw" size={14} />
        </button>
      </div>
      <p className="up-hint">{hint}</p>
    </>
  );
}

/* ----------------------------------------------------------- upload panels */

const UP_METHODS = [
  {
    id: "prompt",
    icon: "sparkles",
    name: "Assistant IA",
    tag: "AI",
    desc: "Hand a guided prompt and a scoped token to an agent.",
  },
  {
    id: "zip",
    icon: "file-archive",
    name: "Upload a package",
    desc: "Drop a zipped SKILL.md package and let Companion validate it.",
  },
  {
    id: "create",
    icon: "square-pen",
    name: "Create in the browser",
    desc: "Write the SKILL.md inline and publish without leaving the page.",
  },
] as const;
type UploadMethod = (typeof UP_METHODS)[number]["id"];

function PromptPanel({
  labels,
  setLabels,
  allLabels,
  token,
  ensure,
  regen,
  isUpdate,
  target,
}: {
  labels: string[];
  setLabels: (labels: string[]) => void;
  allLabels: string[];
  token: string | null;
  ensure: () => Promise<string>;
  regen: () => Promise<string>;
  isUpdate: boolean;
  target?: {
    slug: string;
    skillId: string;
    currentVersion: string | null;
    nextVersion: string;
  };
}) {
  const base = apiBase();
  const queryTarget = target ? { slug: target.slug, skillId: target.skillId, version: target.nextVersion } : undefined;
  const validateQuery = skillUploadQuery(queryTarget, "validate");
  const publishQuery = skillUploadQuery(queryTarget);
  // File new skills under folders by appending repeatable `label` params to the publish URL.
  const labelParams = isUpdate ? "" : labels.map((p) => `&label=${encodeURIComponent(p)}`).join("");
  const validateUrl = `${base}/skills?${validateQuery}`;
  const publishUrl = `${base}/skills?${publishQuery}${labelParams}`;
  const buildPrompt = (tok: string) =>
    target
      ? `You are updating an existing Companion skill through the workspace API.

Target skill slug: ${target.slug}
Target Companion skill id: ${target.skillId}
Current version: ${target.currentVersion ?? "none"}
Next version to publish: ${target.nextVersion}

Validation endpoint:
${validateUrl}

Publish endpoint:
${publishUrl}

Workflow:
1. Read SKILL.md and verify the frontmatter name is exactly "${target.slug}".
2. If metadata.companion_skill_id exists, verify it is exactly "${target.skillId}". If it is different, stop and tell the user this is not the same skill and they should review the package.
3. Keep vendor data under metadata. Do not add top-level version, tools, scope, or visibility fields.
4. Package SKILL.md with any referenced files once.
5. Validate first: create a POST request to the validation endpoint with the archive as the body.
6. Use Authorization: Bearer ${tok} and Content-Type: application/zip or application/gzip.
7. Read the validation response. If it reports package name mismatch, target skill id mismatch, missing target skill, or metadata.companion_skill_id mismatch, do not edit the package and do not publish. Tell the user this appears to be a different skill.
8. If result.ok is not true for any other reason, do not publish. Fix only the validation issue named by Companion, then validate once more.
9. Publish only after validation is accepted: create a POST request to the publish endpoint with the same validated archive as the body.
10. Report the published skill id and version from the response. Never publish after failed validation or ambiguous identity.`
      : `You are publishing a Companion skill through the workspace API.

The package is a standard Agent Skill: SKILL.md at the root, with YAML frontmatter containing name and description.

Validation endpoint:
${validateUrl}

Publish endpoint:
${publishUrl}

Workflow:
1. Read SKILL.md and confirm the frontmatter has name and description.
2. Keep vendor data under metadata. Do not add top-level version, tools, scope, or visibility fields.
3. Package SKILL.md with any referenced files once.
4. Validate first: create a POST request to the validation endpoint with the archive as the body.
5. Use Authorization: Bearer ${tok} and Content-Type: application/zip or application/gzip.
6. Read the validation response. If result.ok is not true, or if the response is 422, do not publish. Fix only the validation issue named by Companion, then validate once more.
7. Publish only after validation is accepted: create a POST request to the publish endpoint with the same validated archive as the body.
8. Report the published skill id and Companion-assigned version from the response. Never publish after failed validation or ambiguous identity.`;
  const displayPrompt = buildPrompt(token ?? "cmp_pat_…");
  return (
    <>
      <p className="up-panel__lede">
        Give an agent everything it needs to publish on your behalf. The token below is scoped to{" "}
        <b>skills:write</b> and expires in 90 days.
      </p>
      <div className="up-step">
        <StepLabel n="1">Upload token</StepLabel>
        <TokenRow
          token={token}
          ensure={ensure}
          regen={regen}
          hint={
            <>Keep it secret. Anyone with this token can publish skills to the workspace until it expires.</>
          }
        />
      </div>
      {!isUpdate && (
        <div className="up-step">
          <StepLabel n="2">Folders</StepLabel>
          <LabelPicker value={labels} onChange={setLabels} allLabels={allLabels} />
          <p className="up-seg-note">
            {labels.length === 0
              ? "Optional. The published skill is visible to everyone; folders just organize it."
              : `Filed under ${labels.join(", ")} on publish.`}{" "}
            Validates with <span className="mono">?{validateQuery}</span>, then publishes with{" "}
            <span className="mono">?{publishQuery}{labelParams}</span>.
          </p>
        </div>
      )}
      <div className="up-step">
        <StepLabel n={isUpdate ? "2" : "3"}>Prompt</StepLabel>
        <CodeBlock
          text={displayPrompt}
          scroll
          copyLabel="Copy prompt"
          resolveText={async () => buildPrompt(await ensure())}
        />
      </div>
    </>
  );
}

function ZipPanel({
  labels,
  setLabels,
  allLabels,
  file,
  setFile,
  isUpdate,
  validation,
  validating,
  validationError,
}: {
  labels: string[];
  setLabels: (labels: string[]) => void;
  allLabels: string[];
  file: File | null;
  setFile: (f: File | null) => void;
  isUpdate: boolean;
  validation: ValidationResult | null;
  validating: boolean;
  validationError: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dropHelpId = useId();
  const [over, setOver] = useState(false);
  return (
    <>
      <p className="up-panel__lede">
        Already have a packaged skill? Drop the <span className="inline-code">.zip</span> here. Companion
        checks the frontmatter and rejects archives with symlinks that escape the package root.
      </p>
      <div className="up-step">
        {!file ? (
          <>
          <button
            type="button"
            className={"up-drop" + (over ? " is-over" : "")}
            onClick={() => inputRef.current?.click()}
            aria-describedby={dropHelpId}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) setFile(f);
            }}
          >
            <span className="up-drop__ico">
              <Icon name="upload-cloud" size={22} />
            </span>
            <span className="up-drop__main">
              <b>Click to browse</b> or drag a package here
            </span>
            <span className="up-drop__sub" id={dropHelpId}>.zip · SKILL.md at root · up to 25 MB</span>
          </button>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip,.gz,.tgz,.tar,application/gzip"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setFile(f);
              }}
            />
          </>
        ) : (
          <div className="up-file">
            <span className="up-file__ico">
              <Icon name="file-archive" size={16} />
            </span>
            <div className="up-file__meta">
              <div className="up-file__name">{file.name}</div>
              <div className="up-file__size">{fmtSize(file.size)} · ready to validate</div>
            </div>
            <button className="up-file__x" type="button" title="Remove" onClick={() => setFile(null)}>
              <Icon name="x" size={15} />
            </button>
          </div>
        )}
        {file && (
          <div role="status" aria-live="polite" aria-busy={validating}>
            {validating && (
              <p className="up-check" style={{ marginTop: 4 }}>
                <Icon name="loader" size={14} />
                Validating package…
              </p>
            )}
            {validationError && <div className="up-errblock" role="alert">{validationError}</div>}
            {validation && <ValidationList result={validation} />}
          </div>
        )}
      </div>
      {!isUpdate && (
        <div className="up-step">
          <StepLabel n="1">Folders</StepLabel>
          <LabelPicker value={labels} onChange={setLabels} allLabels={allLabels} />
          <p className="up-seg-note">
            {labels.length === 0
              ? "Optional. Every member can see this skill; folders just organize it."
              : `Filed under ${labels.join(", ")} on upload.`}{" "}
            Set on upload; Companion does not read folders from the package.
          </p>
        </div>
      )}
    </>
  );
}

const CREATE_BODY_TEMPLATE = `# What it does

Describe the skill in a sentence or two.

# When to use it

List the situations where an agent should reach for this.

# Constraints

Note any limits, required tools, or things to avoid.`;

interface CreateForm {
  id: string;
  description: string;
  body: string;
}

function CreatePanel({
  labels,
  setLabels,
  allLabels,
  form,
  setForm,
  locked,
}: {
  labels: string[];
  setLabels: (labels: string[]) => void;
  allLabels: string[];
  form: CreateForm;
  setForm: (f: (prev: CreateForm) => CreateForm) => void;
  locked: boolean;
}) {
  const set = (k: keyof CreateForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <>
      <p className="up-panel__lede">
        {locked
          ? "Edit the skill and publish a new version. Companion validates the "
          : "Write a standard Agent Skill here. Companion assembles the "}
        <span className="inline-code">SKILL.md</span>
        {locked ? " and bumps the version on publish." : ", validates it, and publishes it as "}
        {!locked && <span className="inline-code">v1.0.0</span>}
        {!locked && "."}
      </p>
      <div className="up-step">
        <div className="up-tworow">
          <div className="up-field">
            <label className="up-field__label" htmlFor="up-create-id">
              Skill id <span className="up-field__req">*</span>
            </label>
            <input
              id="up-create-id"
              className="up-input mono"
              placeholder="research-agent"
              value={form.id}
              onChange={set("id")}
              disabled={locked}
            />
            <span className="up-field__hint">
              {locked
                ? "Locked. Publishing here adds a new version."
                : "Lowercase, dash-separated. Becomes "}
              {!locked && <span className="inline-code">name</span>}
              {!locked && " in the frontmatter."}
            </span>
          </div>
          <div className="up-field">
            <label className="up-field__label">Folders</label>
            {locked ? (
              <span className="up-field__locked">
                <Icon name="folder" size={13} style={{ color: "var(--color-faint)" }} />
                Manage folders from the skill detail
              </span>
            ) : (
              <LabelPicker value={labels} onChange={setLabels} allLabels={allLabels} />
            )}
            <span className="up-field__hint">
              {locked
                ? "File this skill from its detail view's “Add to folder”."
                : labels.length === 0
                  ? "Optional. Every member can see this skill; folders just organize it."
                  : `Filed under ${labels.join(", ")} on publish.`}
            </span>
          </div>
        </div>
      </div>
      <div className="up-step">
        <div className="up-field">
          <label className="up-field__label" htmlFor="up-create-desc">
            Description <span className="up-field__req">*</span>
          </label>
          <input
            id="up-create-desc"
            className="up-input"
            placeholder="One line on what this skill does."
            value={form.description}
            onChange={set("description")}
          />
        </div>
      </div>
      <div className="up-step">
        <div className="up-field">
          <label className="up-field__label" htmlFor="up-create-body">
            SKILL.md body <span className="up-field__opt">markdown</span>
          </label>
          <textarea
            id="up-create-body"
            className="up-textarea mono"
            value={form.body}
            onChange={set("body")}
            spellCheck={false}
            placeholder={
              locked ? "Write the new SKILL.md body. This replaces the current content on publish." : undefined
            }
          />
          <span className="up-field__hint">
            {locked
              ? "This body replaces the published SKILL.md on the new version."
              : "Companion writes the standard frontmatter for you. Folders are applied on publish, never stored in the skill."}
          </span>
        </div>
      </div>
    </>
  );
}

interface PublishOutcome {
  id: string;
  version: string;
  labels: string[];
  via: string;
  /** Non-fatal note when archive-on-publish could not archive some candidates (e.g. permissions). */
  archiveWarning?: string;
}

function DonePanel({ result, update }: { result: PublishOutcome; update: boolean }) {
  return (
    <div className="up-done">
      <span className="up-done__badge">
        <Icon name="check" size={26} />
      </span>
      <h3 className="up-done__title">{update ? "Update published" : "Skill published"}</h3>
      <p className="up-done__sub">{result.via}. Run plan &amp; apply to deploy it to your agents.</p>
      {result.archiveWarning && (
        <div className="up-errblock" role="alert" style={{ margin: "0 0 14px" }}>
          <Icon name="alert-triangle" size={13} /> {result.archiveWarning}
        </div>
      )}
      <div className="up-done__card">
        <div className="up-done__row">
          <span className="up-done__k">Skill</span>
          <span className="up-done__v">
            <Icon name="package" size={13} />
            {result.id}
          </span>
        </div>
        <div className="up-done__row">
          <span className="up-done__k">Version</span>
          <span className="up-done__v">{result.version}</span>
        </div>
        <div className="up-done__row">
          <span className="up-done__k">Folders</span>
          <span className="up-done__v">
            <Icon name="folder" size={13} />
            {result.labels.length ? result.labels.join(", ") : "None"}
          </span>
        </div>
        <div className="up-done__row">
          <span className="up-done__k">Status</span>
          <span className="up-done__v" style={{ color: "var(--color-ok)" }}>
            <span className="vdot vdot--ok" />
            valid
          </span>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- upload dialog */

/** The dependency preflight step: exactly what changes in the graph before a version is published. */
function DependencyPreflight({
  plan,
  skillId,
  nextVer,
  archiveOn,
  onToggleArchive,
}: {
  plan: DependencyPlan;
  skillId: string;
  nextVer: string;
  archiveOn: boolean;
  onToggleArchive: () => void;
}) {
  return (
    <div className="pf">
      <p className="pf__lede">
        <b>Dependency preflight.</b> Validation passed. Before publishing{" "}
        <span className="mono">{skillId}</span> as <span className="mono">{nextVer}</span>, here is exactly what
        changes in the dependency graph.
      </p>

      <div className="pf-overview">
        <div className="pf-stat">
          <div className="pf-stat__v">{plan.declared.length}</div>
          <div className="pf-stat__l">
            <Icon name="package" size={13} /> Declared
          </div>
        </div>
        <div className="pf-stat">
          <div className="pf-stat__v">{plan.ready.length}</div>
          <div className="pf-stat__l">
            <Icon name="circle-check" size={13} /> Published
          </div>
        </div>
        <div className="pf-stat pf-stat--act">
          <div className="pf-stat__v">{plan.upload.length}</div>
          <div className="pf-stat__l">
            <Icon name="upload" size={13} /> To upload
          </div>
        </div>
        <div className="pf-stat">
          <div className="pf-stat__v">{plan.removed.length}</div>
          <div className="pf-stat__l">
            <Icon name="x" size={13} /> Removed
          </div>
        </div>
      </div>

      {plan.blocked.length > 0 && (
        <div className="pf-group pf-group--act">
          <div className="pf-group__head">
            <span className="pf-group__ico">
              <Icon name="alert-triangle" size={14} />
            </span>
            <span>
              <span className="pf-group__title">Cannot publish yet</span>
              <span className="pf-group__sub">Resolve these before publishing — the version would stay unresolved.</span>
            </span>
            <span className="pf-group__n">{plan.blocked.length}</span>
          </div>
          {plan.blocked.map((b) => (
            <div className="pf-item" key={b.slug}>
              <span className="pf-item__mark pf-item__mark--add">
                <Icon name="alert-triangle" size={15} />
              </span>
              <span className="pf-item__slug">{b.slug}</span>
              <span className="pf-item__msg">{b.msg}</span>
            </div>
          ))}
        </div>
      )}

      {plan.ready.length > 0 && (
        <div className="pf-group">
          <div className="pf-group__head">
            <span className="pf-group__ico">
              <Icon name="circle-check" size={14} />
            </span>
            <span>
              <span className="pf-group__title">Already published</span>
              <span className="pf-group__sub">Declared dependencies that already exist in the workspace registry.</span>
            </span>
            <span className="pf-group__n">{plan.ready.length}</span>
          </div>
          {plan.ready.map((slug) => (
            <div className="pf-item" key={slug}>
              <span className="pf-item__mark pf-item__mark--ok">
                <Icon name="circle-check" size={15} />
              </span>
              <span className="pf-item__slug">{slug}</span>
              <span className="pf-item__tag pf-item__tag--ok">in registry</span>
            </div>
          ))}
        </div>
      )}

      {plan.upload.length > 0 && (
        <div className="pf-group pf-group--act">
          <div className="pf-group__head">
            <span className="pf-group__ico">
              <Icon name="upload" size={14} />
            </span>
            <span>
              <span className="pf-group__title">Must be uploaded too</span>
              <span className="pf-group__sub">Declared but not in the registry. Publish these or the new version stays unresolved.</span>
            </span>
            <span className="pf-group__n">{plan.upload.length}</span>
          </div>
          {plan.upload.map((d) => (
            <div className="pf-item" key={d.slug}>
              <span className="pf-item__mark pf-item__mark--add">
                <Icon name="alert-triangle" size={15} />
              </span>
              <span className="pf-item__slug">{d.slug}</span>
              <span className="pf-item__msg">{d.msg}</span>
              <span className="pf-item__tag pf-item__tag--add">upload</span>
            </div>
          ))}
        </div>
      )}

      {plan.removed.length > 0 && (
        <div className="pf-group pf-group--cut">
          <div className="pf-group__head">
            <span className="pf-group__ico">
              <Icon name="x" size={14} />
            </span>
            <span>
              <span className="pf-group__title">No longer required</span>
              <span className="pf-group__sub">Required by the previous version and dropped from this one.</span>
            </span>
            <span className="pf-group__n">{plan.removed.length}</span>
          </div>
          {plan.removed.map((slug) => (
            <div className="pf-item" key={slug}>
              <span className="pf-item__mark pf-item__mark--cut">
                <Icon name="corner-down-right" size={15} />
              </span>
              <span className="pf-item__slug" style={{ textDecoration: "line-through", color: "var(--color-faint)" }}>
                {slug}
              </span>
              <span className="pf-item__tag pf-item__tag--cut">dropped</span>
            </div>
          ))}
        </div>
      )}

      {plan.archive_candidates.length > 0 && (
        <div className="pf-group">
          <div className="pf-group__head">
            <span className="pf-group__ico">
              <Icon name="archive" size={14} />
            </span>
            <span>
              <span className="pf-group__title">Archival candidates</span>
              <span className="pf-group__sub">No published skill references these after the removal above. Archive to keep lists clean.</span>
            </span>
            <span className="pf-group__n">{plan.archive_candidates.length}</span>
          </div>
          {plan.archive_candidates.map((d) => (
            <div className="pf-item" key={d.slug}>
              <span className="pf-item__mark pf-item__mark--arch">
                <Icon name="archive" size={15} />
              </span>
              <span className="pf-item__slug">{d.slug}</span>
              <span className="pf-item__cons">{d.reason}</span>
              <button
                type="button"
                className="pf-item__check pf-cb-row"
                onClick={onToggleArchive}
                aria-pressed={archiveOn}
                aria-label={`Archive ${d.slug} on publish`}
              >
                <span className={"pf-cb" + (archiveOn ? " is-on" : "")}>
                  <Icon name="check" size={12} />
                </span>
                Archive on publish
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function UploadDialog({
  mode = "create",
  skill = null,
  allLabels = [],
  defaultLabels = [],
  onClose,
  onPublished,
}: {
  mode?: "create" | "update";
  skill?: SkillVM | null;
  /** Every label path that exists org-wide (for the optional initial folder picker on create). */
  allLabels?: string[];
  /** Folders to pre-file a brand-new skill under on create (e.g. the active sidebar folder), so the
   *  "Upload to <folder>" CTA actually files the skill there. Ignored on update. */
  defaultLabels?: string[];
  onClose: () => void;
  onPublished: () => void;
}) {
  const isUpdate = mode === "update" && !!skill;
  const [method, setMethod] = useState<UploadMethod>("prompt");
  // Optional initial folders to file a brand-new skill under (org-wide shared; create only).
  const [labels, setLabels] = useState<string[]>(defaultLabels);
  const [token, setToken] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [dependencyPlan, setDependencyPlan] = useState<DependencyPlan | null>(null);
  const [showPreflight, setShowPreflight] = useState(false);
  const [archiveOnPublish, setArchiveOnPublish] = useState(true);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [form, setForm] = useState<CreateForm>(
    isUpdate
      ? { id: skill!.id, description: skill!.description, body: "" }
      : { id: "", description: "", body: CREATE_BODY_TEMPLATE },
  );
  const [result, setResult] = useState<PublishOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const ver = isUpdate ? nextVersion(skill!.version) : "1.0.0";

  useEffect(() => {
    if (!file) {
      setValidation(null);
      setValidationError(null);
      setValidating(false);
      return;
    }
    let active = true;
    setValidation(null);
    setDependencyPlan(null);
    setValidationError(null);
    setValidating(true);
    validateSkillPackage(
      file,
      isUpdate
        ? {
            version: ver,
            expectSlug: skill!.id,
            expectSkillId: skill!.uuid,
          }
        : undefined,
    )
      .then((next) => {
        if (!active) return;
        setValidation(next.result);
        setDependencyPlan(next.dependencyPlan);
      })
      .catch((e) => {
        if (active) setValidationError(e instanceof Error ? e.message : "Validation failed");
      })
      .finally(() => {
        if (active) setValidating(false);
      });
    return () => {
      active = false;
    };
  }, [file, isUpdate, skill, ver]);

  const ensureToken = useCallback(async () => {
    if (token) return token;
    const issued = await issueToken(["skills:write"]);
    setToken(issued.token);
    return issued.token;
  }, [token]);
  const regenToken = useCallback(async () => {
    const issued = await issueToken(["skills:write"]);
    setToken(issued.token);
    return issued.token;
  }, []);

  useModalA11y(dialogRef, onClose);

  const idFromZip = isUpdate
    ? skill!.id
    : file
      ? file.name
          .replace(/\.(zip|tar\.gz|tgz|tar|gz)$/i, "")
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "new-skill"
      : "new-skill";
  const canZip = !!file && validation?.ok === true && !validating;
  const canCreate = !!(form.id.trim() && form.description.trim() && form.body.trim());

  const finishPublish = (outcome: PublishOutcome) => {
    setResult(outcome);
    onPublished();
  };

  const runZip = async () => {
    if (!file || validation?.ok !== true) return;
    setBusy(true);
    setError(null);
    try {
      const res = await publishSkillPackage(file, {
        labels: isUpdate ? undefined : labels,
        version: isUpdate ? ver : undefined,
        expectSlug: isUpdate ? skill!.id : undefined,
        expectSkillId: isUpdate ? skill!.uuid : undefined,
        dependencies: dependencyPlan?.declared ?? [],
      });
      // Archive the candidates the operator confirmed (dependencies dropped and now unreferenced).
      // The publish already succeeded, so a failed archive is non-fatal — but surface it rather than
      // silently dropping it, so the operator knows the archive step did not complete.
      let archiveWarning: string | undefined;
      if (archiveOnPublish && dependencyPlan?.archive_candidates.length) {
        const results = await Promise.allSettled(
          dependencyPlan.archive_candidates.map((c) => archiveSkill(c.slug, "Unreferenced after dependency removal")),
        );
        const failed = dependencyPlan.archive_candidates
          .filter((_, i) => results[i]!.status === "rejected")
          .map((c) => c.slug);
        if (failed.length) archiveWarning = `Published, but could not archive ${failed.join(", ")} — archive them manually if needed.`;
      }
      finishPublish({
        id: res.slug || idFromZip,
        version: res.version,
        labels: isUpdate ? skill!.labels : labels,
        via: isUpdate ? "Updated from zip" : "Uploaded from zip",
        archiveWarning,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  // Route the zip/update publish through a dependency preflight whenever the graph changes
  // (declared, dropped, or archival candidates). A no-dependency upload publishes directly.
  const hasDepReview = !!dependencyPlan &&
    (dependencyPlan.declared.length > 0 ||
      dependencyPlan.removed.length > 0 ||
      dependencyPlan.archive_candidates.length > 0);

  // Re-validate before showing the preflight so the dependency plan matches what publish will enforce
  // (avoids a clean preview that then 422s). Folders carry no access semantics, so they are not part
  // of validation — only the dependency graph is.
  const openPreflight = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const next = await validateSkillPackage(file, {
        ...(isUpdate ? { version: ver, expectSlug: skill!.id, expectSkillId: skill!.uuid } : {}),
        dependencies: dependencyPlan?.declared ?? [],
      });
      setValidation(next.result);
      setDependencyPlan(next.dependencyPlan);
      setShowPreflight(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Validation failed");
    } finally {
      setBusy(false);
    }
  };

  const runCreate = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const id = form.id.trim().toLowerCase();
      const res = await createSkillInline({
        id,
        description: form.description.trim(),
        body: form.body,
        labels: isUpdate ? undefined : labels,
      });
      finishPublish({
        id: res.slug || id,
        version: res.version,
        labels: isUpdate ? skill!.labels : labels,
        via: isUpdate ? "Edited and published" : "Created in the browser",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not publish");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setResult(null);
    setFile(null);
    setValidation(null);
    setValidationError(null);
    setError(null);
    if (!isUpdate) setForm(() => ({ id: "", description: "", body: CREATE_BODY_TEMPLATE }));
  };

  type Foot = {
    hint: [string, string];
    cta?: { label: string; icon: string; disabled: boolean; run: () => void };
  };
  const FOOT: Record<UploadMethod, Foot> = {
    prompt: { hint: ["info", "The agent validates first, then publishes only if the package is accepted."] },
    zip: {
      hint: hasDepReview
        ? ["git-branch", "Companion previews dependency changes before anything is published."]
        : ["file-archive", "The package must contain SKILL.md at its root."],
      cta: {
        label: hasDepReview ? "Review dependencies" : isUpdate ? "Publish update" : "Upload package",
        icon: hasDepReview ? "git-branch" : "upload",
        disabled: !canZip || busy,
        run: hasDepReview ? openPreflight : runZip,
      },
    },
    create: {
      hint: ["git-commit", isUpdate ? `Publishes ${skill?.id} as v${ver}.` : "Publishes as v1.0.0 in this workspace."],
      cta: {
        label: isUpdate ? "Publish update" : "Create skill",
        icon: "check",
        disabled: !canCreate || busy,
        run: runCreate,
      },
    },
  };
  const foot = FOOT[method];

  return (
    <div
      className="up-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="up"
        role="dialog"
        aria-modal="true"
        aria-label={isUpdate ? "Update skill" : "Upload skill"}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="up__head">
          <div className="up__titles">
            <h2 className="up__title">
              {result ? (
                "Done"
              ) : isUpdate ? (
                <>
                  Update <span className="mono" style={{ fontWeight: 600 }}>{skill!.id}</span>
                </>
              ) : (
                "Upload a skill"
              )}
            </h2>
            <p className="up__sub">
              {result ? (
                "Your skill is in the registry."
              ) : isUpdate ? (
                <>
                  Publish a new version. Current <span className="mono">{skill!.version}</span> · next{" "}
                  <span className="mono">{ver}</span>.
                </>
              ) : (
                "Publish a new versioned SKILL.md package to the workspace."
              )}
            </p>
          </div>
          <button className="up__x" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" size={17} />
          </button>
        </div>

        {result ? (
          <>
            <div className="up__panel" role="status" aria-live="polite">
              <DonePanel result={result} update={isUpdate} />
            </div>
            <div className="up__foot">
              <span className="up__footspacer" />
              {!isUpdate && (
                <button className="btn-ghost" type="button" onClick={reset}>
                  <Icon name="plus" size={14} />
                  Upload another
                </button>
              )}
              <button className="btn-primary" type="button" onClick={onClose}>
                <Icon name="arrow-right" size={14} />
                Done
              </button>
            </div>
          </>
        ) : showPreflight && dependencyPlan ? (
          <>
            <div className="up__panel" style={{ gridColumn: "1 / -1" }}>
              <DependencyPreflight
                plan={dependencyPlan}
                skillId={isUpdate ? skill!.id : idFromZip}
                nextVer={`v${ver}`}
                archiveOn={archiveOnPublish}
                onToggleArchive={() => setArchiveOnPublish((v) => !v)}
              />
              {error && (
                <div className="up-errblock" role="alert" style={{ marginTop: 14 }}>
                  {error}
                </div>
              )}
            </div>
            <div className="up__foot">
              <span className="up__foothint">
                <Icon name="git-branch" size={14} />
                {dependencyPlan.upload.length > 0
                  ? `${dependencyPlan.upload.length} dependency must be uploaded`
                  : "All dependencies are in the registry"}
                {dependencyPlan.archive_candidates.length > 0 &&
                  ` · ${archiveOnPublish ? dependencyPlan.archive_candidates.length : 0} will be archived`}
              </span>
              <span className="up__footspacer" />
              <button className="btn-ghost" type="button" onClick={() => setShowPreflight(false)}>
                Back
              </button>
              <button
                className="btn-primary"
                type="button"
                disabled={busy || dependencyPlan.blocked.length > 0}
                onClick={runZip}
                title={dependencyPlan.blocked.length > 0 ? "Resolve blocking dependencies first" : undefined}
              >
                {busy ? (
                  <span className="cds-spinner" style={{ width: 14, height: 14 }} />
                ) : (
                  <Icon name="upload" size={14} />
                )}
                Publish v{ver}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="up__body">
              <div className="up__rail">
                <div className="up__raillabel">How</div>
                {UP_METHODS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={"method" + (method === m.id ? " is-sel" : "")}
                    onClick={() => setMethod(m.id)}
                    aria-pressed={method === m.id}
                  >
                    <span className="method__ico">
                      <Icon name={m.id === "create" && isUpdate ? "file-pen-line" : m.icon} size={15} />
                    </span>
                    <span className="method__txt">
                      <span className="method__name">
                        {m.id === "create" && isUpdate ? "Edit in the browser" : m.name}
                        {"tag" in m && m.tag && <span className="tag">{m.tag}</span>}
                      </span>
                      <span className="method__desc">
                        {m.id === "create" && isUpdate
                          ? "Edit the SKILL.md and publish a new version."
                          : m.desc}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="up__panel">
                {method === "prompt" && (
                  <PromptPanel
                    labels={labels}
                    setLabels={setLabels}
                    allLabels={allLabels}
                    token={token}
                    ensure={ensureToken}
                    regen={regenToken}
                    isUpdate={isUpdate}
                    target={
                      isUpdate
                        ? {
                            slug: skill!.id,
                            skillId: skill!.uuid,
                            currentVersion: skill!.version,
                            nextVersion: ver,
                          }
                        : undefined
                    }
                  />
                )}
                {method === "zip" && (
                  <ZipPanel
                    labels={labels}
                    setLabels={setLabels}
                    allLabels={allLabels}
                    file={file}
                    setFile={setFile}
                    isUpdate={isUpdate}
                    validation={validation}
                    validating={validating}
                    validationError={validationError}
                  />
                )}
                {method === "create" && (
                  <CreatePanel
                    labels={labels}
                    setLabels={setLabels}
                    allLabels={allLabels}
                    form={form}
                    setForm={setForm}
                    locked={isUpdate}
                  />
                )}
                {error && (
                  <div className="up-errblock" role="alert" style={{ marginTop: 14 }}>
                    {error}
                  </div>
                )}
              </div>
            </div>
            <div className="up__foot">
              <span className="up__foothint">
                <Icon name={foot.hint[0]} size={14} />
                {foot.hint[1]}
              </span>
              <span className="up__footspacer" />
              <button className="btn-ghost" type="button" onClick={onClose}>
                Cancel
              </button>
              {foot.cta && (
                <button
                  className="btn-primary"
                  type="button"
                  disabled={foot.cta.disabled}
                  onClick={foot.cta.run}
                >
                  {busy ? (
                    <span className="cds-spinner" style={{ width: 14, height: 14 }} />
                  ) : (
                    <Icon name={foot.cta.icon} size={14} />
                  )}
                  {foot.cta.label}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- install dialog */

const INSTALL_METHODS = [
  {
    id: "prompt",
    icon: "sparkles",
    name: "Assistant IA",
    tag: "AI",
    desc: "Paste into an agent. It downloads and installs the skill for you.",
  },
  {
    id: "manual",
    icon: "file-archive",
    name: "Download package",
    desc: "Download the package and place it in your skills folder.",
  },
] as const;
type InstallMethod = (typeof INSTALL_METHODS)[number]["id"];

function TargetSeg({ value, onChange }: { value: TargetId; onChange: (t: TargetId) => void }) {
  return (
    <div className="up-seg" role="radiogroup" aria-label="Install location">
      {UP_TARGETS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={value === t.id}
          className={value === t.id ? "is-on" : ""}
          onClick={() => onChange(t.id)}
        >
          <Icon name={t.icon} size={12} />
          {t.name}
        </button>
      ))}
    </div>
  );
}

function InstallDone({ result }: { result: { id: string; version: string; target: TargetId; path: string; via: string } }) {
  return (
    <div className="up-done">
      <span className="up-done__badge">
        <Icon name="check" size={26} />
      </span>
      <h3 className="up-done__title">Package downloaded</h3>
      <p className="up-done__sub">
        {result.via}. Extract it into {targetName(result.target)} to finish installing.
      </p>
      <div className="up-done__card">
        <div className="up-done__row">
          <span className="up-done__k">Skill</span>
          <span className="up-done__v">
            <Icon name="package" size={13} />
            {result.id}
          </span>
        </div>
        <div className="up-done__row">
          <span className="up-done__k">Version</span>
          <span className="up-done__v">{result.version}</span>
        </div>
        <div className="up-done__row">
          <span className="up-done__k">Location</span>
          <span
            className="up-done__v"
            style={{ flexWrap: "wrap", justifyContent: "flex-end", textAlign: "right" } as CSSProperties}
          >
            {result.path}
          </span>
        </div>
      </div>
    </div>
  );
}

export function InstallDialog({ skill, onClose }: { skill: SkillVM; onClose: () => void }) {
  const id = skill.id;
  const version = skill.version ?? "latest";
  const [method, setMethod] = useState<InstallMethod>("prompt");
  const [token, setToken] = useState<string | null>(null);
  const [target, setTarget] = useState<TargetId>("claude");
  const [result, setResult] = useState<{
    id: string;
    version: string;
    target: TargetId;
    path: string;
    via: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deps, setDeps] = useState<SkillDependenciesResponse | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Resolve the dependency set this skill brings with it (installed together on the next reconcile).
  useEffect(() => {
    let active = true;
    fetchSkillDependencies(id, skill.version)
      .then((d) => {
        if (active) setDeps(d);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id, skill.version]);
  const installSet = (deps?.requires ?? []).filter((r) => r.status !== "missing");

  // skills:read covers both downloading the package and confirming the install back to Companion
  // (recording your own install is personal state, so it needs no write authority).
  const ensureToken = useCallback(async () => {
    if (token) return token;
    const issued = await issueToken(["skills:read"]);
    setToken(issued.token);
    return issued.token;
  }, [token]);
  const regenToken = useCallback(async () => {
    const issued = await issueToken(["skills:read"]);
    setToken(issued.token);
    return issued.token;
  }, []);

  useModalA11y(dialogRef, onClose);

  const path = targetPath(target, id);
  const base = apiBase();
  const buildPrompt = (tok: string) =>
    `You are installing the Companion skill ${id}.

Version: ${version}
Package URL: ${base}/skills/${id}/versions/${version}/package
Authorization header: Bearer ${tok}

Choose the right local skills folder for the user's agent, download the package, extract it there, and confirm SKILL.md sits at the package root. Report the installed location when done.

When the skill is installed, confirm it to Companion so it shows as installed in the workspace: send POST ${base}/skills/${id}/install with header "Authorization: Bearer ${tok}" and JSON body {"version":"${version}","agent":"<the agent you are>","source":"agent"}.`;
  const displayPrompt = buildPrompt(token ?? "cmp_pat_…");

  const download = async () => {
    if (!skill.version) return;
    setError(null);
    try {
      const res = await fetch(versionPackageUrl(id, skill.version));
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${id}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setResult({ id, version, target, path, via: "Downloaded the package" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    }
  };

  type Foot = {
    hint: [string, string];
    cta?: { label: string; icon: string; run: () => void; disabled?: boolean };
  };
  const FOOT: Record<InstallMethod, Foot> = {
    prompt: { hint: ["info", "The agent downloads the skill and installs it wherever it keeps skills."] },
    manual: {
      hint: skill.version ? ["folder", "Download the package, then extract it into " + path + "."] : ["info", "No published version to download yet."],
      cta: { label: "Download .zip", icon: "download", run: download, disabled: !skill.version },
    },
  };
  const foot = FOOT[method];

  return (
    <div
      className="up-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="up" role="dialog" aria-modal="true" aria-label="Install skill" ref={dialogRef} tabIndex={-1}>
        <div className="up__head">
          <div className="up__titles">
            <h2 className="up__title">
              {result ? (
                "Done"
              ) : (
                <>
                  Install <span className="mono" style={{ fontWeight: 600 }}>{id}</span>
                </>
              )}
            </h2>
            <p className="up__sub">
              {result ? (
                "The package is on your machine."
              ) : (
                <>
                  Install <span className="mono">{id}@{version}</span> on your machine, Claude Code, or
                  Codex.
                </>
              )}
            </p>
          </div>
          <button className="up__x" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" size={17} />
          </button>
        </div>

        {result ? (
          <>
            <div className="up__panel" role="status" aria-live="polite">
              <InstallDone result={result} />
            </div>
            <div className="up__foot">
              <span className="up__footspacer" />
              <button className="btn-primary" type="button" onClick={onClose}>
                <Icon name="arrow-right" size={14} />
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="up__body">
              <div className="up__rail">
                <div className="up__raillabel">How</div>
                {INSTALL_METHODS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={"method" + (method === m.id ? " is-sel" : "")}
                    onClick={() => setMethod(m.id)}
                    aria-pressed={method === m.id}
                  >
                    <span className="method__ico">
                      <Icon name={m.icon} size={15} />
                    </span>
                    <span className="method__txt">
                      <span className="method__name">
                        {m.name}
                        {"tag" in m && m.tag && <span className="tag">{m.tag}</span>}
                      </span>
                      <span className="method__desc">{m.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="up__panel">
                {installSet.length > 0 && (
                  <div className="up-step">
                    <div className="up-fieldlabel">Resolved install set</div>
                    <p className="up-panel__lede" style={{ marginTop: 4 }}>
                      This skill brings <b>{installSet.length}</b>{" "}
                      {installSet.length === 1 ? "dependency" : "dependencies"} with it. They resolve and install
                      together on the agent&apos;s next reconcile.
                    </p>
                    <div className="dptable" style={{ marginTop: 8 }}>
                      <div className="pf-item">
                        <span className="pf-item__mark pf-item__mark--ok">
                          <Icon name="package" size={15} />
                        </span>
                        <span className="pf-item__slug" style={{ color: "var(--color-fg)", fontWeight: 600 }}>
                          {id}
                        </span>
                        <span className="pf-item__cons">v{skill.version ?? "—"}</span>
                        <span className="pf-item__tag pf-item__tag--ok">root</span>
                      </div>
                      {installSet.map((d) => (
                        <div className="pf-item" key={d.slug}>
                          <span className="pf-item__mark pf-item__mark--ok">
                            <Icon name="corner-down-right" size={15} />
                          </span>
                          <span className="pf-item__slug">{d.slug}</span>
                          <span className="pf-item__tag pf-item__tag--ok">
                            {d.status === "satisfied" ? "resolved" : d.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {method === "prompt" && (
                  <>
                    <p className="up-panel__lede">
                      Paste this into an agent that can work with local files. It downloads{" "}
                      <span className="inline-code">{id}</span> and installs it in the right skills folder.
                    </p>
                    <div className="up-step">
                      <StepLabel n="1">Access token</StepLabel>
                      <TokenRow
                        token={token}
                        ensure={ensureToken}
                        regen={regenToken}
                        hint={
                          <>
                            Scoped to <b>skills:read</b>, expires in 90 days.
                          </>
                        }
                      />
                    </div>
                    <div className="up-step">
                      <StepLabel n="2">Prompt</StepLabel>
                      <CodeBlock
                        text={displayPrompt}
                        scroll
                        copyLabel="Copy prompt"
                        resolveText={async () => buildPrompt(await ensureToken())}
                      />
                    </div>
                  </>
                )}
                {method === "manual" && (
                  <>
                    <p className="up-panel__lede">
                      Download the packaged skill and extract it into the selected skills folder.
                    </p>
                    <div className="up-step">
                      <StepLabel n="1">Install location</StepLabel>
                      <TargetSeg value={target} onChange={setTarget} />
                    </div>
                    <div className="up-step">
                      <StepLabel n="2">Package</StepLabel>
                      <p className="up-seg-note">
                        Download the package, extract it into <span className="mono">{path}</span>, then confirm{" "}
                        <span className="mono">{path}/SKILL.md</span> exists.
                      </p>
                    </div>
                  </>
                )}
                {error && (
                  <div className="up-errblock" role="alert" style={{ marginTop: 14 }}>
                    {error}
                  </div>
                )}
              </div>
            </div>
            <div className="up__foot">
              <span className="up__foothint">
                <Icon name={foot.hint[0]} size={14} />
                {foot.hint[1]}
              </span>
              <span className="up__footspacer" />
              <button className="btn-ghost" type="button" onClick={onClose}>
                Cancel
              </button>
              {foot.cta && (
                <button
                  className="btn-primary"
                  type="button"
                  onClick={foot.cta.run}
                  disabled={foot.cta.disabled}
                >
                  <Icon name={foot.cta.icon} size={14} />
                  {foot.cta.label}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
