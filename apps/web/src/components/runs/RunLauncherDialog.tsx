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
import { ModelSelect } from "./ModelSelect";

/**
 * The "Run skill" launcher: a ChatGPT-style composer with prompt, attachments, and a compact model
 * selector in the footer. Submit POSTs the multipart launch and hands the `starting` run back to the
 * parent, which navigates to the run view.
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
  initialPrompt?: string;
  initialFiles?: File[];
  onLaunched: (run: SkillRunDetail) => void;
  onClose: () => void;
  onOpenModelSettings?: () => void;
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
  const groups = useMemo(() => {
    if (!models) return [];
    return filterGroupsToActivated(groupModelsByProvider(models.models, toModelProviders(models), connectedNow), activated);
  }, [models, connectedNow, activated]);

  const goAddModels = () => {
    onStashDraft?.({ prompt, files });
    onClose();
    if (onOpenModelSettings) onOpenModelSettings();
    else router.push("/settings?view=models");
  };

  useEffect(() => {
    if (model && modelProviderConnected(groups, model)) return;
    const next = firstConnectedModel(groups);
    if (next !== model) setModel(next ?? "");
  }, [groups, model]);

  const anyConnected = groups.some((g) => g.provider.connected);
  const modelConnected = model ? modelProviderConnected(groups, model) : false;
  const canLaunch = prompt.trim().length > 0 && !!model && modelConnected && !busy;

  const addFiles = (incoming: FileList | File[] | null) => {
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
    <Dialog icon="play" title={`Run ${slug}`} desc="" onClose={onClose} className="og-dialog run-launcher">
      <div className="composer__box composer__box--launch">
        <textarea
          className="composer__input composer__input--launch"
          value={prompt}
          autoFocus
          rows={4}
          maxLength={8000}
          placeholder={`What should ${slug} do?`}
          aria-label="Run prompt"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              launch();
            }
          }}
        />

        {files.length > 0 && (
          <div className="launch-files">
            {files.map((file, index) => (
              <span className="launch-file" key={`${file.name}-${index}`}>
                <Icon name="file" size={12} />
                <span className="launch-file__name">{file.name}</span>
                <span className="launch-file__size">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  className="launch-file__x"
                  title={`Remove ${file.name}`}
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setFiles(files.filter((_, i) => i !== index))}
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {error && <p className="composer__error">{error}</p>}

        <div className="composer__foot composer__foot--launch">
          {loadError ? (
            <span className="run-launcher__err">{loadError}</span>
          ) : models === null ? (
            <span className="composer__hint">Loading models…</span>
          ) : (
            <ModelSelect
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
          )}
          <span className="fv-spacer" />
          {files.length < MAX_FILES && (
            <>
              <button
                type="button"
                className="composer__attach"
                title="Attach files"
                aria-label="Attach files"
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="file" size={14} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                aria-label="Attach files"
                onChange={(e) => addFiles(e.target.files)}
              />
            </>
          )}
          <span className="composer__hint">⌘↵</span>
          <button type="button" className="btn-primary" onClick={launch} disabled={!canLaunch}>
            {busy ? "Starting…" : "Run"}
            {!busy && (
              <span className="run-launcher__run-ico">
                <Icon name="corner-down-right" size={13} />
              </span>
            )}
          </button>
        </div>
      </div>

      {groups.length > 0 && !anyConnected && (
        <p className="run-launcher__note">
          Connect a provider to run — or manage keys in Settings → Models.
        </p>
      )}
      {vanishConnected === false && (
        <p className="run-launcher__note">
          Tip: connect Vanish in Settings → Artifacts for shareable links.
        </p>
      )}
    </Dialog>
  );
}
