"use client";

import { type FormEvent, useState } from "react";
import type { Companion, CompanionProvidersResponse } from "@companion/contracts";
import { createCompanion } from "@/lib/companions";
import { Dialog } from "../org/primitives";

/**
 * Creation is deliberately two fields plus one provider choice. Everything else about a Companion
 * is decided later, from the Companion itself.
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
  const [providerId, setProviderId] = useState(
    providers.default_provider_id ?? providers.connections[0]?.provider_id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerName = (id: string) =>
    providers.catalog.find((provider) => provider.id === id)?.name ?? id;
  const connected = providers.connections.length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !providerId) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createCompanion(orgId, {
        name: name.trim(),
        persona: persona.trim() || undefined,
        provider_id: providerId,
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
      desc="A name, one line about what it does, and the model provider it runs on."
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
            disabled={busy || !connected || !name.trim() || !providerId}
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
          />
          <span>One line, shown under the name in the list.</span>
        </label>
        <fieldset className="companions-picker">
          <legend>Provider</legend>
          {connected ? (
            providers.connections.map((connection) => (
              <label
                key={connection.provider_id}
                className={
                  "companions-chip"
                  + (providerId === connection.provider_id ? " companions-chip--active" : "")
                }
              >
                <input
                  type="radio"
                  name="companion-provider"
                  value={connection.provider_id}
                  checked={providerId === connection.provider_id}
                  onChange={() => setProviderId(connection.provider_id)}
                />
                <span>{providerName(connection.provider_id)}</span>
                {providers.default_provider_id === connection.provider_id && <em>Default</em>}
              </label>
            ))
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
        </fieldset>
      </form>
    </Dialog>
  );
}
