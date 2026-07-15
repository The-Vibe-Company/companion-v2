"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  RunConfiguration,
  RunDeclaredSecret,
  RunDeclaredVariable,
  RunInputSelection,
  RunOptions,
  SkillRunDetail,
} from "@companion/contracts";
import { Icon } from "../Icon";
import { Dialog } from "../org/primitives";
import {
  VaultSecretField,
  type VaultSecretReference,
} from "../secrets/VaultSecretField";
import {
  abandonRunPrewarm,
  createRunConfiguration,
  deleteRunConfiguration,
  fetchRunOptions,
  heartbeatRunPrewarm,
  launchRun,
  startRunPrewarm,
  updateRunConfiguration,
} from "@/lib/runQueries";
import {
  authoritativeInputs,
  configurationIsModified,
  emptyRunInputSelection,
  groupRunInputs,
  prefilledInputs,
  runDraftBlockers,
  secretSelectionKey,
  type RunLauncherDraft,
  variableSelectionKey,
} from "./launcherState";
import { ModelSelect } from "./ModelSelect";

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function replaceConfiguration(rows: RunConfiguration[], row: RunConfiguration): RunConfiguration[] {
  return rows.some((candidate) => candidate.id === row.id)
    ? rows.map((candidate) => (candidate.id === row.id ? row : candidate))
    : [...rows, row].sort((left, right) => left.name.localeCompare(right.name));
}

function asReference(candidate: RunDeclaredSecret["candidates"][number]): VaultSecretReference {
  return {
    id: candidate.id,
    name: candidate.name,
    key: candidate.key,
    audience: candidate.audience,
    owner: { name: candidate.owner.name },
  };
}

function configConflictMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Could not save the configuration.";
  return /409|revision|conflict/i.test(message)
    ? "This configuration changed in another tab. Reload run options before trying again."
    : message;
}

