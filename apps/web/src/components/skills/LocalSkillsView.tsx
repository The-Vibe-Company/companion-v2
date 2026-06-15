"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalSkillRow, LocalSkillStatus } from "@companion/contracts";
import { apiBase, issueToken } from "@/lib/queries";
import { Icon } from "../Icon";
import { CodeBlock, useModalA11y } from "./UploadDialog";

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

function promptFor(skill: LocalSkillRow): string {
  if (skill.status === "update") return skill.prompts.update;
  if (skill.status === "installed") return skill.prompts.use;
  return skill.prompts.install;
}

function fillPrompt(template: string, base: string, token: string): string {
  return template.split("{base}").join(base).split("{token}").join(token);
}

export function LocalSkillsView({
  skills,
  workspaceName,
  onRefresh,
}: {
  skills: LocalSkillRow[];
  workspaceName: string;
  onRefresh: () => Promise<LocalSkillRow[]>;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const featured = skills[0] ?? null;
  const open = useMemo(() => skills.find((s) => s.key === openKey) ?? null, [skills, openKey]);
  const lastChecked = useMemo(
    () => (featured ? relativeTime(featured.lastReportedAt) : "—"),
    [featured],
  );

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      await onRefresh();
    } catch {
      /* keep the current rows on a failed re-check */
    } finally {
      setChecking(false);
    }
  }, [onRefresh]);

  return (
    <div className="ls">
      <header className="ls-top">
        <span className="ls-top__crumb mono">companion</span>
        <span className="ls-top__sep">·</span>
        <span className="ls-top__crumb">{workspaceName}</span>
        <span className="ls-top__sep">·</span>
        <span className="ls-top__crumb">Companion skills</span>
      </header>

      <div className="ls-scroll">
        <div className="ls-page">
          <div className="ls-head">
            <div>
              <div className="ls-eyebrow">On this machine</div>
              <h1 className="ls-title">Companion skills</h1>
              <p className="ls-lede">
                One helper you install on your machine, or hand to your assistant. It manages the
                skills on this machine and publishes or updates them in Companion, safely.
              </p>
            </div>
            <div className="ls-head__actions">
              <span className="ls-checked mono">checked {lastChecked}</span>
              <button className="dsecbtn" type="button" onClick={recheck} disabled={checking}>
                <Icon name="refresh-cw" size={14} />
                Check again
              </button>
            </div>
          </div>

          {checking ? (
            <div className="ls-state">
              <Icon name="loader" size={22} className="ls-spin" />
              <div className="ls-state__title">Checking your machine</div>
              <div className="ls-state__sub">Looking for installed skills and comparing versions.</div>
            </div>
          ) : featured ? (
            <div className="ls-list">
              <LocalSkillCard skill={featured} onOpen={() => setOpenKey(featured.key)} />
              <p className="ls-foot">
                Companion publishes this skill. It runs on your machine, and nothing is installed
                until you copy a prompt or send it to your assistant.
              </p>
            </div>
          ) : (
            <div className="ls-state ls-state--empty">
              <Icon name="laptop" size={20} />
              <div className="ls-state__title">You&rsquo;re all set</div>
              <div className="ls-state__sub">
                Companion publishes these skills and keeps them current, so there&rsquo;s usually
                nothing to do here. New skills appear automatically when they&rsquo;re available.
              </div>
              <button className="dsecbtn" type="button" onClick={recheck} style={{ marginTop: 4 }}>
                <Icon name="refresh-cw" size={14} />
                Check again
              </button>
            </div>
          )}
        </div>
      </div>

      {open && <LocalSkillDrawer skill={open} onClose={() => setOpenKey(null)} />}
    </div>
  );
}

function LocalSkillCard({ skill, onOpen }: { skill: LocalSkillRow; onOpen: () => void }) {
  const meta = STATUS_META[skill.status];
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
        <div className="ls-versions">
          <div>
            <div className="ls-versions__label">Installed</div>
            <div className="ls-versions__val mono">{skill.installedVersion ?? "—"}</div>
          </div>
          <div className="ls-versions__rule" />
          <div>
            <div className="ls-versions__label">Available</div>
            <div className={"ls-versions__val mono" + (skill.status === "update" ? " is-warn" : "")}>
              {skill.availableVersion}
            </div>
          </div>
        </div>
        <div className="ls-card__actions">
          <button className="btn-ghost" type="button" onClick={onOpen}>
            View details
          </button>
          <button className="btn-primary" type="button" onClick={onOpen}>
            {meta.action}
          </button>
        </div>
      </div>
    </div>
  );
}

