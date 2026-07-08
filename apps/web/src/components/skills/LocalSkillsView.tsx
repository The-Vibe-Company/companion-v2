"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DeviceRow, LocalSkillRow, LocalSkillStatus, TokenScope } from "@companion/contracts";
import { TOKEN_SCOPES } from "@companion/contracts";
import { apiBase, fetchLocalSkills, issueToken } from "@/lib/queries";
import { REQUIRED_LOCAL_SKILL_KEY } from "@/lib/companionSkillGate";
import { Icon } from "../Icon";
import { CodeBlock, useModalA11y } from "./UploadDialog";
import { DevicesSection } from "./DevicesSection";

const STATUS_META: Record<LocalSkillStatus, { label: string; badge: string; action: string }> = {
  none: { label: "Not installed", badge: "ls-badge--neutral", action: "Install" },
  installed: { label: "Installed", badge: "ls-badge--ok", action: "Use" },
  update: { label: "Update available", badge: "ls-badge--warn", action: "Update" },
};

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff) || diff < 45_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** The single mono version line shown in the card footer, derived from install status. */
function versionLine(skill: LocalSkillRow): string {
  if (skill.status === "none") {
    return `Available ${skill.availableVersion} · Not installed on this machine`;
  }
  const installed = skill.installedVersion ?? "—";
  return `Installed ${installed} · Available ${skill.availableVersion} · Checked ${relativeTime(
    skill.lastReportedAt,
  )}`;
}

function promptFor(skill: LocalSkillRow): string {
  if (skill.status === "update") return skill.prompts.update;
  if (skill.status === "installed") return skill.prompts.use;
  return skill.prompts.install;
}

type PromptMode = "default" | "reinstall";
type CopiedKind = "prompt" | "reinstall";

/** The assistants the install dialog can target. Their display name is reported as the install agent. */
type AssistantId = "claude-code" | "codex" | "opencode";
const ASSISTANTS: Record<AssistantId, { name: string; vendor: string; hint: string }> = {
  "claude-code": { name: "Claude Code", vendor: "anthropic", hint: "paste into Claude Code" },
  codex: { name: "Codex", vendor: "openai", hint: "paste into Codex" },
  opencode: { name: "OpenCode", vendor: "opencode", hint: "paste into OpenCode" },
};

/**
 * Fill the assistant-prompt placeholders. `agent` substitutes the `<your assistant>` slot the API leaves
 * in the report-back step; it defaults to that literal so callers without an assistant chooser (the detail
 * drawer, the CLI) get byte-identical output to before.
 */
function fillPrompt(
  template: string,
  base: string,
  workspaceId: string,
  token: string,
  agent = "<your assistant>",
): string {
  return template
    .split("{base}")
    .join(base)
    .split("{workspaceId}")
    .join(workspaceId)
    .split("{token}")
    .join(token)
    .split("<your assistant>")
    .join(agent);
}

/** Anthropic mark, shown on the Claude Code chooser tile (copied from the design). */
function ClaudeLogo() {
  return (
    <span className="ls-tile__logo" style={{ background: "#D97757" }} aria-hidden="true">
      <svg width="21" height="21" viewBox="0 0 24 24" fill="#fff">
        <g>
          <rect x="11.2" y="2" width="1.6" height="20" rx="0.8" />
          <rect x="11.2" y="2" width="1.6" height="20" rx="0.8" transform="rotate(36 12 12)" />
          <rect x="11.2" y="2" width="1.6" height="20" rx="0.8" transform="rotate(72 12 12)" />
          <rect x="11.2" y="2" width="1.6" height="20" rx="0.8" transform="rotate(108 12 12)" />
          <rect x="11.2" y="2" width="1.6" height="20" rx="0.8" transform="rotate(144 12 12)" />
        </g>
      </svg>
    </span>
  );
}

/** OpenAI mark, shown on the Codex chooser tile (copied from the design). */
function CodexLogo() {
  return (
    <span className="ls-tile__logo" style={{ background: "#0b0b0d" }} aria-hidden="true">
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.5">
        <ellipse cx="12" cy="12" rx="9.2" ry="3.6" />
        <ellipse cx="12" cy="12" rx="9.2" ry="3.6" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="9.2" ry="3.6" transform="rotate(120 12 12)" />
      </svg>
    </span>
  );
}

