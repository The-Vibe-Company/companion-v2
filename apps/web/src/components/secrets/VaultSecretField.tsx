"use client";

import { useId, useMemo, useState } from "react";
import type { SecretAudience, SecretRow } from "@companion/contracts";
import { createSecret } from "@/lib/secrets";
import { Icon } from "../Icon";

export interface VaultSecretReference {
  id: string;
  name: string;
  key: string;
  audience: SecretAudience;
  owner: { name: string };
}

const AUDIENCE_LABEL: Record<SecretAudience, string> = {
  personal: "Personal",
  restricted: "Selected members",
  organization: "Organization",
};

export function secretReferenceFromRow(row: SecretRow): VaultSecretReference {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    audience: row.audience,
    owner: { name: row.owner.name },
  };
}

/**
 * Metadata-only vault selector with a small inline create path. Plaintext exists only in the
 * create-secret form and is submitted directly to the generic vault; provider/run APIs receive an
 * id reference only.
 */
export function VaultSecretField({
  orgId,
  envKey,
  candidates,
  value,
  onChange,
  onCreated,
  audience = "personal",
  label = "Secret",
  required = false,
  disabled = false,
  helper,
  unavailable = false,
}: {
  orgId: string;
  envKey: string;
  candidates: VaultSecretReference[];
  value: string | null;
  onChange: (secretId: string | null) => void;
  onCreated?: (secret: VaultSecretReference) => void;
  audience?: "personal" | "organization";
  label?: string;
  required?: boolean;
  disabled?: boolean;
  helper?: string;
  unavailable?: boolean;
}) {
  const hintId = useId();
  const errorId = useId();
  const selectId = useId();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sorted = useMemo(
    () =>
      candidates
        .filter((candidate) => candidate.key === envKey)
        .sort((left, right) => left.name.localeCompare(right.name)),
    [candidates, envKey],
  );
  const missingReference = unavailable || (!!value && !sorted.some((candidate) => candidate.id === value));

  const closeCreator = () => {
    // Drop plaintext immediately when the inline form closes; reopening always starts clean.
    setCreating(false);
    setName("");
    setSecretValue("");
    setVisible(false);
    setError(null);
  };

  const save = async () => {
    if (!name.trim() || !secretValue || busy) return;
    setBusy(true);
    setError(null);
    try {
      const row = await createSecret(orgId, {
        name: name.trim(),
        key: envKey,
        value: secretValue,
        audience,
        recipient_ids: [],
      });
      const reference = secretReferenceFromRow(row);
      onCreated?.(reference);
      onChange(reference.id);
      closeCreator();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the secret.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="vault-field"
      data-esc-guard={creating || undefined}
      onKeyDown={(event) => {
        if (creating && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeCreator();
        }
      }}
    >
      <div className="vault-field__label-row">
        <label className="vault-field__label" htmlFor={selectId}>
          {label} {required && <span className="vault-field__requirement">Required</span>}
        </label>
        {!required && <span className="vault-field__optional">Optional</span>}
      </div>
      <div className="vault-field__controls">
        <select
          id={selectId}
          className="sx-input vault-field__select"
          value={missingReference ? "__unavailable__" : value ?? ""}
          disabled={disabled}
          aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
          aria-invalid={(missingReference || (required && !value)) || undefined}
          onChange={(event) => onChange(event.target.value && event.target.value !== "__unavailable__" ? event.target.value : null)}
        >
          <option value="">{required ? "Select a secret" : "Do not expose a secret"}</option>
          {missingReference && <option value="__unavailable__" disabled>Secret unavailable</option>}
          {sorted.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name} · {AUDIENCE_LABEL[candidate.audience]} · {candidate.owner.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-sec vault-field__create-button"
          disabled={disabled}
          aria-expanded={creating}
          onClick={() => {
            if (creating) closeCreator();
            else {
              setCreating(true);
              setError(null);
            }
          }}
        >
          <Icon name={creating ? "x" : "plus"} size={13} />
          {creating ? "Cancel" : "Create secret"}
        </button>
      </div>
      <p className="vault-field__hint" id={hintId}>
        {helper ?? <>Injected as <code>{envKey}</code>. The value is never shown here.</>}
      </p>
      {creating && (
        <div className="vault-create">
          <label>
            <span>Name</span>
            <input
              className="sx-input"
              value={name}
              maxLength={120}
              autoFocus
              placeholder={`${envKey} credential`}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>Secret value</span>
            <span className="vault-create__value">
              <input
                className="sx-input"
                type={visible ? "text" : "password"}
                value={secretValue}
                autoComplete="new-password"
                spellCheck={false}
                placeholder="Enter once"
                onChange={(event) => setSecretValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void save();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    closeCreator();
                  }
                }}
              />
              <button
                type="button"
                className="iconbtn"
                aria-label={visible ? "Hide secret value" : "Show secret value"}
                aria-pressed={visible}
                onClick={() => setVisible((current) => !current)}
              >
                <Icon name={visible ? "eye-off" : "eye"} size={14} />
              </button>
            </span>
          </label>
          <div className="vault-create__meta">
            <code>{envKey}</code>
            <span>{AUDIENCE_LABEL[audience]}</span>
          </div>
          <button type="button" className="btn-primary" disabled={!name.trim() || !secretValue || busy} onClick={() => void save()}>
            {busy ? "Creating…" : "Create and select"}
          </button>
        </div>
      )}
      {error && (
        <p className="vault-field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