function LocalSkillDrawer({ skill, onClose }: { skill: LocalSkillRow; onClose: () => void }) {
  const meta = STATUS_META[skill.status];
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<"sent" | "used" | null>(null);
  // A fresh token is minted once when the drawer opens; copy/send are gated on "ready" so a failed
  // mint can never hand off a placeholder credential the assistant can't authenticate with.
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [clipFailed, setClipFailed] = useState(false);

  useModalA11y(ref, onClose);

  const base = apiBase();
  const template = promptFor(skill);
  const isInstalled = skill.status === "installed";
  const primaryLabel = skill.status === "update" ? "Copy update prompt" : "Copy install prompt";

  // Mint a read+write token once when the drawer opens. The prompt TEXT is derived below from the
  // current template, so it stays correct even if `skill` (and its status) changes while open.
  const mintedRef = useRef(false);
  const mint = useCallback(async () => {
    setPhase("loading");
    try {
      const issued = await issueToken(["skills:read", "skills:write"]);
      setToken(issued.token);
      setPhase("ready");
    } catch {
      setToken(null);
      setPhase("error");
    }
  }, []);
  useEffect(() => {
    if (mintedRef.current) return;
    mintedRef.current = true;
    void mint();
  }, [mint]);

  const prompt = token ? fillPrompt(template, base, token) : null;

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

  const copyPrompt = useCallback(async () => {
    if (!prompt || !(await writeClipboard(prompt))) return;
    setClipFailed(false);
    setConfirm(null);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [prompt, writeClipboard]);

  const handAndConfirm = useCallback(
    async (kind: "sent" | "used") => {
      if (!prompt || !(await writeClipboard(prompt))) return;
      setClipFailed(false);
      setCopied(false);
      setConfirm(kind);
    },
    [prompt, writeClipboard],
  );

  const confirmText =
    confirm === "used"
      ? `Opened with your assistant. ${skill.name} is ready to use.`
      : skill.status === "update"
        ? `Sent to your assistant. It will update ${skill.name} to ${skill.availableVersion} and confirm when it's done.`
        : `Sent to your assistant. It will install ${skill.name} and confirm when it's ready.`;

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
            <div className="ls-sec__label">What it does</div>
            <p className="ls-sec__text">{skill.what}</p>
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

          <section>
            <div className="ls-sec__label ls-sec__label--icon">
              <Icon name="shield-check" size={13} className="ls-ico-ok" />
              Why it&rsquo;s safe
            </div>
            <div className="ls-why">
              {skill.why.map((line) => (
                <div className="ls-why__row" key={line}>
                  <Icon name="check" size={14} className="ls-ico-ok" />
                  <span>{line}</span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="ls-sec__label">What your assistant uses it for</div>
            <p className="ls-sec__text ls-sec__text--muted">{skill.uses}</p>
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
                <button type="button" className="ls-retry" onClick={() => void mint()}>
                  try again
                </button>
                .
              </div>
            )}
            {phase === "ready" && prompt && (
              <>
                <CodeBlock text={prompt} scroll copyLabel="Copy prompt" />
                <p className="ls-prompt-hint">Scoped to skills:read + skills:write, expires in 24 hours.</p>
                {copied && (
                  <div className="ls-copied" role="status">
                    <Icon name="check" size={14} />
                    Copied to your clipboard. Paste it into your assistant.
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
              <button className="btn-ghost" type="button" onClick={copyPrompt} disabled={phase !== "ready"}>
                <Icon name={copied ? "check" : "copy"} size={14} />
                {copied ? "Copied" : "Copy prompt"}
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={() => handAndConfirm("used")}
                disabled={phase !== "ready"}
              >
                <Icon name="sparkles" size={14} />
                Use with assistant
              </button>
            </>
          ) : (
            <>
              <button
                className="btn-ghost"
                type="button"
                onClick={() => handAndConfirm("sent")}
                disabled={phase !== "ready"}
              >
                <Icon name="send" size={14} />
                Send to assistant
              </button>
              <button className="btn-primary" type="button" onClick={copyPrompt} disabled={phase !== "ready"}>
                <Icon name={copied ? "check" : "copy"} size={14} />
                {copied ? "Copied" : primaryLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
