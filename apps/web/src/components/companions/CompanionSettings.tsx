"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  Companion,
  CompanionProvidersResponse,
} from "@companion/contracts";
import type { RestartCompanionRuntimeInput } from "@companion/contracts/companion-runtime";
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
  const [runtimeNeedsRefresh, setRuntimeNeedsRefresh] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [hidden, setHidden] = useState(companion.hidden);
  // Freshest row this view has seen, for the skills sync line: save responses land here, and while
  // an apply is in flight on an awake Box a short poll keeps it moving without waking anything.
  const [latest, setLatest] = useState(companion);
  const syncReadRef = useRef(0);
  const canEdit = companion.access === "owner" || companion.access === "editor";
  const canDelete = companion.access === "owner";
  const online = runtimeSnapshot.state === "running" && runtimeSnapshot.daemon_state === "running";

  useEffect(() => {
    setRuntimeSnapshot(companion.runtime);
    setRuntimeNeedsRefresh(false);
  }, [companion.runtime]);

  useEffect(() => {
    setLatest(companion);
  }, [companion]);

  const skillsPending = latest.runtime.skills_applied_revision < latest.runtime.skills_revision;
  // A recorded restage failure will not clear on its own — only the next start or save retries it —
  // so it stops the poll rather than reading the same answer forever.
  const skillsApplying = skillsPending
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
    if (!canEdit || !name.trim() || !providerId || !modelId || !changed) return;
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
    try {
      await deleteCompanion(orgId, companion.id);
      onDeleted(companion.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This Companion could not be deleted.");
      setConfirmingDelete(false);
      setBusy(false);
    }
  };

  const restart = async (target: RestartCompanionRuntimeInput["target"]) => {
    if (!canEdit || !online || changed) return;
    setBusy(true);
    setRestarting(target);
    setError(null);
    setRuntimeMessage(null);
    try {
      const updated = await restartCompanionRuntime(orgId, companion.id, { target });
      setRuntimeSnapshot(updated.runtime);
      setRuntimeNeedsRefresh(false);
      onSaved(updated);
      setRuntimeMessage(target === "pi"
        ? "Pi restarted. The Box stayed online."
        : "The full Box restarted and is online.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This Companion could not be restarted.");
      setRuntimeNeedsRefresh(true);
      try {
        // Restart can persist a corrected stopped/error projection before returning a failure. Read
        // that projection without live Box access so Settings never keeps advertising an action the
        // control plane has just proved unavailable.
        const latest = await getCompanionRuntime(orgId, companion.id);
        setRuntimeSnapshot(latest.runtime);
        setRuntimeNeedsRefresh(false);
        onSaved(latest);
      } catch {
        // Keep restart disabled when the projection itself cannot be reconciled. Reopening Settings
        // creates a fresh view from the roster instead of inviting repeated conflicts.
      }
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
        {error && <div className="companions-error" role="alert">{error}</div>}
        {saved && <div className="companions-settings__saved" role="status">Settings saved.</div>}
        {runtimeMessage && (
          <div className="companions-settings__saved" role="status">{runtimeMessage}</div>
        )}

        <form className="companions-settings__form" onSubmit={submit}>
          <label>
            Name
            <input
              name="name"
              required
              maxLength={120}
              value={name}
              disabled={!canEdit || busy}
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
              disabled={!canEdit || busy}
              aria-describedby="companion-instructions-hint"
              onChange={(event) => {
                setInstructions(event.target.value);
                setSaved(false);
              }}
            />
          </label>
          <p className="companions-settings__hint" id="companion-instructions-hint">
            Applied the next time this Companion starts.
          </p>

          <CompanionProviderModelPicker
            providers={providers}
            providerId={providerId}
            modelId={modelId}
            namePrefix="companion-settings"
            descriptionId="companion-provider-hint"
            disabled={!canEdit || busy}
            onChange={(selection) => {
              setProviderId(selection.providerId);
              setModelId(selection.modelId);
              setSaved(false);
            }}
          />
          <p className="companions-settings__hint" id="companion-provider-hint">
            If Online, changing provider, model, skills, or plugins recycles Pi. The Box stays online.
          </p>

          <CompanionSkillPicker
            orgId={orgId}
            selectedSkillIds={selectedSkillIds}
            canWriteSkills={canWriteSkills}
            disabled={!canEdit || busy}
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
            disabled={!canEdit || busy}
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
                disabled={busy || !changed || !name.trim() || !providerId || !modelId}
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
              disabled={busy || changed || !online || runtimeNeedsRefresh}
              aria-describedby="restart-companion-hint"
            >
              <legend className="sr-only">Restart scope</legend>
              <label>
                <input
                  type="radio"
                  name="restart-target"
                  value="pi"
                  checked={restartTarget === "pi"}
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
                  onChange={() => setRestartTarget("box")}
                />
                <span>
                  <strong>Full Box</strong>
                  <small>Archives and resumes the server, interrupting active work.</small>
                </span>
              </label>
            </fieldset>

            <div className="companions-settings__restart-action">
              <p className="companions-settings__hint" id="restart-companion-hint">
                {runtimeNeedsRefresh
                  ? "Runtime status could not be refreshed. Reopen Settings before trying again."
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
                disabled={busy || changed || !online || runtimeNeedsRefresh}
                onClick={() => {
                  if (restartTarget === "box") setConfirmingBoxRestart(true);
                  else void restart("pi");
                }}
              >
                {restarting === "pi"
                  ? "Restarting Pi..."
                  : restarting === "box"
                    ? "Restarting Box..."
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
              disabled={busy}
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
              <p>Archives its Box and removes it permanently. This cannot be undone.</p>
            </div>
            <button
              type="button"
              className="cds-btn cds-btn--danger cds-btn--md"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete Companion
            </button>
          </section>
        )}
      </div>

      {confirmingDelete && (
        <Dialog
          icon="trash-2"
          title={`Delete ${companion.name}?`}
          desc="Its Box will be stopped and archived. This Companion cannot be restored."
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
          desc="This stops and archives the server before resuming it. Any active work is interrupted, but the Companion and its saved files remain."
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