export function RunLauncherDialog({
  slug,
  orgId,
  initialDraft,
  onLaunched,
  onClose,
  onOpenModelSettings,
  onStashDraft,
}: {
  slug: string;
  orgId: string;
  initialDraft?: RunLauncherDraft | null;
  onLaunched: (run: SkillRunDetail) => void;
  onClose: () => void;
  onOpenModelSettings?: () => void;
  onStashDraft?: (draft: RunLauncherDraft) => void;
}) {
  const router = useRouter();
  const [options, setOptions] = useState<RunOptions | null>(null);
  const [configurations, setConfigurations] = useState<RunConfiguration[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState<string | null>(initialDraft?.configurationId ?? null);
  const [prompt, setPrompt] = useState(initialDraft?.prompt ?? "");
  const [files, setFiles] = useState<File[]>(initialDraft?.files ?? []);
  const [model, setModel] = useState(initialDraft?.model ?? "");
  const [inputs, setInputs] = useState<RunInputSelection>(initialDraft?.inputs ?? emptyRunInputSelection());
  const [createdSecrets, setCreatedSecrets] = useState<VaultSecretReference[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [nameMode, setNameMode] = useState<"save" | "rename" | null>(null);
  const [configName, setConfigName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const initializedRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const launchIdempotencyRef = useRef<string | null>(initialDraft?.launchIdempotencyKey ?? null);
  const mountedRef = useRef(true);
  const skipUnmountStashRef = useRef(false);
  const explicitStashRef = useRef(false);
  const pendingUnmountRef = useRef<symbol | null>(null);
  const prewarmIdRef = useRef<string | null>(null);
  const prewarmStartRef = useRef<Promise<unknown> | null>(null);
  const prewarmAdoptedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const abandonPrewarm = () => {
    const id = prewarmIdRef.current;
    if (!id || prewarmAdoptedRef.current) return;
    prewarmIdRef.current = null;
    abandonRunPrewarm(id);
  };

  // An ambiguous transport failure may be retried with the same key. Any draft change represents a
  // new authoritative payload and must get a fresh key instead of conflicting with that attempt.
  const launchPayloadSignature = useMemo(() => JSON.stringify({
    prompt,
    model,
    inputs,
    selectedConfigId,
    files: files.map((file) => [file.name, file.size, file.type, file.lastModified]),
    skillVersionId: options?.root.skill_version_id ?? null,
    dependencyPins: options?.dependencies.map(({ skill_id, skill_version_id }) => ({ skill_id, skill_version_id })) ?? [],
  }), [files, inputs, model, options, prompt, selectedConfigId]);
  const previousLaunchPayloadRef = useRef(initialDraft?.launchPayloadSignature ?? launchPayloadSignature);
  useEffect(() => {
    // Loading options fills the exact root version. Preserve a retry key when that hydrated
    // signature is the one stashed with it; a genuinely newer root invalidates the attempt.
    if (!options || submittingRef.current) return;
    if (previousLaunchPayloadRef.current !== launchPayloadSignature) {
      previousLaunchPayloadRef.current = launchPayloadSignature;
      launchIdempotencyRef.current = null;
    }
  }, [busy, launchPayloadSignature, options]);

  const loadOptions = () => {
    setLoadError(null);
    fetchRunOptions(slug)
      .then((response) => {
        setOptions(response);
        setConfigurations(response.configurations);
      })
      .catch((cause) => setLoadError(cause instanceof Error ? cause.message : "Could not load run options."));
  };

  useEffect(() => {
    let live = true;
    setOptions(null);
    setLoadError(null);
    fetchRunOptions(slug)
      .then((response) => {
        if (!live) return;
        setOptions(response);
        setConfigurations(response.configurations);
      })
      .catch((cause) => live && setLoadError(cause instanceof Error ? cause.message : "Could not load run options."));
    return () => {
      live = false;
    };
  }, [slug]);

  useEffect(() => {
    if (!prewarmStartRef.current) {
      prewarmStartRef.current = startRunPrewarm(slug).then((prewarm) => {
        if (!prewarm) return;
        if (!mountedRef.current || prewarmAdoptedRef.current) {
          abandonRunPrewarm(prewarm.id);
          return;
        }
        prewarmIdRef.current = prewarm.id;
      }).catch(() => undefined);
    }
  }, [slug]);

  useEffect(() => {
    const heartbeat = window.setInterval(() => {
      const id = prewarmIdRef.current;
      if (!id || prewarmAdoptedRef.current) return;
      void heartbeatRunPrewarm(id);
    }, 10_000);
    const onPageHide = () => abandonPrewarm();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  const effectiveOptions = useMemo<RunOptions | null>(() => {
    if (!options || createdSecrets.length === 0) return options;
    return {
      ...options,
      declared_secrets: options.declared_secrets.map((declaration) => ({
        ...declaration,
        candidates: [
          ...declaration.candidates,
          ...createdSecrets
            .filter((secret) => !declaration.candidates.some((candidate) => candidate.id === secret.id))
            .map((secret) => ({
              ...secret,
              owner: { id: "00000000-0000-4000-8000-000000000000", name: secret.owner.name, initials: "", avatar_url: null },
              personal: secret.audience === "personal",
            })),
        ],
      })),
    };
  }, [createdSecrets, options]);

  useEffect(() => {
    if (!options || initializedRef.current === slug) return;
    initializedRef.current = slug;
    const requested = initialDraft?.configurationId
      ? options.configurations.find((row) => row.id === initialDraft.configurationId) ?? null
      : null;
    const fallback = options.configurations.find((row) => row.is_default) ?? null;
    const configuration = requested ?? (!initialDraft ? fallback : null);
    const nextInputs = initialDraft?.inputs ?? configuration?.inputs ?? prefilledInputs(options);
    const nextModel = initialDraft?.model || configuration?.model || options.models.find((item) => item.readiness === "ready")?.model.id || "";
    setSelectedConfigId(configuration?.id ?? null);
    setInputs(authoritativeInputs(options, nextInputs));
    setModel(nextModel);
  }, [initialDraft, options, slug]);

  const selectedConfiguration = configurations.find((row) => row.id === selectedConfigId) ?? null;
  const modified = configurationIsModified(selectedConfiguration, model, inputs);
  const groups = useMemo(() => effectiveOptions ? groupRunInputs(effectiveOptions) : [], [effectiveOptions]);
  const blockers = useMemo(
    () => {
      if (!effectiveOptions) return [];
      const current = runDraftBlockers(effectiveOptions, model, authoritativeInputs(effectiveOptions, inputs));
      // Configuration issues describe its persisted snapshot. Once the draft diverges, the
      // authoritative draft blockers below decide whether the edited run can proceed.
      if (selectedConfiguration?.status === "needs_attention" && !modified) {
        current.push(...selectedConfiguration.issues.map((issue) => issue.message));
      }
      return [...new Set(current)];
    },
    [effectiveOptions, inputs, model, modified, selectedConfiguration],
  );
  const operationBusy = busy || configBusy || vaultBusy;
  const canLaunch = !!effectiveOptions && (prompt.trim().length > 0 || files.length > 0) && blockers.length === 0 && !operationBusy;

  const stash = (): RunLauncherDraft => ({
    prompt,
    files,
    model,
    inputs: effectiveOptions ? authoritativeInputs(effectiveOptions, inputs) : inputs,
    configurationId: selectedConfigId,
    launchIdempotencyKey: launchIdempotencyRef.current,
    launchPayloadSignature: launchIdempotencyRef.current
      ? options ? launchPayloadSignature : initialDraft?.launchPayloadSignature ?? null
      : null,
  });
  const stashGetterRef = useRef(stash);
  const stashCallbackRef = useRef(onStashDraft);
  stashGetterRef.current = stash;
  stashCallbackRef.current = onStashDraft;

  useEffect(() => {
    mountedRef.current = true;
    // Cancels the synthetic Strict Effects cleanup before its queued stash can escape to the parent.
    pendingUnmountRef.current = null;
    return () => {
      mountedRef.current = false;
      const token = Symbol("launcher-unmount");
      pendingUnmountRef.current = token;
      queueMicrotask(() => {
        if (pendingUnmountRef.current !== token) return;
        if (!skipUnmountStashRef.current && !explicitStashRef.current) {
          stashCallbackRef.current?.(stashGetterRef.current());
        }
        abandonPrewarm();
      });
    };
  }, []);

  const close = () => {
    if (operationBusy) return;
    explicitStashRef.current = true;
    onStashDraft?.(stashGetterRef.current());
    abandonPrewarm();
    onClose();
  };

  const goManageModels = () => {
    explicitStashRef.current = true;
    onStashDraft?.(stashGetterRef.current());
    abandonPrewarm();
    onClose();
    if (onOpenModelSettings) onOpenModelSettings();
    else router.push("/settings?view=models");
  };

  const selectConfiguration = (id: string) => {
    setError(null);
    setConfirmDelete(false);
    setNameMode(null);
    setConfigName("");
    if (!id) {
      setSelectedConfigId(null);
      if (effectiveOptions) {
        setInputs(prefilledInputs(effectiveOptions));
        setModel(effectiveOptions.models.find((item) => item.readiness === "ready")?.model.id ?? "");
      }
      return;
    }
    const configuration = configurations.find((row) => row.id === id);
    if (!configuration || !effectiveOptions) return;
    setSelectedConfigId(configuration.id);
    setModel(configuration.model);
    setInputs(authoritativeInputs(effectiveOptions, configuration.inputs));
  };

  const saveNamedConfiguration = async () => {
    if (!configName.trim() || !effectiveOptions || operationBusy) return;
    setConfigBusy(true);
    setError(null);
    try {
      if (nameMode === "rename" && selectedConfiguration) {
        const updated = await updateRunConfiguration(selectedConfiguration.id, {
          revision: selectedConfiguration.revision,
          name: configName.trim(),
        });
        setConfigurations((rows) => replaceConfiguration(rows, updated));
      } else {
        const created = await createRunConfiguration(slug, {
          name: configName.trim(),
          model,
          inputs: authoritativeInputs(effectiveOptions, inputs),
          is_default: configurations.length === 0,
        });
        setConfigurations((rows) => replaceConfiguration(rows, created));
        setSelectedConfigId(created.id);
      }
      setNameMode(null);
      setConfigName("");
    } catch (cause) {
      setError(configConflictMessage(cause));
    } finally {
      setConfigBusy(false);
    }
  };

  const updateConfiguration = async (patch: "contents" | "default") => {
    if (!selectedConfiguration || !effectiveOptions || configBusy) return;
    setConfigBusy(true);
    setError(null);
    try {
      const updated = await updateRunConfiguration(selectedConfiguration.id, patch === "contents"
        ? {
            revision: selectedConfiguration.revision,
            model,
            inputs: authoritativeInputs(effectiveOptions, inputs),
          }
        : { revision: selectedConfiguration.revision, is_default: true });
      setConfigurations((rows) => rows.map((row) =>
        row.id === updated.id ? updated : patch === "default" ? { ...row, is_default: false } : row,
      ));
    } catch (cause) {
      setError(configConflictMessage(cause));
    } finally {
      setConfigBusy(false);
    }
  };

  const removeConfiguration = async () => {
    if (!selectedConfiguration || configBusy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfigBusy(true);
    setError(null);
    try {
      await deleteRunConfiguration(selectedConfiguration.id, selectedConfiguration.revision);
      setConfigurations((rows) => rows.filter((row) => row.id !== selectedConfiguration.id));
      selectConfiguration("");
    } catch (cause) {
      setError(configConflictMessage(cause));
    } finally {
      setConfigBusy(false);
      setConfirmDelete(false);
    }
  };

  const setSecret = (declaration: RunDeclaredSecret, secretId: string | null) => {
    setInputs((current) => ({
      ...current,
      secrets: [
        ...current.secrets.filter((item) =>
          secretSelectionKey(item.skill_id, item.slot_id) !== secretSelectionKey(declaration.skill_id, declaration.slot_id),
        ),
        ...(secretId ? [{ skill_id: declaration.skill_id, slot_id: declaration.slot_id, secret_id: secretId }] : []),
      ],
    }));
  };

  const setVariable = (declaration: RunDeclaredVariable, value: string | null) => {
    setInputs((current) => ({
      ...current,
      variables: [
        ...current.variables.filter((item) =>
          variableSelectionKey(item.skill_id, item.env_key) !== variableSelectionKey(declaration.skill_id, declaration.env_key),
        ),
        ...(value !== null ? [{ skill_id: declaration.skill_id, env_key: declaration.env_key, value }] : []),
      ],
    }));
  };

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
    if (!canLaunch || !effectiveOptions || submittingRef.current) return;
    const providerCredential = effectiveOptions.models.find((option) => option.model.id === model)?.provider_credential_pin;
    if (!providerCredential) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    const requestKey = launchIdempotencyRef.current ?? crypto.randomUUID();
    launchIdempotencyRef.current = requestKey;
    previousLaunchPayloadRef.current = launchPayloadSignature;
    launchRun(slug, {
      prompt: prompt.trim(),
      model,
      skillVersionId: effectiveOptions.root.skill_version_id,
      dependencyPins: effectiveOptions.dependencies.map(({ skill_id, skill_version_id }) => ({
        skill_id,
        skill_version_id,
      })),
      inputs: authoritativeInputs(effectiveOptions, inputs),
      modelProviderConnectionId: providerCredential.connection_id,
      modelProviderCredentialVersion: providerCredential.credential_version,
      prewarmId: prewarmIdRef.current,
      runConfigId: selectedConfigId,
      files,
      idempotencyKey: requestKey,
    })
      .then((run) => {
        if (!mountedRef.current) return;
        // An adopted ticket ignores cancellation server-side; a late or incompatible ticket is
        // canceled immediately instead of waiting for its browser lease to expire.
        abandonPrewarm();
        prewarmAdoptedRef.current = true;
        skipUnmountStashRef.current = true;
        onLaunched(run);
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Could not start the run.");
        submittingRef.current = false;
        setBusy(false);
      });
  };

  const footer = (
    <>
      {effectiveOptions ? (
        <ModelSelect options={effectiveOptions.models} model={model} onSelectModel={setModel} onManageModels={goManageModels} disabled={operationBusy} />
      ) : <span className="composer__hint">{loadError ? "Run options unavailable" : "Loading models…"}</span>}
      <span className="og-spacer" />
      {files.length < MAX_FILES && (
        <>
          <button type="button" className="composer__attach" title="Attach files" aria-label="Attach files" disabled={operationBusy} onClick={() => fileInputRef.current?.click()}>
            <Icon name="file" size={14} />
          </button>
          <input ref={fileInputRef} type="file" multiple hidden disabled={operationBusy} aria-label="Attach files" onChange={(event) => addFiles(event.target.files)} />
        </>
      )}
      <span className="composer__hint">⌘↵</span>
      <button type="button" className="btn-primary" onClick={launch} disabled={!canLaunch} aria-describedby={blockers.length ? "run-launch-blockers" : undefined}>
        {busy ? "Queueing…" : "Run"}
        {!busy && <Icon name="corner-down-right" size={13} />}
      </button>
    </>
  );

  return (
    <Dialog icon="play" title={`Run ${slug}`} desc="Add a prompt, files, or both. They belong to this run only." onClose={close} closeDisabled={operationBusy} foot={footer} className="og-dialog run-launcher">
      {loadError ? (
        <div className="run-launcher__load-error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn-sec" onClick={loadOptions}>Retry</button>
        </div>
      ) : !effectiveOptions ? (
        <div className="run-launcher__skeleton" aria-label="Loading run options">
          <span /><span /><span />
        </div>
      ) : (
        <>
          <section className="run-config" aria-labelledby="run-config-label">
            <div className="run-config__head">
              <label id="run-config-label" htmlFor="run-configuration">Configuration</label>
              {modified && <span className="run-config__modified">Modified</span>}
              <code className="run-config__version">{effectiveOptions.root.slug}@{effectiveOptions.root.version}</code>
            </div>
            <div className="run-config__select-row">
              <select id="run-configuration" className="sx-input" value={selectedConfigId ?? ""} disabled={operationBusy} onChange={(event) => selectConfiguration(event.target.value)}>
                <option value="">Custom</option>
                {configurations.map((configuration) => (
                  <option value={configuration.id} key={configuration.id}>
                    {configuration.name}{configuration.is_default ? " · Default" : ""}{configuration.status === "needs_attention" ? " · Needs attention" : ""}
                  </option>
                ))}
              </select>
              <div className="run-config__select-actions">
                {selectedConfiguration && (
                  <button type="button" className="btn-sec" disabled={operationBusy} onClick={() => { setNameMode("rename"); setConfigName(selectedConfiguration.name); }}>
                    Rename
                  </button>
                )}
                <button type="button" className="btn-sec" disabled={operationBusy} onClick={() => { setNameMode("save"); setConfigName(""); }}>
                  {selectedConfiguration ? "Save as" : "Save configuration"}
                </button>
              </div>
            </div>
            {selectedConfiguration && (
              <div className="run-config__actions">
                <button type="button" onClick={() => void updateConfiguration("contents")} disabled={operationBusy || !modified}>Update</button>
                {!selectedConfiguration.is_default && <button type="button" onClick={() => void updateConfiguration("default")} disabled={operationBusy}>Set as default</button>}
                <button type="button" className={confirmDelete ? "is-danger" : ""} onClick={() => void removeConfiguration()} disabled={operationBusy}>
                  {confirmDelete ? "Confirm delete" : "Delete"}
                </button>
              </div>
            )}
            {nameMode && (
              <div
                className="run-config__name"
                data-esc-guard
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setNameMode(null);
                  }
                }}
              >
                <label htmlFor="run-config-name">{nameMode === "rename" ? "New name" : "Configuration name"}</label>
                <input
                  id="run-config-name"
                  className="sx-input"
                  value={configName}
                  maxLength={120}
                  autoFocus
                  disabled={operationBusy}
                  onChange={(event) => setConfigName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveNamedConfiguration();
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setNameMode(null);
                    }
                  }}
                />
                <button type="button" className="btn-primary" disabled={operationBusy || !configName.trim()} onClick={() => void saveNamedConfiguration()}>
                  {configBusy ? "Saving…" : "Save"}
                </button>
                <button type="button" className="btn-sec" disabled={operationBusy} onClick={() => setNameMode(null)}>Cancel</button>
              </div>
            )}
            {selectedConfiguration?.issues.length && !modified ? (
              <ul className="run-config__issues" role="status">
                {selectedConfiguration.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}
              </ul>
            ) : null}
          </section>

          <div className="composer__box composer__box--launch">
            <label className="run-launcher__prompt-label" htmlFor="run-prompt">Prompt</label>
            <textarea
              id="run-prompt"
              className="composer__input composer__input--launch"
              value={prompt}
              autoFocus
              rows={4}
              maxLength={8000}
              disabled={busy}
              placeholder={`What should ${slug} do? You can also attach files without a prompt.`}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  launch();
                }
              }}
            />
            {files.length > 0 && (
              <div className="launch-files">
                {files.map((file, index) => (
                  <span className="launch-file" key={`${file.name}-${file.size}-${index}`}>
                    <Icon name="file" size={12} />
                    <span className="launch-file__name">{file.name}</span>
                    <span className="launch-file__size">{formatBytes(file.size)}</span>
                    <button type="button" className="launch-file__x" disabled={busy} aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, itemIndex) => itemIndex !== index))}>
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {groups.length > 0 && (
            <section className="run-inputs" aria-labelledby="run-inputs-title">
              <div className="run-inputs__intro">
                <div>
                  <h4 id="run-inputs-title">Secrets &amp; variables</h4>
                  <p>Only manifest-declared inputs can be injected. Non-secret variables remain visible in your private configuration and run history.</p>
                </div>
              </div>
              {groups.map((group) => (
                <details className="run-input-group" key={group.skill.skill_version_id} open={group.skill.root || group.secrets.some((item) => item.required) || group.variables.some((item) => item.required)}>
                  <summary>
                    <span><code>{group.skill.slug}@{group.skill.version}</code>{group.skill.root && <b>Root</b>}</span>
                    <small>{group.secrets.length + group.variables.length} inputs</small>
                  </summary>
                  <div className="run-input-group__body">
                    {group.secrets.map((declaration) => {
                      const selection = inputs.secrets.find((item) =>
                        secretSelectionKey(item.skill_id, item.slot_id) === secretSelectionKey(declaration.skill_id, declaration.slot_id),
                      );
                      const references = declaration.candidates.map(asReference);
                      for (const created of createdSecrets) if (!references.some((item) => item.id === created.id)) references.push(created);
                      return (
                        <VaultSecretField
                          key={declaration.slot_id}
                          orgId={orgId}
                          envKey={declaration.env_key}
                          label={declaration.env_key}
                          required={declaration.required}
                          candidates={references}
                          value={selection?.secret_id ?? null}
                          unavailable={!!selection && !references.some((candidate) => candidate.id === selection.secret_id)}
                          disabled={busy || configBusy || vaultBusy}
                          onChange={(secretId) => setSecret(declaration, secretId)}
                          onCreated={(secret) => setCreatedSecrets((rows) => rows.some((row) => row.id === secret.id) ? rows : [...rows, secret])}
                          onBusyChange={setVaultBusy}
                          helper={declaration.description || `Injected into ${declaration.skill_slug} only for this run.`}
                        />
                      );
                    })}
                    {group.variables.map((declaration) => {
                      const selection = inputs.variables.find((item) =>
                        variableSelectionKey(item.skill_id, item.env_key) === variableSelectionKey(declaration.skill_id, declaration.env_key),
                      );
                      const fieldId = `run-var-${declaration.skill_id}-${declaration.env_key}`;
                      const requiredMissing = declaration.required && !selection;
                      return (
                        <div className="run-variable" key={declaration.env_key}>
                          <div className="run-variable__head">
                            <label htmlFor={fieldId}><code>{declaration.env_key}</code> {declaration.required ? <span>Required</span> : <small>Optional</small>}</label>
                            {!declaration.required && (
                              <label className="run-variable__include">
                                <input type="checkbox" checked={!!selection} disabled={operationBusy} onChange={(event) => setVariable(declaration, event.target.checked ? "" : null)} /> Include
                              </label>
                            )}
                          </div>
                          <input
                            id={fieldId}
                            className="sx-input mono"
                            value={selection?.value ?? ""}
                            disabled={operationBusy || (!declaration.required && !selection)}
                            aria-invalid={requiredMissing || undefined}
                            aria-describedby={`${fieldId}-hint${requiredMissing ? ` ${fieldId}-error` : ""}`}
                            onChange={(event) => setVariable(declaration, event.target.value)}
                          />
                          <p id={`${fieldId}-hint`}>{declaration.description || "Visible in your private saved configuration and run history."}</p>
                          {requiredMissing && <p className="vault-field__error" id={`${fieldId}-error`}>{declaration.env_key} is required.</p>}
                        </div>
                      );
                    })}
                  </div>
                </details>
              ))}
            </section>
          )}

          {blockers.length > 0 && (
            <ul className="run-launcher__blockers" id="run-launch-blockers" role="alert">
              {blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul>
          )}
          {error && <p className="composer__error" role="alert">{error}</p>}
        </>
      )}
    </Dialog>
  );
}
