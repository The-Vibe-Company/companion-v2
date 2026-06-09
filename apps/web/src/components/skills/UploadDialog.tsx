"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { SkillVisibilityInput } from "@companion/contracts";
import type { SkillVM, TeamVM } from "@/lib/types";
import {
  apiBase,
  createSkillInline,
  issueToken,
  publishSkillPackage,
  versionPackageUrl,
} from "@/lib/queries";
import { Icon } from "../Icon";

/* ------------------------------------------------------------------ helpers */

/** Visibility is applied on the upload request, never written into SKILL.md. */
function visQuery(visibility: SkillVisibilityInput): string {
  const qs = new URLSearchParams();
  if (visibility.everyone) qs.set("everyone", "true");
  for (const team of visibility.teams) qs.append("team", team);
  return qs.toString() || "everyone=false";
}
function visFlags(visibility: SkillVisibilityInput): string {
  const parts = [];
  if (visibility.everyone) parts.push("--everyone");
  for (const team of visibility.teams) parts.push(`--team ${team}`);
  return parts.join(" ") || "--private";
}
function visibilityLabel(visibility: SkillVisibilityInput, teams: TeamVM[]): string {
  const names = visibility.teams.map((slug) => teams.find((team) => team.id === slug)?.name ?? slug);
  if (visibility.everyone && names.length) return `Everyone + ${names.length} team${names.length === 1 ? "" : "s"}`;
  if (visibility.everyone) return "Everyone";
  if (names.length === 1) return names[0]!;
  if (names.length > 1) return `${names.length} teams`;
  return "Private";
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
function CodeBlock({
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

function TeamMultiSelect({
  teams,
  value,
  onChange,
}: {
  teams: TeamVM[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const selected = new Set(value);
  const label = value.length === 0 ? "No teams" : value.length === 1 ? teams.find((t) => t.id === value[0])?.name ?? value[0] : `${value.length} teams`;
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <span className="up-teamsel" ref={ref}>
      <button
        className="up-teamsel__btn"
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="up-teamav">{value.length || "0"}</span>
        <span className="up-teamsel__name">{label}</span>
        <Icon name="chevron-down" size={13} style={{ color: "var(--color-faint)" }} />
      </button>
      {open && (
        <div className="up-teamsel__menu" role="menu">
          <div className="up-teamsel__head">Share with teams</div>
          {teams.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={selected.has(t.id)}
              className={"up-teamsel__item" + (selected.has(t.id) ? " is-sel" : "")}
              onClick={() => {
                const next = new Set(selected);
                if (next.has(t.id)) next.delete(t.id);
                else next.add(t.id);
                onChange([...next]);
              }}
            >
              <span className="up-teamav">{t.initial}</span>
              <span className="up-teamsel__iname">{t.name}</span>
              {selected.has(t.id) && (
                <Icon name="check" size={14} style={{ marginLeft: "auto", color: "var(--color-fg)" }} />
              )}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Shared visibility selector: workspace-wide toggle plus team shares. */
function VisibilityPicker({
  value,
  onChange,
  teams,
}: {
  value: SkillVisibilityInput;
  onChange: (visibility: SkillVisibilityInput) => void;
  teams: TeamVM[];
}) {
  return (
    <div className="up-vis">
      <div className="up-seg" role="group" aria-label="Visibility">
        <button
          type="button"
          aria-pressed={!value.everyone && value.teams.length === 0}
          className={!value.everyone && value.teams.length === 0 ? "is-on" : ""}
          onClick={() => onChange({ everyone: false, teams: [] })}
        >
          <Icon name="lock" size={12} />
          Private
        </button>
        <button
          type="button"
          aria-pressed={value.everyone}
          className={value.everyone ? "is-on" : ""}
          onClick={() => onChange({ ...value, everyone: !value.everyone })}
        >
          <Icon name="building-2" size={12} />
          Everyone
        </button>
      </div>
      {teams.length > 0 && (
        <TeamMultiSelect teams={teams} value={value.teams} onChange={(teamIds) => onChange({ ...value, teams: teamIds })} />
      )}
    </div>
  );
}

function StepLabel({ n, children }: { n?: string; children: React.ReactNode }) {
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
function useModalA11y(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    (el?.querySelector<HTMLElement>(FOCUSABLE) ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
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
function TokenRow({
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
    name: "Guided prompt",
    tag: "AI",
    desc: "Hand a prompt and a token to an agent. It packages and uploads over the API.",
  },
  { id: "cli", icon: "terminal", name: "Command line", desc: "Push from your machine with the companion CLI." },
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
  visibility,
  setVisibility,
  teams,
  token,
  ensure,
  regen,
}: {
  visibility: SkillVisibilityInput;
  setVisibility: (visibility: SkillVisibilityInput) => void;
  teams: TeamVM[];
  token: string | null;
  ensure: () => Promise<string>;
  regen: () => Promise<string>;
}) {
  const base = apiBase();
  const buildPrompt = (tok: string) =>
    `You are publishing a Companion skill. The package is in the current
working directory: a SKILL.md plus any files it references. SKILL.md
is a standard Agent Skill: YAML frontmatter with name and description.

1. Read SKILL.md and confirm the frontmatter has a name, a version
   (semver), and a description. Do not add visibility fields.
   The registry sets visibility on the upload request, not in the skill.
2. Zip the package from its root:
   zip -r skill.zip SKILL.md .
3. Publish it. Visibility is set with query parameters on the request:
   curl -X POST "${base}/skills?${visQuery(visibility)}" \\
     -H "Authorization: Bearer ${tok}" \\
     -H "Content-Type: application/zip" \\
     --data-binary @skill.zip
4. Report the skill id and version from the response, then remove
   skill.zip. If validation returns 422, fix the frontmatter it names
   and retry once.`;
  const displayPrompt = buildPrompt(token ?? "cmp_pat_…");
  return (
    <>
      <p className="up-panel__lede">
        Give an agent (Claude, Cursor, or any tool with shell access) everything it needs to publish on
        your behalf. The token below is scoped to <b>skills:write</b> and expires in 24 hours.
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
      <div className="up-step">
        <StepLabel n="2">Visibility</StepLabel>
        <VisibilityPicker value={visibility} onChange={setVisibility} teams={teams} />
        <p className="up-seg-note">
          Applied on the request as <span className="mono">?{visQuery(visibility)}</span>, not stored in
          the skill.
        </p>
      </div>
      <div className="up-step">
        <StepLabel n="3">Prompt</StepLabel>
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

function CliPanel({
  visibility,
  setVisibility,
  teams,
}: {
  visibility: SkillVisibilityInput;
  setVisibility: (visibility: SkillVisibilityInput) => void;
  teams: TeamVM[];
}) {
  const push = `companion skill push . ${visFlags(visibility)}`.trim();
  const setup = `# install once (macOS / Linux)
brew install the-vibe-company/tap/companion

# authenticate against this workspace
companion auth login

# from the skill's directory, publish it
companion skill push . ${visFlags(visibility)}`.trim();
  return (
    <>
      <p className="up-panel__lede">
        Push straight from the directory that holds your <span className="inline-code">SKILL.md</span>.
        Requires the companion CLI <span className="inline-code">v0.4+</span>, signed in to this workspace.
      </p>
      <div className="up-step">
        <StepLabel n="1">Visibility</StepLabel>
        <VisibilityPicker value={visibility} onChange={setVisibility} teams={teams} />
        <p className="up-seg-note">
          Sets <span className="mono">{visFlags(visibility)}</span> on the push. The skill itself carries no
          visibility fields.
        </p>
      </div>
      <div className="up-step">
        <StepLabel n="2">Publish</StepLabel>
        <CodeBlock text={push} copyLabel="Copy command" />
      </div>
      <div className="up-step">
        <StepLabel>First time? Full setup</StepLabel>
        <CodeBlock text={setup} copyLabel="Copy all" />
      </div>
    </>
  );
}

function ZipPanel({
  visibility,
  setVisibility,
  teams,
  file,
  setFile,
}: {
  visibility: SkillVisibilityInput;
  setVisibility: (visibility: SkillVisibilityInput) => void;
  teams: TeamVM[];
  file: File | null;
  setFile: (f: File | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <>
      <p className="up-panel__lede">
        Already have a packaged skill? Drop the <span className="inline-code">.zip</span> here. Companion
        checks the frontmatter and rejects archives with symlinks that escape the package root.
      </p>
      <div className="up-step">
        {!file ? (
          <div
            className={"up-drop" + (over ? " is-over" : "")}
            onClick={() => inputRef.current?.click()}
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
            <div className="up-drop__main">
              <b>Click to browse</b> or drag a package here
            </div>
            <div className="up-drop__sub">.zip · SKILL.md at root · up to 25 MB</div>
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
          </div>
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
          <p className="up-check" style={{ marginTop: 4 }}>
            <Icon name="shield-check" size={14} />
            Frontmatter and archive will be validated on upload.
          </p>
        )}
      </div>
      <div className="up-step">
        <StepLabel n="1">Visibility</StepLabel>
        <VisibilityPicker value={visibility} onChange={setVisibility} teams={teams} />
        <p className="up-seg-note">Set on upload. Companion does not read visibility from the package.</p>
      </div>
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
  visibility,
  setVisibility,
  teams,
  form,
  setForm,
  locked,
}: {
  visibility: SkillVisibilityInput;
  setVisibility: (visibility: SkillVisibilityInput) => void;
  teams: TeamVM[];
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
            <label className="up-field__label">Visibility</label>
            <VisibilityPicker
              value={visibility}
              onChange={setVisibility}
              teams={teams}
            />
            <span className="up-field__hint">{visibilityLabel(visibility, teams)}.</span>
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
              : "Companion writes the standard frontmatter for you. Visibility is applied on publish, never stored in the skill."}
          </span>
        </div>
      </div>
    </>
  );
}

interface PublishOutcome {
  id: string;
  version: string;
  visibility: SkillVisibilityInput;
  via: string;
}

function DonePanel({ result, update, teams }: { result: PublishOutcome; update: boolean; teams: TeamVM[] }) {
  const visLabel = visibilityLabel(result.visibility, teams);
  return (
    <div className="up-done">
      <span className="up-done__badge">
        <Icon name="check" size={26} />
      </span>
      <h3 className="up-done__title">{update ? "Update published" : "Skill published"}</h3>
      <p className="up-done__sub">{result.via}. Run plan &amp; apply to deploy it to your agents.</p>
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
          <span className="up-done__k">Visibility</span>
          <span className="up-done__v">
            <Icon name={result.visibility.everyone ? "building-2" : result.visibility.teams.length ? "users" : "lock"} size={13} />
            {visLabel}
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

export function UploadDialog({
  mode = "create",
  skill = null,
  teams,
  onClose,
  onPublished,
}: {
  mode?: "create" | "update";
  skill?: SkillVM | null;
  teams: TeamVM[];
  onClose: () => void;
  onPublished: () => void;
}) {
  const isUpdate = mode === "update" && !!skill;
  const [method, setMethod] = useState<UploadMethod>("prompt");
  const [visibility, setVisibility] = useState<SkillVisibilityInput>(
    isUpdate
      ? { everyone: skill!.visibility.everyone, teams: skill!.teamSlugs }
      : { everyone: false, teams: [] },
  );
  const [token, setToken] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
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
  const canZip = !!file;
  const canCreate = !!(form.id.trim() && form.description.trim() && form.body.trim());

  const finishPublish = (outcome: PublishOutcome) => {
    setResult(outcome);
    onPublished();
  };

  const runZip = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await publishSkillPackage(file, {
        visibility,
        version: isUpdate ? ver : undefined,
        expectSlug: isUpdate ? skill!.id : undefined,
      });
      finishPublish({
        id: res.slug || idFromZip,
        version: res.version,
        visibility,
        via: isUpdate ? "Updated from zip" : "Uploaded from zip",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
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
        visibility,
      });
      finishPublish({
        id: res.slug || id,
        version: res.version,
        visibility,
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
    setError(null);
    if (!isUpdate) setForm(() => ({ id: "", description: "", body: CREATE_BODY_TEMPLATE }));
  };

  type Foot = {
    hint: [string, string];
    cta?: { label: string; icon: string; disabled: boolean; run: () => void };
  };
  const FOOT: Record<UploadMethod, Foot> = {
    prompt: { hint: ["info", "The agent uploads over the API. Companion validates the package server-side."] },
    cli: { hint: ["info", "Companion validates the package server-side after the push."] },
    zip: {
      hint: ["file-archive", "The package must contain SKILL.md at its root."],
      cta: {
        label: isUpdate ? "Publish update" : "Upload package",
        icon: "upload",
        disabled: !canZip || busy,
        run: runZip,
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
              <DonePanel result={result} update={isUpdate} teams={teams} />
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
                    visibility={visibility}
                    setVisibility={setVisibility}
                    teams={teams}
                    token={token}
                    ensure={ensureToken}
                    regen={regenToken}
                  />
                )}
                {method === "cli" && (
                  <CliPanel visibility={visibility} setVisibility={setVisibility} teams={teams} />
                )}
                {method === "zip" && (
                  <ZipPanel
                    visibility={visibility}
                    setVisibility={setVisibility}
                    teams={teams}
                    file={file}
                    setFile={setFile}
                  />
                )}
                {method === "create" && (
                  <CreatePanel
                    visibility={visibility}
                    setVisibility={setVisibility}
                    teams={teams}
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
    name: "Guided prompt",
    tag: "AI",
    desc: "Paste into Claude Code or Codex. It downloads and installs the skill for you.",
  },
  { id: "cli", icon: "terminal", name: "Command line", desc: "Install into your skills directory with the companion CLI." },
  {
    id: "manual",
    icon: "file-archive",
    name: "Download package",
    desc: "Grab the .zip and unzip it into your skills directory.",
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
        {result.via}. Unzip it into {targetName(result.target)} to finish installing.
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
  const dialogRef = useRef<HTMLDivElement>(null);

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
    `You are installing the Companion skill ${id}. Decide where it should
live (for example ~/.claude/skills, a project .skills folder, or
wherever you keep skills) and install it there.

1. Download version ${version} of the package:
   curl -L "${base}/skills/${id}/versions/${version}/package" \\
     -H "Authorization: Bearer ${tok}" \\
     -o ${id}.zip
2. Unzip ${id}.zip into the skills directory you chose and confirm
   SKILL.md sits at the package root.
3. Remove ${id}.zip when done.`;
  const displayPrompt = buildPrompt(token ?? "cmp_pat_…");
  const cli = `companion skill install ${id}@${version}`;
  const unzip = `unzip ${id}.zip -d ${path}`;

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
    cli: { hint: ["info", "Pulls the package from the registry and installs it."] },
    manual: {
      hint: skill.version ? ["folder", "Unzip into " + path + "."] : ["info", "No published version to download yet."],
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
                {method === "prompt" && (
                  <>
                    <p className="up-panel__lede">
                      Paste this into Claude Code, Codex, or any coding agent with shell access. It downloads{" "}
                      <span className="inline-code">{id}</span> and installs it wherever it keeps skills.
                    </p>
                    <div className="up-step">
                      <StepLabel n="1">Access token</StepLabel>
                      <TokenRow
                        token={token}
                        ensure={ensureToken}
                        regen={regenToken}
                        hint={
                          <>
                            Scoped to <b>skills:read</b>, expires in 24 hours.
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
                {method === "cli" && (
                  <>
                    <p className="up-panel__lede">
                      Install the skill with the companion CLI. Requires{" "}
                      <span className="inline-code">v0.4+</span>, signed in to this workspace.
                    </p>
                    <div className="up-step">
                      <StepLabel n="1">Install</StepLabel>
                      <CodeBlock text={cli} copyLabel="Copy command" />
                    </div>
                  </>
                )}
                {method === "manual" && (
                  <>
                    <p className="up-panel__lede">
                      Download the packaged skill and unzip it into your skills directory yourself.
                    </p>
                    <div className="up-step">
                      <StepLabel n="1">Install location</StepLabel>
                      <TargetSeg value={target} onChange={setTarget} />
                    </div>
                    <div className="up-step">
                      <StepLabel n="2">Unzip</StepLabel>
                      <CodeBlock text={unzip} copyLabel="Copy command" />
                      <p className="up-seg-note">
                        Then confirm <span className="mono">{path}/SKILL.md</span> exists.
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
