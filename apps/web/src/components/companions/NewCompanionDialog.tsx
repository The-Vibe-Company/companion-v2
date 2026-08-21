"use client";

import { type FormEvent, useEffect, useState } from "react";
import type { Companion, CompanionProvidersResponse } from "@companion/contracts";
import { createCompanion } from "@/lib/companions";
import { Dialog } from "../org/primitives";
import {
  CompanionProviderModelPicker,
  providerDefaultModel,
  validProviderSelection,
} from "./CompanionProviderModelPicker";
import { CompanionSkillPicker } from "./CompanionSkillPicker";
import { CompanionPluginPicker } from "./CompanionPluginPicker";
import {
  CompanionIconPicker,
  randomIcon,
  type CompanionIconValue,
} from "./CompanionIconPicker";

/**
 * Creation asks for name, persona, provider/model, which Skills Hub packages this Companion may
 * use, and which already-connected MCP plugins it may stage onto its Box. Skills Hub API access is
 * unconditional, so there is nothing to choose about it here.
 */
export function NewCompanionDialog({
  orgId,
  providers,
  onCreated,
  onConnectProvider,
  onClose,
}: {
  orgId: string;
  providers: CompanionProvidersResponse;
  onCreated: (companion: Companion) => void;
  onConnectProvider: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const initialProviderId = providers.connections.some(
    (connection) => connection.provider_id === providers.default_provider_id,
  )
    ? providers.default_provider_id ?? ""
    : providers.connections[0]?.provider_id ?? "";
  const [providerId, setProviderId] = useState(initialProviderId);
  const [modelId, setModelId] = useState(providerDefaultModel(providers, initialProviderId));
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [selectedMcpAccountIds, setSelectedMcpAccountIds] = useState<string[]>([]);
  const [icon, setIcon] = useState<CompanionIconValue>(randomIcon);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const selection = validProviderSelection(providers, providerId, modelId);
    if (selection.providerId !== providerId) setProviderId(selection.providerId);
    if (selection.modelId !== modelId) setModelId(selection.modelId);
  }, [modelId, providerId, providers]);

  const connected = providers.connections.length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !providerId || !modelId) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createCompanion(orgId, {
        name: name.trim(),
        persona: persona.trim() || undefined,
        provider_id: providerId,
        model_id: modelId,
        selected_skill_ids: selectedSkillIds,
        selected_mcp_account_ids: selectedMcpAccountIds,
        icon,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Companion could not be created.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      icon="bot"
      title="New companion"
      desc="A name, one line about what it does, the provider and model it runs on, then the skills and plugins it may use."
      onClose={onClose}
      closeDisabled={busy}
      className="og-dialog companions-new-dialog"
      foot={(
        <>
          <button
            type="button"
            className="cds-btn cds-btn--secondary cds-btn--md"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="companion-create"
            className="cds-btn cds-btn--primary cds-btn--md"
            disabled={busy || !connected || !name.trim() || !providerId || !modelId}
          >
            {busy ? "Creating..." : "Create companion"}
          </button>
        </>
      )}
    >
      {error && <div className="companions-error" role="alert">{error}</div>}
      <form id="companion-create" className="companions-new-form" onSubmit={submit}>
        <label>
          Name
          <input
            autoFocus
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Luna"
          />
        </label>
        <label>
          Persona
          <input
            maxLength={280}
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
            placeholder="Content marketing assistant"
            aria-describedby="companion-persona-hint"
          />
        </label>
        <p className="companions-new-form__hint" id="companion-persona-hint">
          One line, shown under the name in the list.
        </p>
        <CompanionIconPicker value={icon} onChange={setIcon} />
        {connected ? (
          <CompanionProviderModelPicker
            providers={providers}
            providerId={providerId}
            modelId={modelId}
            namePrefix="companion-create"
            disabled={busy}
            onChange={(selection) => {
              setProviderId(selection.providerId);
              setModelId(selection.modelId);
            }}
          />
        ) : (
          <p className="companions-picker__empty">
            {providers.can_manage ? (
              <>
                No provider is connected yet.{" "}
                <button type="button" className="cds-link" onClick={onConnectProvider}>
                  Connect one
                </button>{" "}
                to create a Companion.
              </>
            ) : (
              "No provider is connected yet. Ask a workspace admin to connect one."
            )}
          </p>
        )}
        {connected ? (
          <>
            <CompanionSkillPicker
              orgId={orgId}
              selectedSkillIds={selectedSkillIds}
              disabled={busy}
              onSelectedSkillIdsChange={setSelectedSkillIds}
            />
            <CompanionPluginPicker
              orgId={orgId}
              selectedMcpAccountIds={selectedMcpAccountIds}
              disabled={busy}
              onSelectedMcpAccountIdsChange={setSelectedMcpAccountIds}
            />
          </>
        ) : null}
      </form>
    </Dialog>
  );
}
