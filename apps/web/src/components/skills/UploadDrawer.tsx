"use client";

import { useEffect, useRef, useState } from "react";
import type { ValidationResult } from "@companion/contracts";
import type { TeamVM } from "@/lib/types";
import { Badge, Button, IconButton } from "../cds";
import { Icon } from "../Icon";

type Phase = "idle" | "validating" | "validated" | "publishing";

export function UploadDrawer({
  teams,
  onClose,
  onUploaded,
}: {
  teams: TeamVM[];
  onClose: () => void;
  onUploaded: () => void;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [scope, setScope] = useState("team");
  const [team, setTeam] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusables = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusables.length) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (scope === "team" && !team && teams[0]) setTeam(teams[0].id);
  }, [scope, team, teams]);

  async function handleFile(f: File) {
    setFile(f);
    setPhase("validating");
    setError(null);
    setResult(null);
    const fd = new FormData();
    fd.append("file", f);
    fd.append("action", "validate");
    try {
      const res = await fetch("/v1/skills", { method: "POST", body: fd });
      const json = (await res.json()) as { result?: ValidationResult; error?: string };
      if (!res.ok) {
        setError(json.error ?? "Validation failed");
        setPhase("idle");
        return;
      }
      const r = json.result ?? null;
      setResult(r);
      if (r?.frontmatter?.scope) setScope(r.frontmatter.scope);
      setPhase("validated");
    } catch {
      setError("Could not reach the server");
      setPhase("idle");
    }
  }

  async function publish() {
    if (!file) return;
    if (scope === "team" && !team.trim()) {
      setError("Choose a team before publishing a team-scoped skill");
      return;
    }
    setPhase("publishing");
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("action", "publish");
    fd.append("scope", scope);
    if (scope === "team") fd.append("team", team);
    try {
      const res = await fetch("/v1/skills", { method: "POST", body: fd });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(json.error ?? "Could not add to registry");
        setPhase("validated");
        return;
      }
      onUploaded();
    } catch {
      setError("Could not reach the server");
      setPhase("validated");
    }
  }

  const valid = result?.ok === true;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-label="Upload skill">
        <header className="drawer__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <p className="drawer__eyebrow">Skills Hub</p>
            <h2 className="drawer__title" style={{ fontFamily: "var(--font-ui)", letterSpacing: "var(--tracking-tight)" }}>
              Upload skill
            </h2>
          </div>
          <IconButton label="Close" ref={closeRef} onClick={onClose}>
            <Icon name="x" />
          </IconButton>
        </header>

        <div className="drawer__body">
          {!file ? (
            <button
              type="button"
              className={"dropzone" + (drag ? " is-drag" : "")}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void handleFile(f);
              }}
            >
              <span className="dropzone__ico">
                <Icon name="upload-cloud" size={22} />
              </span>
              <span className="dropzone__title">Drop a SKILL.md package</span>
              <span className="dropzone__hint">
                A folder with SKILL.md plus optional scripts, references, and assets. Packaged as a .tar.gz
                (use `companion skills push`).
              </span>
            </button>
          ) : (
            <>
              <div className="upfile">
                <span className="upfile__ico">
                  <Icon name="file-archive" size={16} />
                </span>
                <span className="upfile__name">{file.name}</span>
                <span className="upfile__size">{(file.size / 1024).toFixed(1)} KB</span>
                <IconButton
                  label="Remove"
                  size="sm"
                  onClick={() => {
                    setFile(null);
                    setPhase("idle");
                    setResult(null);
                    setError(null);
                  }}
                >
                  <Icon name="x" size={13} />
                </IconButton>
              </div>

              <div aria-live="polite" role="status">
                <p className="section-label">
                  {phase === "validating" ? (
                    <>
                      <span className="cds-spinner" style={{ width: 12, height: 12 }} /> Validating
                    </>
                  ) : valid ? (
                    <>
                      Validation <Badge tone="ok" dot>Passed</Badge>
                    </>
                  ) : (
                    <>
                      Validation <Badge tone="danger" dot>Failed</Badge>
                    </>
                  )}
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {(result?.checks ?? []).map((c) => (
                    <div key={c.id} className="validrow">
                      <span
                        style={{
                          color: c.status === "pass" ? "var(--color-ok)" : "var(--color-danger)",
                          marginTop: 1,
                          display: "inline-flex",
                        }}
                      >
                        <Icon name={c.status === "pass" ? "check" : "x"} size={13} />
                      </span>
                      <span>
                        {c.label}
                        {c.detail ? <span className="validrow__detail"> - {c.detail}</span> : null}
                      </span>
                    </div>
                  ))}
                  {phase === "validating" ? (
                    <div className="validrow">
                      <span className="validrow__detail">Reading package...</span>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="cds-field">
                <label className="cds-field__label" htmlFor="up-scope">
                  Visibility scope
                </label>
                <select
                  id="up-scope"
                  className="cds-field__control"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="private">private - only you</option>
                  <option value="team">team - a team you are on</option>
                  <option value="public">public - anyone with the link</option>
                </select>
                {scope === "team" ? (
                  <div className="cds-field" style={{ marginTop: 8 }}>
                    <label className="cds-field__label" htmlFor="up-team">
                      Team
                    </label>
                    <select
                      id="up-team"
                      className="cds-field__control"
                      value={team}
                      onChange={(e) => setTeam(e.target.value)}
                      required
                    >
                      <option value="" disabled>
                        Choose a team
                      </option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <span className="cds-field__hint">
                  Who can see and attach this skill. You can change it later.
                </span>
              </div>

              {error ? <div className="errblock" role="alert">{error}</div> : null}
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".gz,.tgz,.tar"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
        </div>

        <footer className="drawer__foot">
          <Button
            variant="primary"
            disabled={!valid || phase === "publishing" || (scope === "team" && !team.trim())}
            iconLeft={
              phase === "publishing" ? (
                <span className="cds-spinner" style={{ width: 14, height: 14 }} />
              ) : (
                <Icon name="plus" />
              )
            }
            onClick={publish}
          >
            Add to registry
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </footer>
      </aside>
    </>
  );
}
