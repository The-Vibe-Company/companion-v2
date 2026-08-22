"use client";

import { useEffect, useRef, useState } from "react";
import type { CompanionTrigger, CompanionTriggerProvider } from "@companion/contracts";
import { COMPANION_TRIGGER_NAME_MAX_CHARACTERS, COMPANION_TRIGGER_PROVIDERS } from "@companion/contracts";
import {
  createCompanionTrigger,
  deleteCompanionTrigger,
  rotateCompanionTriggerSecret,
  updateCompanionTrigger,
} from "@/lib/companions";
import { Dialog } from "../org/primitives";
import { Icon } from "../Icon";
import { PluginMark } from "./PluginMark";

export interface CompanionTriggersApi {
  createCompanionTrigger: typeof createCompanionTrigger;
  deleteCompanionTrigger: typeof deleteCompanionTrigger;
  rotateCompanionTriggerSecret: typeof rotateCompanionTriggerSecret;
  updateCompanionTrigger: typeof updateCompanionTrigger;
}

const defaultCompanionTriggersApi: CompanionTriggersApi = {
  createCompanionTrigger,
  deleteCompanionTrigger,
  rotateCompanionTriggerSecret,
  updateCompanionTrigger,
};

/** UI names only: the provider picks the row's mark, never an authentication scheme. */
const PROVIDER_LABELS = {
  linear: "Linear",
  github: "GitHub",
  custom: "Custom",
} satisfies Record<CompanionTriggerProvider, string>;

function TriggerEditor({
  orgId,
  companionId,
  api,
  initial,
  onSaved,
  onClose,
}: {
  orgId: string;
  companionId: string;
  api: CompanionTriggersApi;
  initial: CompanionTrigger | null;
  onSaved: (trigger: CompanionTrigger) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [provider, setProvider] = useState<CompanionTriggerProvider>(initial?.provider ?? "custom");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const trigger = initial
        ? await api.updateCompanionTrigger(orgId, companionId, initial.id, { name, prompt, provider })
        : await api.createCompanionTrigger(orgId, companionId, {
          id: crypto.randomUUID(),
          name,
          prompt,
          provider,
          enabled: true,
        });
      onSaved(trigger);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This trigger could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      icon="zap"
      title={initial ? "Edit trigger" : "New trigger"}
      desc="An external webhook fires this prompt as an ordinary turn. Paste the webhook URL into the service you control."
      onClose={onClose}
      foot={(
        <>
          <button type="button" className="cds-btn cds-btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="cds-btn"
            onClick={() => void save()}
            disabled={busy || !name.trim() || !prompt.trim()}
          >
            {busy ? "Saving..." : initial ? "Save" : "Create"}
          </button>
        </>
      )}
    >
      <label className="og-field">
        <span>Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={COMPANION_TRIGGER_NAME_MAX_CHARACTERS}
        />
      </label>
      <label className="og-field">
        <span>Provider</span>
        <select
          value={provider}
          onChange={(event) => {
            const next = COMPANION_TRIGGER_PROVIDERS.find((option) => option === event.target.value);
            if (next) setProvider(next);
          }}
        >
          {COMPANION_TRIGGER_PROVIDERS.map((option) => (
            <option key={option} value={option}>{PROVIDER_LABELS[option]}</option>
          ))}
        </select>
      </label>
      <label className="og-field">
        <span>Prompt</span>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} />
      </label>
      {error && <p className="text-destructive" role="alert">{error}</p>}
    </Dialog>
  );
}

