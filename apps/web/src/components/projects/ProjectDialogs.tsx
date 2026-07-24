"use client";

import {
  PROJECT_ATTACHMENT_MAX_BYTES,
  PROJECT_ATTACHMENT_MAX_FILES,
} from "@companion/contracts";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  ProjectDetailVM,
  ProjectModelChoice,
  ProjectSkillChoice,
} from "@/lib/projectsModel";
import { Icon } from "../Icon";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function CoworkDialog({
  title,
  description,
  onClose,
  children,
  width = "600px",
  dismissible = true,
}: {
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  dismissible?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    setPortalHost(document.body);
  }, []);

  useEffect(() => {
    if (!portalHost) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const background = [...document.body.children]
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement &&
          !element.classList.contains("cowork-dialog-layer"),
      )
      .map((element) => ({
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute("aria-hidden"),
      }));
    for (const item of background) {
      item.element.inert = true;
      item.element.setAttribute("aria-hidden", "true");
    }
    const dialog = dialogRef.current;
    const initial =
      dialog?.querySelector<HTMLElement>("[data-autofocus]") ??
      dialog?.querySelector<HTMLElement>(FOCUSABLE);
    queueMicrotask(() => initial?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (dismissibleRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (item) => !item.hasAttribute("disabled"),
      );
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      for (const item of background) {
        item.element.inert = item.inert;
        if (item.ariaHidden === null)
          item.element.removeAttribute("aria-hidden");
        else item.element.setAttribute("aria-hidden", item.ariaHidden);
      }
      window.requestAnimationFrame(() => previous?.focus());
    };
  }, [portalHost]);

  if (!portalHost) return null;

  return createPortal(
    <div
      className="cowork-dialog-layer"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="cowork-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        style={{ "--cowork-dialog-width": width } as React.CSSProperties}
      >
        <header className="cowork-dialog__head">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>{description}</p>
          </div>
          <button
            type="button"
            className="cds-iconbtn cds-iconbtn--md"
            disabled={!dismissible}
            onClick={onClose}
            aria-label="Close dialog"
          >
            <Icon name="x" size={15} />
          </button>
        </header>
        {children}
      </div>
    </div>,
    portalHost,
  );
}

type SkillPickerChoice = ProjectSkillChoice & {
  unavailable?: boolean;
};

