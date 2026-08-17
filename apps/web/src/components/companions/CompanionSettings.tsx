"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  Companion,
  CompanionProvidersResponse,
} from "@companion/contracts";
import type { RestartCompanionRuntimeInput } from "@companion/contracts/companion-runtime";
import { ApiFetchError } from "@/lib/apiClient";
import {
  deleteCompanion,
  getCompanionRuntime,
  restartCompanionRuntime,
  updateCompanion,
  updateCompanionMemberState,
} from "@/lib/companions";
import { Icon } from "../Icon";
import { Dialog } from "../org/primitives";
import {
  CompanionProviderModelPicker,
  providerSelectedModel,
  validProviderSelection,
} from "./CompanionProviderModelPicker";
import { CompanionSkillPicker } from "./CompanionSkillPicker";
import { CompanionPluginPicker } from "./CompanionPluginPicker";
import { CompanionSkillsSyncStatus } from "./CompanionSkillsSyncStatus";

/** How often to re-read the control-plane row while a skill apply is in flight on an awake Box. */
const SKILLS_SYNC_POLL_MS = 3_000;
/** A stalled apply stops moving on its own; cap the poll instead of reading forever. */
const SKILLS_SYNC_POLL_MAX_TICKS = 40;

export function CompanionSettings({
  orgId,
  companion,
  providers,
  onBack,
  onSaved,
  onDeleted,
}: {
  orgId: string;
  companion: Companion;
  providers: CompanionProvidersResponse;
  onBack: () => void;
  onSaved: (companion: Companion) => void;
  onDeleted: (companionId: string) => void;
}) {
  const initialProviderId = companion.runtime.provider_ids[0] ?? "";
  const [name, setName] = useState(companion.name);
  const [instructions, setInstructions] = useState(companion.persona ?? "");
  const [providerId, setProviderId] = useState(initialProviderId);
  const [modelId, setModelId] = useState(
    providerSelectedModel(providers, initialProviderId, companion.model_id),
  );
  const [selectedSkillIds, setSelectedSkillIds] = useState(companion.selected_skill_ids);
  const [canWriteSkills, setCanWriteSkills] = useState(companion.can_write_skills);
  const [selectedMcpAccountIds, setSelectedMcpAccountIds] = useState(
    companion.selected_mcp_account_ids,
  );
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingBoxRestart, setConfirmingBoxRestart] = useState(false);
  const [restartTarget, setRestartTarget] = useState<RestartCompanionRuntimeInput["target"]>("pi");
  const [restarting, setRestarting] = useState<RestartCompanionRuntimeInput["target"] | null>(null);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState(companion.runtime);
  const [latestOperation, setLatestOperation] = useState(companion.runtime.latest_operation ?? null);
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [hidden, setHidden] = useState(companion.hidden);
  // Freshest row this view has seen, for the skills sync line: save responses land here, and while
  // an apply is in flight on an awake Box a short poll keeps it moving without waking anything.
  const [latest, setLatest] = useState(companion);
  const syncReadRef = useRef(0);
  const deleteRequestIdRef = useRef<string | null>(null);
  const restartRequestIdRef = useRef<
    Partial<Record<RestartCompanionRuntimeInput["target"], string>>
  >({});
  const onSavedRef = useRef(onSaved);
  const onDeletedRef = useRef(onDeleted);
  onSavedRef.current = onSaved;
  onDeletedRef.current = onDeleted;
  const canEdit = companion.access === "owner" || companion.access === "editor";
  const canDelete = companion.access === "owner";
  const online = runtimeSnapshot.state === "running" && runtimeSnapshot.daemon_state === "running";

  useEffect(() => {
    setRuntimeSnapshot(companion.runtime);
    const nextOperation = companion.runtime.latest_operation ?? null;
    setLatestOperation(nextOperation);
    if (nextOperation !== null
      && nextOperation.status !== "pending"
      && nextOperation.status !== "running") {
      setRuntimeMessage(null);
    }
  }, [companion.runtime]);

  useEffect(() => {
    const selection = validProviderSelection(providers, providerId, modelId);
    if (selection.providerId !== providerId) setProviderId(selection.providerId);
    if (selection.modelId !== modelId) setModelId(selection.modelId);
  }, [modelId, providerId, providers]);

  useEffect(() => {
    setLatest(companion);
  }, [companion]);

  const operationActive = latestOperation !== null
    && (latestOperation.status === "pending" || latestOperation.status === "running");
  const pendingRestartTarget: RestartCompanionRuntimeInput["target"] | null = operationActive
    ? latestOperation.kind === "restart_pi"
      ? "pi"
      : latestOperation.kind === "restart_box"
        ? "box"
        : null
    : null;
  const deletionActive = operationActive && latestOperation?.kind === "delete";
  const deletionRetryable = latestOperation?.kind === "delete"
    && (latestOperation.status === "failed"
      || latestOperation.status === "interrupted"
      || latestOperation.status === "cancelled");
  const durableOperationMessage = operationActive
    ? latestOperation.kind === "delete"
      ? "Deletion is queued. This Companion remains until its Box is permanently deleted."
      : latestOperation.kind === "stop"
        ? "Stop is in progress. Status refreshes every three seconds."
        : latestOperation.kind === "restart_pi"
          ? "Pi restart is in progress. Status refreshes every three seconds."
          : latestOperation.kind === "restart_box"
            ? "Full Box restart is in progress. Status refreshes every three seconds."
            : latestOperation.kind === "start"
              ? "Start is in progress. Status refreshes every three seconds."
              : "Settings are being applied. Status refreshes every three seconds."
    : null;
  const lifecycleActive = operationActive
    || runtimeSnapshot.state === "provisioning"
    || runtimeSnapshot.state === "stopping";
  useEffect(() => {
    if (!lifecycleActive || deletionActive) return;
    let active = true;
    const read = async () => {
      try {
        const next = await getCompanionRuntime(orgId, companion.id);
        if (!active) return;
        setError(null);
        setRuntimeSnapshot(next.runtime);
        const nextOperation = next.runtime.latest_operation ?? null;
        setLatestOperation(nextOperation);
        if (nextOperation !== null
          && nextOperation.status !== "pending"
          && nextOperation.status !== "running") {
          setRuntimeMessage(null);
        }
        setLatest(next);
        onSavedRef.current(next);
        if (pendingRestartTarget === null
          || next.runtime.state === "provisioning"
          || next.runtime.state === "stopping") return;
        if (next.runtime.state === "error") {
          setError(next.runtime.last_error ?? "The accepted restart failed. Retry when it is safe.");
          setRuntimeMessage(null);
          return;
        }
        if (nextOperation !== null
          && ["failed", "interrupted", "cancelled"].includes(nextOperation.status)) return;
        setRuntimeMessage(pendingRestartTarget === "pi"
          ? "Pi restart completed."
          : "Full Box restart completed.");
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error
          ? `Restart status could not be refreshed: ${cause.message}`
          : "Restart status could not be refreshed.");
      }
    };
    const timer = setInterval(() => void read(), SKILLS_SYNC_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [companion.id, deletionActive, lifecycleActive, orgId, pendingRestartTarget]);

  const skillsPending = latest.runtime.skills_applied_revision < latest.runtime.skills_revision;
  // A recorded restage failure will not clear on its own — only the next start or save retries it —
  // so it stops the poll rather than reading the same answer forever.
  const skillsApplying = skillsPending
    && !deletionActive
    && !latest.runtime.skills_last_error
    && (latest.runtime.state === "provisioning" || latest.runtime.state === "running");
  useEffect(() => {
    if (!skillsApplying) return;
    let ticks = 0;
    const interval = setInterval(() => {
      if (++ticks > SKILLS_SYNC_POLL_MAX_TICKS) {
        clearInterval(interval);
        return;
      }
      const readId = ++syncReadRef.current;
      void getCompanionRuntime(orgId, companion.id)
        .then((next) => {
          if (readId !== syncReadRef.current) return;
          setLatest(next);
        })
        .catch(() => undefined);
    }, SKILLS_SYNC_POLL_MS);
    return () => clearInterval(interval);
  }, [skillsApplying, orgId, companion.id]);

  // Permanent deletion is asynchronous. Keep this surface until PostgreSQL confirms the row is
  // gone, so a queued operation is never presented as if external Box deletion already succeeded.
  useEffect(() => {
    if (!deletionActive) return;
    let active = true;
    const read = async () => {
      try {
        const next = await getCompanionRuntime(orgId, companion.id);
        if (!active) return;
        setError(null);
        setRuntimeSnapshot(next.runtime);
        const nextOperation = next.runtime.latest_operation ?? null;
        setLatestOperation(nextOperation);
        if (nextOperation !== null
          && nextOperation.status !== "pending"
          && nextOperation.status !== "running") {
          setRuntimeMessage(null);
        }
        setLatest(next);
        onSavedRef.current(next);
      } catch (cause) {
        if (!active) return;
        if (cause instanceof ApiFetchError && cause.status === 404) {
          onDeletedRef.current(companion.id);
          return;
        }
        setError(cause instanceof Error
          ? `Deletion is still queued, but its status could not be refreshed: ${cause.message}`
          : "Deletion is still queued, but its status could not be refreshed.");
      }
    };
    void read();
    const timer = setInterval(() => void read(), SKILLS_SYNC_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [companion.id, deletionActive, orgId]);

  const changed = useMemo(
    () =>
      name.trim() !== companion.name
      || instructions.trim() !== (companion.persona ?? "")
      || providerId !== (companion.runtime.provider_ids[0] ?? "")
      || modelId !== companion.model_id
      || canWriteSkills !== companion.can_write_skills
      || selectedSkillIds.length !== companion.selected_skill_ids.length
      || selectedSkillIds.some((id, index) => id !== companion.selected_skill_ids[index])
      || selectedMcpAccountIds.length !== companion.selected_mcp_account_ids.length
      || selectedMcpAccountIds.some((id, index) => id !== companion.selected_mcp_account_ids[index]),
    [
      canWriteSkills,
      companion,
      instructions,
      modelId,
      name,
      providerId,
      selectedMcpAccountIds,
      selectedSkillIds,
    ],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canEdit || deletionActive || !name.trim() || !providerId || !modelId || !changed) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateCompanion(orgId, companion.id, {
        name: name.trim(),
        persona: instructions.trim() || null,
        provider_id: providerId,
        model_id: modelId,
        selected_skill_ids: selectedSkillIds,
        can_write_skills: canWriteSkills,
        selected_mcp_account_ids: selectedMcpAccountIds,
      });
      onSaved(updated);
      syncReadRef.current += 1;
      setLatest(updated);
      setName(updated.name);
      setInstructions(updated.persona ?? "");
      const updatedProviderId = updated.runtime.provider_ids[0] ?? "";
      setProviderId(updatedProviderId);
      setModelId(providerSelectedModel(providers, updatedProviderId, updated.model_id));
      setSelectedSkillIds(updated.selected_skill_ids);
      setCanWriteSkills(updated.can_write_skills);
      setSelectedMcpAccountIds(updated.selected_mcp_account_ids);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Companion settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!canDelete) return;
    setBusy(true);
    setError(null);
    const requestId = deleteRequestIdRef.current ?? crypto.randomUUID();
    deleteRequestIdRef.current = requestId;
    try {
      const operation = await deleteCompanion(orgId, companion.id, requestId);
      deleteRequestIdRef.current = null;
      setConfirmingDelete(false);
      setLatestOperation(operation);
      setRuntimeMessage(
        "Deletion accepted. This Companion remains visible until its Box is permanently deleted.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This Companion could not be deleted.");
      setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  };

  const restart = async (target: RestartCompanionRuntimeInput["target"]) => {
    if (!canEdit || changed || !online || deletionActive || pendingRestartTarget !== null) return;
    setBusy(true);
    setRestarting(target);
    setError(null);
    setRuntimeMessage(null);
    const requestId = restartRequestIdRef.current[target] ?? crypto.randomUUID();
    restartRequestIdRef.current[target] = requestId;
    try {
      const operation = await restartCompanionRuntime(orgId, companion.id, { target }, requestId);
      delete restartRequestIdRef.current[target];
      setLatestOperation(operation);
      setRuntimeMessage(target === "pi"
        ? "Pi restart accepted. It will run after earlier runtime work."
        : "Full Box restart accepted. It will run after earlier runtime work.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This Companion could not be restarted.");
    } finally {
      setBusy(false);
      setRestarting(null);
      setConfirmingBoxRestart(false);
    }
  };

  return (
    <section className="companions-settings" aria-labelledby="companion-settings-title">
      <header className="companions-head companions-settings__head">
        <div className="companions-settings__title">
          <button type="button" className="iconbtn" aria-label="Back to Companions" onClick={onBack}>
            <Icon name="arrow-left" size={16} />
          </button>
          <div>
            <h1 id="companion-settings-title">Companion settings</h1>
            <p>{companion.name}</p>
          </div>
        </div>
      </header>

      <div className="companions-content companions-settings__content">
        {(error ?? latestOperation?.error?.message) && (
          <div className="companions-error" role="alert">
            {error ?? latestOperation?.error?.message}
          </div>
        )}
        {saved && <div className="companions-settings__saved" role="status">Settings saved.</div>}
        {(runtimeMessage ?? durableOperationMessage) && (
          <div className="companions-settings__saved" role="status">
            {runtimeMessage ?? durableOperationMessage}
          </div>
        )}

        <form className="companions-settings__form" onSubmit={submit}>
          <label>
            Name
            <input
              name="name"
              required
              maxLength={120}
              value={name}
              disabled={!canEdit || busy || deletionActive}
              onChange={(event) => {
                setName(event.target.value);
                setSaved(false);
              }}
            />
          </label>

          <label>
            Instructions
            <textarea
              name="instructions"
              maxLength={280}
              rows={4}
              value={instructions}
              disabled={!canEdit || busy || deletionActive}
              aria-describedby="companion-instructions-hint"
              onChange={(event) => {
                setInstructions(event.target.value);
                setSaved(false);
              }}
            />
          </label>
          <p className="companions-settings__hint" id="companion-instructions-hint">
            Applied after the active turn settles and before the next turn starts.
          </p>

          <CompanionProviderModelPicker
            providers={providers}
            providerId={providerId}
            modelId={modelId}
            namePrefix="companion-settings"
            descriptionId="companion-provider-hint"
            disabled={!canEdit || busy || deletionActive}
            onChange={(selection) => {
              setProviderId(selection.providerId);
              setModelId(selection.modelId);
              setSaved(false);
            }}
          />
          <p className="companions-settings__hint" id="companion-provider-hint">
            Provider, model, skills, and plugin changes are applied in order between turns.
          </p>

          <CompanionSkillPicker
            orgId={orgId}
            selectedSkillIds={selectedSkillIds}
            canWriteSkills={canWriteSkills}
            disabled={!canEdit || busy || deletionActive}
            footer={<CompanionSkillsSyncStatus companion={latest} />}
            onSelectedSkillIdsChange={(ids) => {
              setSelectedSkillIds(ids);
              setSaved(false);
            }}
            onCanWriteSkillsChange={(value) => {
              setCanWriteSkills(value);
              setSaved(false);
            }}
          />

          <CompanionPluginPicker
            orgId={orgId}
            selectedMcpAccountIds={selectedMcpAccountIds}
            disabled={!canEdit || busy || deletionActive}
            onSelectedMcpAccountIdsChange={(ids) => {
              setSelectedMcpAccountIds(ids);
              setSaved(false);
            }}
          />

          {canEdit && (
            <div className="companions-settings__actions">
              <button
                type="submit"
                className="cds-btn cds-btn--primary cds-btn--md"
                disabled={busy || deletionActive || !changed || !name.trim() || !providerId || !modelId}
              >
                {busy ? "Saving..." : "Save changes"}
              </button>
            </div>
          )}
        </form>

        {canEdit && (
          <section className="companions-settings__runtime" aria-labelledby="restart-companion-title">
            <div>
              <h2 id="restart-companion-title">Restart Companion</h2>
              <p>Restart Pi for a fresh agent process, or restart the full Box for server-level recovery.</p>
            </div>

            <fieldset
              className="companions-settings__restart-options"
              disabled={busy || changed || deletionActive || pendingRestartTarget !== null}
              aria-describedby="restart-companion-hint"
            >
              <legend className="sr-only">Restart scope</legend>
              <label>
                <input
                  type="radio"
                  name="restart-target"
                  value="pi"
                  checked={restartTarget === "pi"}
                  disabled={!online}
                  onChange={() => setRestartTarget("pi")}
                />
                <span>
                  <strong>Pi only</strong>
                  <small>Restarts the agent process. The Box stays online.</small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="restart-target"
                  value="box"
                  checked={restartTarget === "box"}
                  disabled={!online}
                  onChange={() => setRestartTarget("box")}
                />
                <span>
                  <strong>Full Box</strong>
                  <small>Restarts the server and interrupts active work.</small>
                </span>
              </label>
            </fieldset>

            <div className="companions-settings__restart-action">
              <p className="companions-settings__hint" id="restart-companion-hint">
                {deletionActive
                  ? "Companion deletion is in progress. Runtime controls are unavailable."
                  : pendingRestartTarget !== null
                    ? "The accepted restart is still running. Status refreshes every three seconds."
                  : !online
                    ? "This Companion must be Online before it can restart. Send a message to start it."
                    : changed
                      ? "Save your changes before restarting."
                      : restartTarget === "pi"
                        ? "Pi restarts with the saved provider, model, skills, and plugins."
                        : "Full Box restart requires confirmation."}
              </p>
              <button
                type="button"
                className="cds-btn cds-btn--secondary cds-btn--md"
                disabled={
                  busy
                  || changed
                  || deletionActive
                  || pendingRestartTarget !== null
                  || !online
                }
                onClick={() => {
                  if (restartTarget === "box") setConfirmingBoxRestart(true);
                  else void restart("pi");
                }}
              >
                {restarting === "pi"
                  ? "Restarting Pi..."
                  : restarting === "box"
                    ? "Restarting Box..."
                    : pendingRestartTarget !== null
                      ? "Restart queued..."
                    : restartTarget === "pi"
                      ? "Restart Pi"
                      : "Restart full Box"}
              </button>
            </div>
          </section>
        )}

        {hidden && (
          <section className="companions-settings__danger" aria-labelledby="unhide-companion-title">
            <div>
              <h2 id="unhide-companion-title">Hidden from your list</h2>
              <p>This Companion stays available. Unhide it to put it back in your Companions list.</p>
            </div>
            <button
              type="button"
              className="cds-btn cds-btn--secondary cds-btn--md"
              disabled={busy || deletionActive}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const next = await updateCompanionMemberState(orgId, companion.id, {
                    hidden: false,
                  });
                  setHidden(false);
                  onSaved(next);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Could not unhide this Companion.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Unhide
            </button>
          </section>
        )}

        {canDelete && (
          <section className="companions-settings__danger" aria-labelledby="delete-companion-title">
            <div>
              <h2 id="delete-companion-title">Delete Companion</h2>
              <p>Permanently deletes its Box and transcript. This cannot be undone.</p>
            </div>
            <button
              type="button"
              className="cds-btn cds-btn--danger cds-btn--md"
              disabled={busy || deletionActive}
              onClick={() => setConfirmingDelete(true)}
            >
              {deletionActive
                ? "Deletion requested"
                : deletionRetryable
                  ? "Retry Delete"
                  : "Delete Companion"}
            </button>
          </section>
        )}
      </div>

      {confirmingDelete && (
        <Dialog
          icon="trash-2"
          title={`Delete ${companion.name}?`}
          desc="Its Box, thread, and Companion record will be permanently deleted after runtime confirmation. This cannot be undone."
          onClose={() => setConfirmingDelete(false)}
          closeDisabled={busy}
          className="og-dialog companions-delete-dialog"
          foot={(
            <>
              <button
                type="button"
                className="cds-btn cds-btn--secondary cds-btn--md"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cds-btn cds-btn--danger cds-btn--md"
                disabled={busy}
                onClick={() => void remove()}
              >
                {busy ? "Deleting..." : "Delete Companion"}
              </button>
            </>
          )}
        />
      )}

      {confirmingBoxRestart && (
        <Dialog
          icon="refresh-cw"
          title={`Restart ${companion.name}'s full Box?`}
          desc="This queues a full server restart. Any active work is interrupted, but the Companion and its saved files remain."
          onClose={() => setConfirmingBoxRestart(false)}
          closeDisabled={busy}
          className="og-dialog companions-restart-dialog"
          foot={(
            <>
              <button
                type="button"
                className="cds-btn cds-btn--secondary cds-btn--md"
                disabled={busy}
                onClick={() => setConfirmingBoxRestart(false)}
              >
                Keep Box running
              </button>
              <button
                type="button"
                className="cds-btn cds-btn--primary cds-btn--md"
                disabled={busy}
                onClick={() => void restart("box")}
              >
                {restarting === "box" ? "Restarting Box..." : "Restart full Box"}
              </button>
            </>
          )}
        />
      )}
    </section>
  );
}
