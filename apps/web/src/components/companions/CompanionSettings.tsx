"use client";

import { type FormEvent, useMemo, useState } from "react";
import type { Companion, CompanionProvidersResponse } from "@companion/contracts";
import { deleteCompanion, updateCompanion } from "@/lib/companions";
import { Icon } from "../Icon";
import { Dialog } from "../org/primitives";
import {
  CompanionProviderModelPicker,
  providerSelectedModel,
} from "./CompanionProviderModelPicker";
import { CompanionSkillPicker } from "./CompanionSkillPicker";

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
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const canEdit = companion.access === "owner" || companion.access === "editor";
  const canDelete = companion.access === "owner";

  const changed = useMemo(
    () =>
      name.trim() !== companion.name
      || instructions.trim() !== (companion.persona ?? "")
      || providerId !== (companion.runtime.provider_ids[0] ?? "")
      || modelId !== companion.model_id
      || canWriteSkills !== companion.can_write_skills
      || selectedSkillIds.length !== companion.selected_skill_ids.length
      || selectedSkillIds.some((id, index) => id !== companion.selected_skill_ids[index]),
    [canWriteSkills, companion, instructions, modelId, name, providerId, selectedSkillIds],
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
      });
      onSaved(updated);
      setName(updated.name);
      setInstructions(updated.persona ?? "");
      const updatedProviderId = updated.runtime.provider_ids[0] ?? "";
      setProviderId(updatedProviderId);
      setModelId(providerSelectedModel(providers, updatedProviderId, updated.model_id));
      setSelectedSkillIds(updated.selected_skill_ids);
      setCanWriteSkills(updated.can_write_skills);
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
            If Online, changing provider, model, or skills recycles Pi. The Box stays online.
          </p>

          <CompanionSkillPicker
            orgId={orgId}
            selectedSkillIds={selectedSkillIds}
            canWriteSkills={canWriteSkills}
            disabled={!canEdit || busy}
            onSelectedSkillIdsChange={(ids) => {
              setSelectedSkillIds(ids);
              setSaved(false);
            }}
            onCanWriteSkillsChange={(value) => {
              setCanWriteSkills(value);
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
    </section>
  );
}