function SkillPicker({
  skills,
  selected,
  onToggle,
  disabled = false,
}: {
  skills: SkillPickerChoice[];
  selected: Set<string>;
  onToggle: (slug: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = skills.filter((skill) =>
    `${skill.name} ${skill.slug} ${skill.summary}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <div className="cowork-skill-picker">
      <label className="cowork-skill-picker__search">
        <Icon name="search" size={13} />
        <span className="sr-only">Search skills</span>
        <input
          value={query}
          placeholder="Search skills"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="cowork-skill-picker__list">
        {filtered.map((skill) => {
          const checked = selected.has(skill.slug);
          const cannotSelect = Boolean(skill.unavailable && !checked);
          return (
            <button
              type="button"
              key={skill.slug}
              className="cowork-skill-option"
              aria-pressed={checked}
              disabled={disabled || cannotSelect}
              onClick={() => onToggle(skill.slug)}
            >
              <span
                className={`cowork-skill-option__check${checked ? " is-on" : ""}`}
              >
                {checked && <Icon name="check" size={12} />}
              </span>
              <span className="cowork-skill-option__copy">
                <strong>{skill.name}</strong>
                <small>
                  {skill.source}
                  {skill.version ? ` · ${skill.version}` : ""}
                </small>
              </span>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="cowork-skill-picker__empty">
            <Icon name="search-x" size={16} />
            {skills.length === 0
              ? "No usable skills yet."
              : "No matching skills."}
          </div>
        )}
      </div>
    </div>
  );
}

function ModelField({
  models,
  value,
  onChange,
  disabled = false,
}: {
  models: ProjectModelChoice[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="cds-field">
      <span className="cds-field__label">Default model</span>
      <select
        className="cds-field__control cowork-model-control"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || models.length === 0}
      >
        {value && !models.some((model) => model.id === value) && (
          <option value={value}>{value} · unavailable</option>
        )}
        {models.length === 0 ? (
          value ? null : (
            <option value="">No connected model</option>
          )
        ) : (
          models.map((model) => (
            <option value={model.id} key={model.id}>
              {model.id}
            </option>
          ))
        )}
      </select>
      <span className="cds-field__hint">
        Sessions start with this model. You can override it per session.
      </span>
    </label>
  );
}

function CatalogWarning({
  message,
  onRetry,
}: {
  message?: string | null;
  onRetry?: () => void;
}) {
  if (!message) return null;
  return (
    <div className="cowork-catalog-warning" role="alert">
      <Icon name="alert-triangle" size={14} />
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

function SecretSummary() {
  return (
    <div className="cowork-secret-summary">
      <span className="project-status-dot is-done" aria-hidden="true" />
      <span>
        Eligible secrets are checked and synced automatically at activation.
      </span>
    </div>
  );
}

export function NewProjectDialog({
  skills,
  models,
  initialSkillSlug,
  busy,
  error,
  catalogError,
  onClose,
  onCreate,
  onRetryCatalog,
}: {
  skills: ProjectSkillChoice[];
  models: ProjectModelChoice[];
  initialSkillSlug?: string | null;
  busy: boolean;
  error: string | null;
  catalogError?: string | null;
  onClose: () => void;
  onCreate: (input: {
    name: string;
    defaultModel: string;
    skillSlugs: string[];
    idempotencyKey: string;
  }) => void;
  onRetryCatalog?: () => void;
}) {
  const [name, setName] = useState("");
  const [model, setModel] = useState(models[0]?.id ?? "");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSkillSlug ? [initialSkillSlug] : []),
  );
  const idempotencyKeyRef = useRef<string | null>(null);
  const valid = name.trim().length > 0 && model.length > 0 && !busy;
  return (
    <CoworkDialog
      title="New project"
      description="A persistent space where sessions share files, skills and secrets."
      onClose={onClose}
    >
      <div className="cowork-dialog__body">
        <label className="cds-field">
          <span className="cds-field__label">Name</span>
          <input
            data-autofocus
            className="cds-field__control"
            value={name}
            maxLength={120}
            placeholder="e.g. Q4 planning"
            disabled={busy}
            onChange={(event) => {
              idempotencyKeyRef.current = null;
              setName(event.target.value);
            }}
          />
        </label>
        <ModelField
          models={models}
          value={model}
          onChange={(next) => {
            idempotencyKeyRef.current = null;
            setModel(next);
          }}
          disabled={busy}
        />
        <div className="cds-field">
          <span className="cds-field__label">Skills to sync</span>
          <SkillPicker
            skills={skills}
            selected={selected}
            disabled={busy}
            onToggle={(slug) => {
              idempotencyKeyRef.current = null;
              setSelected((current) => {
                const next = new Set(current);
                if (next.has(slug)) next.delete(slug);
                else next.add(slug);
                return next;
              });
            }}
          />
          <span className="cds-field__hint">
            Synced from the library. New versions apply automatically between
            turns.
          </span>
        </div>
        <SecretSummary />
        <CatalogWarning message={catalogError} onRetry={onRetryCatalog} />
        {models.length === 0 && (
          <p className="cowork-inline-warning" role="status">
            <Icon name="alert-triangle" size={14} />
            Connect and activate a model in Settings before creating a project.
          </p>
        )}
        {error && (
          <p className="project-inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="cowork-dialog__foot">
        <button
          type="button"
          className="cds-btn cds-btn--secondary cds-btn--md"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="cds-btn cds-btn--primary cds-btn--md"
          disabled={!valid}
          onClick={() => {
            idempotencyKeyRef.current ??= crypto.randomUUID();
            onCreate({
              name: name.trim(),
              defaultModel: model,
              skillSlugs: [...selected],
              idempotencyKey: idempotencyKeyRef.current,
            });
          }}
        >
          {busy && <Icon name="loader" size={14} className="ls-spin" />}
          {busy ? "Creating…" : "Create project"}
        </button>
      </footer>
    </CoworkDialog>
  );
}

function DraftFiles({
  files,
  onFiles,
  onRemove,
  disabled = false,
}: {
  files: File[];
  onFiles: (files: FileList) => void;
  onRemove: (index: number) => void;
  disabled?: boolean;
}) {
  return (
    <>
      {files.length > 0 && (
        <div className="cowork-draft-files" aria-label="Attachments">
          {files.map((file, index) => (
            <span
              className="cowork-file-chip"
              key={`${file.name}:${file.lastModified}:${index}`}
            >
              <Icon name="file" size={12} />
              <span title={file.name}>{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                disabled={disabled}
                onClick={() => onRemove(index)}
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <label
        className={`cds-btn cds-btn--ghost cds-btn--sm cowork-attach${disabled ? " is-disabled" : ""}`}
        aria-disabled={disabled}
      >
        <Icon name="paperclip" size={13} />
        Attach
        <input
          type="file"
          multiple
          disabled={disabled}
          onChange={(event) => {
            if (event.target.files) onFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </label>
    </>
  );
}

export function NewSessionDialog({
  project,
  models,
  initialSkillSlug,
  busy,
  error,
  catalogError,
  onClose,
  onStart,
  onRetryCatalog,
}: {
  project: ProjectDetailVM;
  models: ProjectModelChoice[];
  initialSkillSlug?: string | null;
  busy: boolean;
  error: string | null;
  catalogError?: string | null;
  onClose: () => void;
  onStart: (input: {
    prompt: string;
    model: string;
    files: File[];
    idempotencyKey: string;
  }) => void;
  onRetryCatalog?: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(project.defaultModel);
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const initialSkill = project.skills.find(
    (skill) => skill.slug === initialSkillSlug,
  );
  const modelAvailable = models.some((choice) => choice.id === model);
  const valid = prompt.trim().length > 0 && modelAvailable && !busy;
  const start = () => {
    if (!valid) return;
    idempotencyKeyRef.current ??= crypto.randomUUID();
    onStart({
      prompt: prompt.trim(),
      model,
      files,
      idempotencyKey: idempotencyKeyRef.current,
    });
  };
  return (
    <CoworkDialog
      title="New session"
      description={`In ${project.name}. Its files, skills and secrets are ready.`}
      onClose={onClose}
      width="640px"
    >
      <div className="cowork-session-compose">
        {initialSkill && (
          <div className="cowork-session-skill">
            <Icon name="package" size={13} />
            Using {initialSkill.displayName}
          </div>
        )}
        <textarea
          data-autofocus
          rows={4}
          value={prompt}
          disabled={busy}
          placeholder={
            initialSkill
              ? `What should ${initialSkill.displayName} do?`
              : "Describe what you want done…"
          }
          onChange={(event) => {
            idempotencyKeyRef.current = null;
            setPrompt(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key === "Enter" &&
              valid
            ) {
              event.preventDefault();
              start();
            }
          }}
        />
        <DraftFiles
          files={files}
          disabled={busy}
          onFiles={(incoming) => {
            const next = Array.from(incoming);
            if (next.some((file) => file.size > PROJECT_ATTACHMENT_MAX_BYTES)) {
              setFileError("Each attachment must be 10 MB or smaller.");
              return;
            }
            if (files.length + next.length > PROJECT_ATTACHMENT_MAX_FILES) {
              setFileError(
                `Attach up to ${PROJECT_ATTACHMENT_MAX_FILES} files.`,
              );
              return;
            }
            setFileError(null);
            idempotencyKeyRef.current = null;
            setFiles((current) => [...current, ...next]);
          }}
          onRemove={(index) => {
            setFileError(null);
            idempotencyKeyRef.current = null;
            setFiles((current) =>
              current.filter((_, candidate) => candidate !== index),
            );
          }}
        />
        <div className="cowork-session-compose__foot">
          <select
            className="cds-field__control cowork-session-model"
            value={model}
            disabled={busy || models.length === 0}
            onChange={(event) => {
              idempotencyKeyRef.current = null;
              setModel(event.target.value);
            }}
            aria-label="Model"
          >
            {!models.some((choice) => choice.id === model) && (
              <option value={model}>{model} · unavailable</option>
            )}
            {models.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.id}
              </option>
            ))}
          </select>
          <span className="cowork-session-compose__spacer" />
          <button
            type="button"
            className="cds-btn cds-btn--ghost cds-btn--sm"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cds-btn cds-btn--primary cds-btn--sm"
            disabled={!valid}
            onClick={start}
          >
            {busy ? (
              <Icon name="loader" size={13} className="ls-spin" />
            ) : (
              <Icon name="zap" size={13} />
            )}
            {busy ? "Starting…" : "Start"}
          </button>
        </div>
        {!modelAvailable && (
          <p className="cowork-inline-warning" role="status">
            <Icon name="alert-triangle" size={14} />
            This model is unavailable. Choose a connected model before starting.
          </p>
        )}
        <CatalogWarning message={catalogError} onRetry={onRetryCatalog} />
        {fileError && (
          <p className="project-inline-error" role="alert">
            {fileError}
          </p>
        )}
        {error && (
          <p className="project-inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </CoworkDialog>
  );
}

export function ProjectSettingsDialog({
  project,
  skills,
  models,
  busy,
  error,
  catalogError,
  onClose,
  onSave,
  onDelete,
  onRetryCatalog,
}: {
  project: ProjectDetailVM;
  skills: ProjectSkillChoice[];
  models: ProjectModelChoice[];
  busy: boolean;
  error: string | null;
  catalogError?: string | null;
  onClose: () => void;
  onSave: (input: {
    name: string;
    defaultModel: string;
    skillSlugs: string[];
  }) => void;
  onDelete: () => void;
  onRetryCatalog?: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [model, setModel] = useState(project.defaultModel);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(project.skills.map((skill) => skill.slug)),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const skillChoices = useMemo<SkillPickerChoice[]>(() => {
    const available = new Set(skills.map((skill) => skill.slug));
    return [
      ...skills,
      ...project.skills
        .filter((skill) => !available.has(skill.slug))
        .map((skill) => ({
          slug: skill.slug,
          name: skill.displayName,
          summary: skill.summary,
          source: skill.archived
            ? "Attached · archived"
            : "Attached · unavailable",
          version: skill.version,
          unavailable: true,
        })),
    ];
  }, [project.skills, skills]);
  return (
    <CoworkDialog
      title="Project settings"
      description="Configure the persistent space and what every session can use."
      onClose={onClose}
    >
      <div className="cowork-dialog__body">
        <label className="cds-field">
          <span className="cds-field__label">Name</span>
          <input
            data-autofocus
            className="cds-field__control"
            value={name}
            maxLength={120}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <ModelField
          models={models}
          value={model}
          onChange={setModel}
          disabled={busy}
        />
        <div className="cds-field">
          <span className="cds-field__label">Skills in this project</span>
          <SkillPicker
            skills={skillChoices}
            selected={selected}
            disabled={busy}
            onToggle={(slug) =>
              setSelected((current) => {
                const next = new Set(current);
                if (next.has(slug)) next.delete(slug);
                else next.add(slug);
                return next;
              })
            }
          />
          <span className="cds-field__hint">
            Changes are applied atomically between agent turns.
          </span>
        </div>
        <SecretSummary />
        <CatalogWarning message={catalogError} onRetry={onRetryCatalog} />
        {error && (
          <p className="project-inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="cowork-dialog__foot">
        <button
          type="button"
          className={`cds-btn cds-btn--md ${confirmDelete ? "cds-btn--danger" : "cds-btn--ghost"}`}
          onClick={() => {
            if (confirmDelete) onDelete();
            else setConfirmDelete(true);
          }}
          disabled={busy}
        >
          {confirmDelete ? "Confirm delete" : "Delete project"}
        </button>
        <span className="cowork-dialog__spacer" />
        <button
          type="button"
          className="cds-btn cds-btn--secondary cds-btn--md"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="cds-btn cds-btn--primary cds-btn--md"
          disabled={busy || !name.trim() || !model}
          onClick={() =>
            onSave({
              name: name.trim(),
              defaultModel: model,
              skillSlugs: [...selected],
            })
          }
        >
          {busy && <Icon name="loader" size={14} className="ls-spin" />}
          {busy ? "Saving…" : "Save changes"}
        </button>
      </footer>
    </CoworkDialog>
  );
}

export { CoworkDialog };
