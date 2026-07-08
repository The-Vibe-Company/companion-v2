"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ModelsResponse, SkillRunDetail } from "@companion/contracts";
import { Icon } from "../Icon";
import { Dialog } from "../org/primitives";
import { fetchModels, fetchProviderConnections, launchRun } from "@/lib/runQueries";
import {
  effectiveActivatedSet,
  filterGroupsToActivated,
  firstConnectedModel,
  groupModelsByProvider,
  modelProviderConnected,
  toModelProviders,
} from "./derive";
import { ModelPicker } from "./ModelPicker";

/**
 * The "Run skill" launcher: prompt + optional attachments (≤5 × 10 MB) + a model picker grouped by
 * provider (connect inline when none is connected yet). Submit POSTs the multipart launch and hands
 * the `starting` run back to the parent, which navigates to the run view.
 */

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function RunLauncherDialog({
  slug,
  initialPrompt,
  initialFiles,
  onLaunched,
  onClose,
  onOpenModelSettings,
  onStashDraft,
}: {
  slug: string;
  /** Prefill (the "Run again" path from a frozen transcript, or a stashed add-models draft). */
  initialPrompt?: string;
  /** Prefill attachments (restored from a stashed add-models draft). */
  initialFiles?: File[];
  onLaunched: (run: SkillRunDetail) => void;
  onClose: () => void;
  /**
   * Open Settings → Models. The skills shell renders Settings as a LOCAL surface (not a route),
   * so a plain router.push would be swallowed — the shell passes its own opener; the router path
   * is only the fallback for hosts without one.
   */
  onOpenModelSettings?: () => void;
  /** Save the composed prompt/attachments before the add-models detour unmounts the dialog. */
  onStashDraft?: (draft: { prompt: string; files: File[] }) => void;
}) {
  const router = useRouter();
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [files, setFiles] = useState<File[]>(initialFiles ?? []);
  const [model, setModel] = useState("");
  const [connectedNow, setConnectedNow] = useState<Set<string>>(() => new Set());
  const [vanishConnected, setVanishConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Synchronous submit gate (StrictMode-safe: never gate the RPC on state set inside an updater).
  const submittingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    fetchModels()
      .then((response) => live && setModels(response))
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : "Could not load the model catalog."));
    fetchProviderConnections()
      .then((r) => live && setVanishConnected(r.connections.some((cn) => cn.provider === "vanish")))
      .catch(() => live && setVanishConnected(null));
    return () => {
      live = false;
    };
  }, []);

  const activated = useMemo(
    () => effectiveActivatedSet(models?.activated ?? { personal: [], org: [] }),
    [models],
  );
  // Only activated models exist for this dialog — default selection and canLaunch never see more.
  const groups = useMemo(() => {
    if (!models) return [];
    return filterGroupsToActivated(groupModelsByProvider(models.models, toModelProviders(models), connectedNow), activated);
  }, [models, connectedNow, activated]);

  // The full catalog lives in Settings → Models; close first — the model list is fetched on mount,
  // so reopening the launcher after activating picks up the fresh list. Stash the composition
  // first: closing unmounts the dialog and would otherwise discard the prompt and attachments.
  const goAddModels = () => {
    onStashDraft?.({ prompt, files });
    onClose();
    if (onOpenModelSettings) onOpenModelSettings();
    else router.push("/settings?view=models");
  };

  // Preselect the first connected provider's first model; keep the selection valid as providers
  // connect. Never auto-select a disabled (unconnected) model.
  useEffect(() => {
    if (model && modelProviderConnected(groups, model)) return;
    const next = firstConnectedModel(groups);
    if (next !== model) setModel(next ?? "");
  }, [groups, model]);

  const anyConnected = groups.some((g) => g.provider.connected);
  const modelConnected = model ? modelProviderConnected(groups, model) : false;
  const canLaunch = prompt.trim().length > 0 && !!model && modelConnected && !busy;

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    setError(null);
    const next = [...files];
    for (const file of Array.from(incoming)) {
      if (next.length >= MAX_FILES) {
        setError(`You can attach at most ${MAX_FILES} files.`);
        break;
      }
      if (file.size === 0) {
        setError(`${file.name} is empty.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(`${file.name} is larger than 10 MB.`);
        continue;
      }
      next.push(file);
    }
    setFiles(next);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const launch = () => {
    if (!canLaunch || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    launchRun(slug, { prompt: prompt.trim(), model, files })
      .then(onLaunched)
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Could not start the run.");
        submittingRef.current = false;
        setBusy(false);
      });
  };

  return (
    <Dialog
      icon="play"
      title="Run skill"
      desc={`Start a sandboxed session with ${slug} mounted. The sandbox is fresh, isolated, and freezes into a transcript after ~5 minutes of inactivity.`}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn-sec" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={launch} disabled={!canLaunch}>
            {busy ? "Starting…" : "Run skill"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div className="seclabel">Prompt</div>
          <textarea
            className="ag-textarea"
            value={prompt}
            autoFocus
            rows={4}
            maxLength={8000}
            placeholder={`What should ${slug} do?`}
            aria-label="Run prompt"
            onChange={(e) => setPrompt(e.target.value)}
            style={{ minHeight: 92 }}
          />
        </div>

        <div>
          <div className="seclabel">Attachments</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {files.map((file, index) => (
              <div
                key={`${file.name}-${index}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  border: "1px solid var(--color-line)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--color-surface-sunken)",
                  padding: "6px 9px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  color: "var(--color-fg)",
                }}
              >
                <Icon name="file" size={13} style={{ color: "var(--color-muted)", flex: "none" }} />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {file.name}
                </span>
                <span style={{ color: "var(--color-faint)", flex: "none" }}>{formatBytes(file.size)}</span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="mrow__x"
                  title={`Remove ${file.name}`}
                  onClick={() => setFiles(files.filter((_, i) => i !== index))}
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
            {files.length < MAX_FILES && (
              <button type="button" className="ag-btn" onClick={() => fileInputRef.current?.click()} style={{ alignSelf: "flex-start" }}>
                <Icon name="plus" size={13} />
                Attach files
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              aria-label="Attach files"
              onChange={(e) => addFiles(e.target.files)}
            />
            <span style={{ fontSize: 11, color: "var(--color-faint)" }}>
              Up to {MAX_FILES} files, 10 MB each — written to the sandbox under attachments/.
            </span>
          </div>
        </div>

        <div>
          <div className="seclabel">Model</div>
          {loadError ? (
            <pre className="errblock" role="alert" style={{ margin: 0 }}>
              {loadError}
            </pre>
          ) : models === null ? (
            <div style={{ padding: "12px 0", fontSize: "var(--text-xs)", color: "var(--color-faint)" }}>
              Loading models…
            </div>
          ) : (
            <>
              <ModelPicker
                models={models}
                model={model}
                onSelectModel={setModel}
                connectedNow={connectedNow}
                onConnected={(providerId) =>
                  setConnectedNow((prev) => {
                    const next = new Set(prev);
                    next.add(providerId);
                    return next;
                  })
                }
                activated={activated}
                onAddModels={goAddModels}
              />
              {groups.length > 0 && !anyConnected && (
                <p style={{ margin: "7px 0 0", fontSize: "var(--text-xs)", color: "var(--color-faint)" }}>
                  Connect a model provider above to run this skill — or manage keys in Settings → Models.
                </p>
              )}
            </>
          )}
        </div>

        {vanishConnected === false && (
          <p style={{ margin: 0, fontSize: 11, color: "var(--color-faint)" }}>
            Tip: connect Vanish in Settings → Artifacts to get shareable links for files this run produces.
          </p>
        )}

        {error && (
          <pre className="errblock" role="alert" style={{ margin: 0 }}>
            {error}
          </pre>
        )}
      </div>
    </Dialog>
  );
}