export function CompanionTriggers({
  orgId,
  companionId,
  triggers,
  canEdit,
  onChange,
  api = defaultCompanionTriggersApi,
}: {
  orgId: string;
  companionId: string;
  triggers: CompanionTrigger[];
  canEdit: boolean;
  onChange: (triggers: CompanionTrigger[]) => void;
  api?: CompanionTriggersApi;
}) {
  const [editing, setEditing] = useState<CompanionTrigger | null | "new">(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingRotateId, setConfirmingRotateId] = useState<string | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
  }, []);

  async function toggle(trigger: CompanionTrigger) {
    if (!canEdit || busyId) return;
    setBusyId(trigger.id);
    setActionError(null);
    setConfirmingRotateId(null);
    try {
      const updated = await api.updateCompanionTrigger(orgId, companionId, trigger.id, {
        enabled: !trigger.enabled,
      });
      onChange(triggers.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "This trigger could not be updated.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(trigger: CompanionTrigger) {
    if (!canEdit || busyId) return;
    setBusyId(trigger.id);
    setActionError(null);
    setConfirmingRotateId(null);
    try {
      await api.deleteCompanionTrigger(orgId, companionId, trigger.id);
      onChange(triggers.filter((item) => item.id !== trigger.id));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "This trigger could not be deleted.");
    } finally {
      setBusyId(null);
    }
  }

  // Rotation silently breaks the external service still posting to the old URL, so it takes a
  // second explicit click rather than firing on the first.
  async function rotate(trigger: CompanionTrigger) {
    if (!canEdit || busyId) return;
    if (confirmingRotateId !== trigger.id) {
      setConfirmingRotateId(trigger.id);
      return;
    }
    setBusyId(trigger.id);
    setActionError(null);
    setConfirmingRotateId(null);
    try {
      const updated = await api.rotateCompanionTriggerSecret(orgId, companionId, trigger.id);
      onChange(triggers.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The secret could not be rotated.");
    } finally {
      setBusyId(null);
    }
  }

  async function copy(trigger: CompanionTrigger) {
    if (!trigger.webhook_url) return;
    try {
      await navigator.clipboard.writeText(trigger.webhook_url);
    } catch {
      return;
    }
    setCopiedId(trigger.id);
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopiedId(null), 2_000);
  }

  return (
    <section className="chat-context__block">
      <div className="chat-context__titlerow">
        <h3 className="chat-context__title">Triggers</h3>
        {canEdit && (
          <button
            type="button"
            className="iconbtn chat-context__add"
            aria-label="Add a trigger"
            onClick={() => setEditing("new")}
          >
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      {triggers.length === 0 ? (
        <p className="chat-context__empty">No triggers yet.</p>
      ) : (
        <ul className="chat-context__routines">
          {triggers.map((trigger) => (
            <li key={trigger.id} className="chat-context__routine">
              <div className="chat-context__routine-main">
                <span
                  className="chat-context__routine-name"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  {trigger.provider !== "custom" && (
                    <PluginMark provider={trigger.provider} variant="glyph" />
                  )}
                  {trigger.name}
                </span>
                {/* The provider is a machine value and a UI label only; it names the mark, never an
                    authentication scheme. */}
                <span className="chat-context__caption mono">{trigger.provider}</span>
                {trigger.last_fired_at && (
                  <span className="chat-context__caption">
                    Last fired {new Date(trigger.last_fired_at).toLocaleString()}
                  </span>
                )}
                {trigger.last_error_message && (
                  <span className="chat-context__routine-error" role="status">
                    {trigger.last_error_message}
                  </span>
                )}
              </div>
              {canEdit && (
                <div className="chat-context__routine-actions">
                  <button
                    type="button"
                    className="chat-context__link"
                    disabled={busyId === trigger.id}
                    onClick={() => void toggle(trigger)}
                  >
                    {trigger.enabled ? "On" : "Off"}
                  </button>
                  <button
                    type="button"
                    className="chat-context__link"
                    onClick={() => setEditing(trigger)}
                  >
                    Edit
                  </button>
                  {trigger.webhook_url && (
                    <>
                      <button
                        type="button"
                        className="chat-context__link"
                        onClick={() => void copy(trigger)}
                      >
                        {copiedId === trigger.id ? "Copied" : "Copy URL"}
                      </button>
                      <button
                        type="button"
                        className="chat-context__link"
                        disabled={busyId === trigger.id}
                        onClick={() => void rotate(trigger)}
                      >
                        {confirmingRotateId === trigger.id ? "Confirm rotate" : "Rotate secret"}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="chat-context__link"
                    disabled={busyId === trigger.id}
                    onClick={() => void remove(trigger)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {actionError && (
        <p className="chat-context__routine-error" role="alert">{actionError}</p>
      )}
      {editing !== null && (
        <TriggerEditor
          orgId={orgId}
          companionId={companionId}
          api={api}
          initial={editing === "new" ? null : editing}
          onSaved={(trigger) => onChange(
            editing === "new"
              ? [...triggers, trigger]
              : triggers.map((item) => item.id === trigger.id ? trigger : item),
          )}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