function OpenCodeLogo() {
  return (
    <span className="ls-tile__logo" style={{ background: "#365c7d" }} aria-hidden="true">
      <Icon name="terminal" size={18} style={{ color: "#fff" }} />
    </span>
  );
}

function MarkdownNotes({ value }: { value: string }) {
  const blocks: ReactNode[] = [];
  const lines = value.split(/\r?\n/);
  let list: string[] = [];
  const flushList = () => {
    if (!list.length) return;
    const items = list;
    list = [];
    blocks.push(
      <ul className="ls-md__list" key={`list-${blocks.length}`}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>,
    );
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      list.push(bullet[1] ?? "");
      continue;
    }
    flushList();
    const heading = line.match(/^(#{2,3})\s+(.+)$/);
    if (heading) {
      blocks.push(
        <div className="ls-md__heading" key={`h-${blocks.length}`}>
          {heading[2]}
        </div>,
      );
      continue;
    }
    blocks.push(
      <p className="ls-sec__text" key={`p-${blocks.length}`}>
        {line}
      </p>,
    );
  }
  flushList();
  return <div className="ls-md">{blocks}</div>;
}

/**
 * Mint a scoped personal-access token once, on first reveal. Shared by the detail drawer and the
 * install gate so both hand the assistant a real, authenticatable credential (never a placeholder).
 * Owns only the token + phase + retry; clipboard, copy state, and prompt templating stay at the
 * call site because the drawer and the gate copy different variants.
 */
function usePromptToken(scopes: readonly TokenScope[] = TOKEN_SCOPES): {
  token: string | null;
  phase: "loading" | "ready" | "error";
  retry: () => void;
} {
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const mintedRef = useRef(false);
  const mint = useCallback(async () => {
    setPhase("loading");
    try {
      const issued = await issueToken([...scopes]);
      setToken(issued.token);
      setPhase("ready");
    } catch {
      setToken(null);
      setPhase("error");
    }
  }, [scopes]);
  useEffect(() => {
    if (mintedRef.current) return;
    mintedRef.current = true;
    void mint();
  }, [mint]);
  return { token, phase, retry: mint };
}

/** Per-(workspace, skill) dismissal key for the install gate, so it nags once, not on every visit. */
function gateStorageKey(workspaceName: string, key: string): string {
  return `companion:companion-skills:gate-dismissed:${workspaceName}:${key}`;
}

export function LocalSkillsView({
  skills,
  devices = [],
  devicesError = null,
  workspaceId,
  workspaceName,
}: {
  skills: LocalSkillRow[];
  devices?: DeviceRow[];
  devicesError?: string | null;
  workspaceId: string;
  workspaceName: string;
}) {
  const [localSkills, setLocalSkills] = useState<LocalSkillRow[]>(skills);
  const [openKey, setOpenKey] = useState<string | null>(null);
  // localStorage is read post-mount only (SSR renders the dialog/banners closed) to avoid the
  // hydration mismatch the theme prefs hit; `mounted` also keeps `renderToString` output stable.
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const featured =
    localSkills.find((skill) => skill.key === REQUIRED_LOCAL_SKILL_KEY) ?? localSkills[0] ?? null;
  const open = useMemo(() => localSkills.find((s) => s.key === openKey) ?? null, [localSkills, openKey]);

  const storageKey = featured ? gateStorageKey(workspaceName, featured.key) : null;

  useEffect(() => setLocalSkills(skills), [skills]);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!storageKey) return;
    try {
      setDismissed(window.localStorage.getItem(storageKey) === "1");
    } catch {
      setDismissed(false);
    }
  }, [storageKey]);

  const dismissGate = useCallback(() => {
    setDismissed(true);
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, "1");
      } catch {
        /* private mode / storage disabled: fall back to in-memory dismissal */
      }
    }
  }, [storageKey]);

  const reopenGate = useCallback(() => {
    setDismissed(false);
    if (storageKey) {
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
    }
  }, [storageKey]);

  const isNone = featured?.status === "none";

  // While the skill isn't installed, poll so the page flips to the "Connected" banner on its own once
  // the user runs the prompt in their assistant. The install is no longer a hard gate, so this only
  // refreshes status — it never redirects.
  useEffect(() => {
    if (!isNone) return;
    let cancelled = false;
    const checkInstall = async () => {
      try {
        const next = await fetchLocalSkills();
        if (!cancelled) setLocalSkills(next);
      } catch {
        /* transient: the next poll or a reload can recover */
      }
    };
    const timer = window.setInterval(() => {
      void checkInstall();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isNone]);

  // The dialog auto-closes if status flips to installed/update while open, or the drawer opens.
  const gateOpen = mounted && isNone && !dismissed && open === null;
  const showDeferredBanner = mounted && isNone && dismissed && open === null;
  const showInstalledBanner = featured?.status === "installed";
  const showUpdateBanner = featured?.status === "update";

  return (
    <div className="ls">
      <header className="ls-top">
        <span className="ls-top__crumb mono">companion</span>
        <span className="ls-top__sep">·</span>
        <span className="ls-top__crumb">{workspaceName}</span>
        <span className="ls-top__sep">·</span>
        <span className="ls-top__crumb">Companion skills</span>
      </header>

      {showUpdateBanner && featured && (
        <div className="ls-banner ls-banner--warn" role="status">
          <Icon name="arrow-up-circle" size={16} className="ls-banner__ico" />
          <span className="ls-banner__text">
            <strong>Update available</strong> for the Companion skill.{" "}
            <span className="mono">{featured.installedVersion ?? "—"}</span> to{" "}
            <span className="mono">{featured.availableVersion}</span>.
          </span>
          <button type="button" className="ls-banner__action" onClick={() => setOpenKey(featured.key)}>
            Update
          </button>
        </div>
      )}

      {showInstalledBanner && (
        <div className="ls-banner ls-banner--ok" role="status">
          <Icon name="check-circle-2" size={16} className="ls-banner__ico" />
          <span className="ls-banner__text">
            <strong>Connected.</strong> Claude Code, Codex, OpenCode, and your agents can manage the
            skills on this machine.
          </span>
        </div>
      )}

      {showDeferredBanner && (
        <div className="ls-banner ls-banner--danger" role="status">
          <span className="ls-banner__tile" aria-hidden="true">
            <Icon name="plug-zap" size={19} />
          </span>
          <span className="ls-banner__stack">
            <span className="ls-banner__title">Companion is not connected to your assistant</span>
            <span className="ls-banner__sub">
              Claude Code, Codex, and OpenCode can&rsquo;t manage the skills on this machine yet. It takes
              about a minute.
            </span>
          </span>
          <button
            type="button"
            className="btn-danger btn-danger--solid ls-banner__cta"
            onClick={reopenGate}
          >
            <Icon name="arrow-right" size={15} />
            Connect your assistant
          </button>
        </div>
      )}

      <div className="ls-scroll">
        <div className="ls-page">
          <div className="ls-head">
            <div>
              <h1 className="ls-title">Companion skills</h1>
              <p className="ls-lede">
                One helper you install on your machine, or hand to your assistant. It manages the
                skills on this machine and publishes or updates them in Companion, safely.
              </p>
            </div>
          </div>

          {featured ? (
            <div className="ls-list">
              <LocalSkillCard
                skill={featured}
                onOpen={() => setOpenKey(featured.key)}
                onInstall={reopenGate}
              />
              <DevicesSection initialDevices={devices} initialError={devicesError} />
              <p className="ls-foot">
                Companion publishes this skill. It runs on your machine, and nothing is installed
                until you copy a prompt or send it to your assistant.
              </p>
            </div>
          ) : (
            <div className="ls-list">
              <div className="ls-state ls-state--empty">
                <Icon name="laptop" size={20} />
                <div className="ls-state__title">You&rsquo;re all set</div>
                <div className="ls-state__sub">
                  Companion publishes these skills and keeps them current, so there&rsquo;s usually
                  nothing to do here. New skills appear automatically when they&rsquo;re available.
                </div>
              </div>
              <DevicesSection initialDevices={devices} initialError={devicesError} />
            </div>
          )}
        </div>
      </div>

      {open && <LocalSkillDrawer skill={open} workspaceId={workspaceId} onClose={() => setOpenKey(null)} />}
      {gateOpen && featured && (
        <InstallGate skill={featured} workspaceId={workspaceId} onDismiss={dismissGate} />
      )}
    </div>
  );
}

function LocalSkillCard({
  skill,
  onOpen,
  onInstall,
}: {
  skill: LocalSkillRow;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const meta = STATUS_META[skill.status];
  const notInstalled = skill.status === "none";
  return (
    <div className="ls-card">
      {/* Full-card hit target (the row-overlay pattern from ListView's .crow__hit): a real button so
          it is keyboard-operable, with the explicit action buttons layered above it. */}
      <button
        type="button"
        className="ls-card__hit"
        aria-label={`View ${skill.name} details`}
        onClick={onOpen}
      />
      <div className="ls-card__head">
        <span className="ls-card__name">{skill.name}</span>
        <span className="ls-chip mono">{skill.key}</span>
        <span className={"ls-badge " + meta.badge}>
          <span className="ls-badge__dot" />
          {meta.label}
        </span>
      </div>
      <p className="ls-card__desc">{skill.description}</p>

      <div className="ls-card__section">
        <div className="ls-card__label">What it can do</div>
        <div className="ls-chips">
          {skill.commands.map((cmd) => (
            <span className="ls-chip" key={cmd.name}>
              {cmd.name}
            </span>
          ))}
        </div>
      </div>

      <div className="ls-card__foot">
        <span className="ls-verline mono">{versionLine(skill)}</span>
        <div className="ls-card__actions">
          <button className="btn-ghost" type="button" onClick={onOpen}>
            View details
          </button>
          {notInstalled ? (
            <button className="btn-primary" type="button" onClick={onInstall}>
              Install
            </button>
          ) : (
            <button className="btn-primary" type="button" onClick={onOpen}>
              {meta.action}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Install dialog — auto-opens (dismissibly) when the Companion skill isn't installed. This is an
 * activation surface (connect your assistant), not a detail surface: detail stays in the slide-over
 * drawer, so the DESIGN.md "drawer for detail, never modal-first" rule holds. Dismissing it leaves the
 * deferred (red) banner; the install is never forced.
 */
function InstallGate({
  skill,
  workspaceId,
  onDismiss,
}: {
  skill: LocalSkillRow;
  workspaceId: string;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState<string | null>(null);
  const [assistant, setAssistant] = useState<AssistantId>("claude-code");
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [clipFailed, setClipFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  useModalA11y(ref, onDismiss);

  const base = apiBase();
  // Lazy mint with in-flight de-duplication: a token is created only on copy, and concurrent clicks
  // share one request (refs settle synchronously, unlike React state) so we never leave duplicate
  // 90-day credentials behind. The token also lives only here, never persisted. Mirrors the upload
  // dialog's ensure() pattern.
  const tokenRef = useRef<string | null>(null);
  const inflightRef = useRef<Promise<string> | null>(null);
  const ensureToken = useCallback(async () => {
    if (tokenRef.current) return tokenRef.current;
    if (inflightRef.current) return inflightRef.current;
    const pending = (async () => {
      try {
        const issued = await issueToken([...TOKEN_SCOPES]);
        tokenRef.current = issued.token;
        setToken(issued.token);
        return issued.token;
      } finally {
        inflightRef.current = null;
      }
    })();
    inflightRef.current = pending;
    return pending;
  }, []);

  const meta = ASSISTANTS[assistant];
  // The chosen assistant fills the prompt's `agent` slot, so the report-back step names the assistant
  // that actually runs the install.
  const buildPrompt = useCallback(
    (tok: string) => fillPrompt(skill.prompts.install, base, workspaceId, tok, meta.name),
    [base, meta.name, skill.prompts.install, workspaceId],
  );
  // Until the user copies, the token slot shows a placeholder so nothing secret is minted on open.
  const displayPrompt = buildPrompt(token ?? "cmp_pat_…");

  const copyPrompt = useCallback(async () => {
    setFailed(false);
    setClipFailed(false);
    setBusy(true);
    try {
      const value = buildPrompt(await ensureToken());
      if (!navigator.clipboard) {
        setClipFailed(true); // no API: the prompt (now showing the real token) is selectable by hand
        return;
      }
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        setClipFailed(true);
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setFailed(true); // token mint failed
    } finally {
      setBusy(false);
    }
  }, [buildPrompt, ensureToken]);

  return (
    <>
      <div className="ls-gate-scrim" onClick={onDismiss} />
      <div
        className="ls-gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ls-gate-title"
        ref={ref}
        tabIndex={-1}
      >
        <div className="ls-gate__head">
          <span className="ls-gate__mark" aria-hidden="true">
            C
          </span>
          <div className="ls-gate__headtext">
            <div className="ls-gate__eyebrow">Connect your assistant · about a minute</div>
            <h2 className="ls-gate__title" id="ls-gate-title">
              Connect Companion to your assistant
            </h2>
          </div>
          <button type="button" className="ls-gate__close" aria-label="Close" onClick={onDismiss}>
            <Icon name="x" size={17} />
          </button>
        </div>

        <div className="ls-gate__body">
          <p className="ls-gate__lede">
            Install the skill on this machine so Claude Code, Codex, OpenCode, and your agents can
            manage the skills here. You give it a short prompt once. It only acts after confirming
            changes with you.
          </p>

          <div className="ls-gate__feats">
            <span className="ls-gate__feat">
              <Icon name="link-2" size={14} className="ls-gate__feat-ico" />
              Connects your assistant
            </span>
            <span className="ls-gate__feat">
              <Icon name="layers" size={14} className="ls-gate__feat-ico" />
              Runs every skill
            </span>
            <span className="ls-gate__feat">
              <Icon name="shield-check" size={14} className="ls-gate__feat-ico" />
              Confirms before publishing
            </span>
          </div>

          <div className="ls-gate__chotitle">Which assistant do you use?</div>
          <div className="ls-choose" role="group" aria-label="Choose your assistant">
            {(Object.keys(ASSISTANTS) as AssistantId[]).map((id) => {
              const info = ASSISTANTS[id];
              const on = assistant === id;
              return (
                <button
                  key={id}
                  type="button"
                  className={"atile" + (on ? " atile--on" : "")}
                  aria-pressed={on}
                  onClick={() => setAssistant(id)}
                >
                  {id === "claude-code" ? <ClaudeLogo /> : id === "codex" ? <CodexLogo /> : <OpenCodeLogo />}
                  <span className="ls-tile__text">
                    <span className="ls-tile__name">{info.name}</span>
                    <span className="ls-tile__vendor mono">{info.vendor}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="ls-gate__pastehint">
            <span className="ls-gate__promptlabel">Give this to {meta.name}</span>
            <span className="ls-gate__hint">{meta.hint}</span>
          </div>
          {/* Plain pre + a single copy path (the footer button): unlike CodeBlock, this never falls
              back to copying the masked placeholder when the on-copy token mint fails. */}
          <pre className="ls-gate__prompt">{displayPrompt}</pre>
          <p className="ls-prompt-hint">
            A scoped skills:read + skills:write token is added when you copy. It expires in 90 days.
          </p>
          {failed && (
            <div className="ls-copied ls-copied--warn" role="alert">
              <Icon name="alert-triangle" size={14} />
              Could not create an access token. Check your connection, then copy again.
            </div>
          )}
          {clipFailed && (
            <div className="ls-copied ls-copied--warn" role="alert">
              <Icon name="alert-triangle" size={14} />
              Couldn&rsquo;t copy automatically. Select the prompt above and copy it.
            </div>
          )}
        </div>

        <div className="ls-gate__foot">
          <button type="button" className="ls-textbtn" onClick={onDismiss}>
            Maybe later
          </button>
          <span className="ls-gate__footspace" />
          {copied && (
            <span className="ls-gate__copied" role="status">
              <Icon name="check" size={13} />
              Copied
            </span>
          )}
          <button type="button" className="btn-primary" onClick={copyPrompt} disabled={busy}>
            <Icon name={copied ? "check" : "copy"} size={14} />
            {copied ? "Copied" : "Copy prompt"}
          </button>
        </div>
      </div>
    </>
  );
}

export function LocalSkillDrawer({
  skill,
  workspaceId,
  onClose,
}: {
  skill: LocalSkillRow;
  workspaceId: string;
  onClose: () => void;
}) {
  const meta = STATUS_META[skill.status];
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<CopiedKind | null>(null);
  const [confirm, setConfirm] = useState<"used" | null>(null);
  const [promptMode, setPromptMode] = useState<PromptMode>("default");
  const [clipFailed, setClipFailed] = useState(false);

  useModalA11y(ref, onClose);

  // A fresh token is minted once when the drawer opens; copy/send are gated on "ready" so a failed
  // mint can never hand off a placeholder credential the assistant can't authenticate with.
  const { token, phase, retry } = usePromptToken();

  const base = apiBase();
  const isInstalled = skill.status === "installed";
  const isUpdate = skill.status === "update";
  const isReinstall = isUpdate && promptMode === "reinstall";
  const template = isReinstall ? skill.prompts.install : promptFor(skill);
  const primaryLabel = isUpdate ? "Copy update prompt" : "Copy install prompt";

  // The prompt TEXT is derived below from the current template, so it stays correct even if `skill`
  // (and its status) changes while the drawer is open.
  const prompt = token ? fillPrompt(template, base, workspaceId, token) : null;

  const writeClipboard = useCallback(async (value: string): Promise<boolean> => {
    if (!navigator.clipboard) return true; // no API: the prompt is still visible to copy manually
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      setClipFailed(true);
      return false;
    }
  }, []);

  const copyPrompt = useCallback(async (kind: CopiedKind = "prompt", value = prompt) => {
    if (!value || !(await writeClipboard(value))) return;
    setClipFailed(false);
    setConfirm(null);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1800);
  }, [prompt, writeClipboard]);

  const copyDefaultPrompt = useCallback(async () => {
    if (!token) return;
    setPromptMode("default");
    await copyPrompt("prompt", fillPrompt(promptFor(skill), base, workspaceId, token));
  }, [base, copyPrompt, skill, token, workspaceId]);

  const copyReinstallPrompt = useCallback(async () => {
    if (!token) return;
    const reinstallPrompt = fillPrompt(skill.prompts.install, base, workspaceId, token);
    setPromptMode("reinstall");
    await copyPrompt("reinstall", reinstallPrompt);
  }, [base, copyPrompt, skill.prompts.install, token, workspaceId]);

  const handAndConfirm = useCallback(async () => {
    if (!prompt || !(await writeClipboard(prompt))) return;
    setClipFailed(false);
    setCopied(null);
    setConfirm("used");
  }, [prompt, writeClipboard]);

  const confirmText = `Opened with your assistant. ${skill.name} is ready to use.`;

  return (
    <>
      <div className="ls-scrim" onClick={onClose} />
      <div className="ls-drawer" role="dialog" aria-modal="true" aria-label={skill.name} ref={ref} tabIndex={-1}>
        <div className="ls-drawer__head">
          <div className="ls-drawer__titles">
            <div className="ls-drawer__name">{skill.name}</div>
            <div className="ls-drawer__meta">
              <span className="ls-chip mono">{skill.key}</span>
              <span className={"ls-badge " + meta.badge}>
                <span className="ls-badge__dot" />
                {meta.label}
              </span>
            </div>
          </div>
          <button className="iconbtn" type="button" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="ls-drawer__body">
          {confirm && (
            <div className="ls-confirm" role="status">
              <Icon name="check-circle-2" size={15} />
              <span>{confirmText}</span>
            </div>
          )}

          <section>
            <div className="ls-sec__label">Notes</div>
            <MarkdownNotes value={skill.notes} />
          </section>

          <section>
            <div className="ls-sec__label">What it can do</div>
            <div className="ls-cmds">
              {skill.commands.map((cmd) => (
                <div className="ls-cmd" key={cmd.name}>
                  <Icon name="chevron-right" size={14} className="ls-cmd__ico" />
                  <div>
                    <div className="ls-cmd__name">{cmd.name}</div>
                    <div className="ls-cmd__desc">{cmd.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {skill.status === "update" && skill.changes.length > 0 && (
            <section className="ls-changes">
              <div className="ls-changes__title">
                <Icon name="arrow-up-circle" size={14} />
                What changes in {skill.availableVersion}
              </div>
              <div className="ls-changes__list">
                {skill.changes.map((chg) => (
                  <div className="ls-changes__row" key={chg}>
                    <span className="ls-changes__bullet">·</span>
                    <span>{chg}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="ls-sec__label">Versions</div>
            <div className="ls-vergrid">
              <div>
                <div className="ls-vergrid__label">Installed</div>
                <div className="ls-vergrid__val mono">{skill.installedVersion ?? "—"}</div>
              </div>
              <div>
                <div className="ls-vergrid__label">Available</div>
                <div className="ls-vergrid__val mono">{skill.availableVersion}</div>
              </div>
              <div>
                <div className="ls-vergrid__label">Last checked</div>
                <div className="ls-vergrid__val mono ls-vergrid__val--muted">
                  {relativeTime(skill.lastReportedAt)}
                </div>
              </div>
            </div>
          </section>

          <section>
            <div className="ls-sec__label ls-sec__label--icon">
              <Icon name="message-square" size={13} />
              What your assistant will be told
            </div>
            {phase === "loading" && (
              <div className="ls-prompt-state">
                <Icon name="loader" size={15} className="ls-spin" />
                Preparing a secure access token…
              </div>
            )}
            {phase === "error" && (
              <div className="up-errblock" role="alert">
                Could not create an access token. Check your connection, then
                <button type="button" className="ls-retry" onClick={() => void retry()}>
                  try again
                </button>
                .
              </div>
            )}
            {phase === "ready" && prompt && (
              <>
                <CodeBlock text={prompt} scroll copyLabel="Copy prompt" />
                <p className="ls-prompt-hint">Scoped to skills:read + skills:write, expires in 90 days.</p>
                {copied && (
                  <div className="ls-copied" role="status">
                    <Icon name="check" size={14} />
                    {copied === "reinstall"
                      ? "Reinstall prompt copied. Paste it into your assistant."
                      : "Copied to your clipboard. Paste it into your assistant."}
                  </div>
                )}
                {clipFailed && (
                  <div className="ls-copied ls-copied--warn" role="alert">
                    <Icon name="alert-triangle" size={14} />
                    Couldn&rsquo;t copy automatically. Select the prompt above and copy it.
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        <div className="ls-drawer__foot">
          {isInstalled ? (
            <>
              <button className="btn-ghost" type="button" onClick={copyDefaultPrompt} disabled={phase !== "ready"}>
                <Icon name={copied === "prompt" ? "check" : "copy"} size={14} />
                {copied === "prompt" ? "Copied" : "Copy prompt"}
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={handAndConfirm}
                disabled={phase !== "ready"}
              >
                <Icon name="sparkles" size={14} />
                Use with assistant
              </button>
            </>
          ) : (
            <>
              {isUpdate && (
                <button
                  className="ls-textbtn"
                  type="button"
                  onClick={copyReinstallPrompt}
                  disabled={phase !== "ready"}
                >
                  {copied === "reinstall" ? "Copied" : "Reinstall Skill?"}
                </button>
              )}
              <button className="btn-primary" type="button" onClick={copyDefaultPrompt} disabled={phase !== "ready"}>
                <Icon name={copied === "prompt" ? "check" : "copy"} size={14} />
                {copied === "prompt" ? "Copied" : primaryLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
