"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CompanionTrigger,
  CompanionTriggerTarget,
} from "@companion/contracts";
import { COMPANION_TRIGGER_NAME_MAX_CHARACTERS } from "@companion/contracts";
import {
  createCompanionTrigger,
  deleteCompanionTrigger,
  retryCompanionTriggerRegistration,
  rotateCompanionTriggerSecret,
  updateCompanionTrigger,
} from "@/lib/companions";
import { Dialog } from "../org/primitives";
import { Badge } from "../cds";
import { Icon } from "../Icon";
import { PluginMark } from "./PluginMark";
import { detectedBrowserTimeZone, formatMemberDateTime } from "@/lib/timezones";
import {
  COMPANION_TRIGGER_V2_PROVIDERS,
  type CompanionTriggerAccountOption,
  type CompanionTriggerV2,
  type CompanionTriggerV2Mode,
  type CompanionTriggerV2Provider,
} from "./CompanionTriggerTypes";

/**
 * The old shared contract is still accepted here while the Trigger v2 contract lands. API methods
 * keep their legacy signatures so existing callers can inject the same test doubles; the editor
 * passes the additive v2 fields at runtime through the narrow compatibility cast below.
 */
export interface CompanionTriggersApi {
  createCompanionTrigger: typeof createCompanionTrigger;
  deleteCompanionTrigger: typeof deleteCompanionTrigger;
  rotateCompanionTriggerSecret: typeof rotateCompanionTriggerSecret;
  updateCompanionTrigger: typeof updateCompanionTrigger;
  retryCompanionTriggerRegistration?: typeof retryCompanionTriggerRegistration;
}

const defaultCompanionTriggersApi: CompanionTriggersApi = {
  createCompanionTrigger,
  deleteCompanionTrigger,
  rotateCompanionTriggerSecret,
  updateCompanionTrigger,
  retryCompanionTriggerRegistration,
};

/** UI names only: the provider picks the row's mark, never an authentication scheme. */
const PROVIDER_LABELS: Record<CompanionTriggerV2Provider, string> = {
  webhook: "Webhook",
  linear: "Linear",
  github: "GitHub",
  sentry: "Sentry",
  custom: "Custom",
};

const MODE_LABELS: Record<CompanionTriggerV2Mode, string> = {
  notify: "Notify me",
  relay: "Ask the Companion",
};

const MODE_DESCRIPTIONS: Record<CompanionTriggerV2Mode, string> = {
  notify: "Show the event in the thread without starting a main Companion turn.",
  relay: "Show the event and ask the main Companion to do the requested work.",
};

type TriggerEditorValue = CompanionTriggerV2;
type TriggerChangeHandler =
  | ((triggers: CompanionTriggerV2[]) => void)
  | ((triggers: CompanionTrigger[]) => void);

/** The API accepts the old type in this checkout; v2 fields are additive and validated server-side. */
type TriggerCreateRequest = Record<string, unknown>;
type TriggerUpdateRequest = Record<string, unknown>;

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider as CompanionTriggerV2Provider]
    ?? provider
      .split("-")
      .map((part) => part ? part[0]!.toLocaleUpperCase("en-US") + part.slice(1) : part)
      .join(" ");
}

function providerMark(provider: CompanionTriggerV2Provider) {
  return provider === "webhook"
    ? <Icon name="link-2" size={15} />
    : <PluginMark provider={provider} variant="glyph" />;
}

function isProvider(provider: string): provider is CompanionTriggerV2Provider {
  return (COMPANION_TRIGGER_V2_PROVIDERS as readonly string[]).includes(provider);
}

function asV2Trigger(trigger: CompanionTrigger | CompanionTriggerV2): CompanionTriggerV2 {
  return trigger as CompanionTriggerV2;
}

function eligibleAccountsFor(
  provider: CompanionTriggerV2Provider,
  accounts: readonly CompanionTriggerAccountOption[],
): CompanionTriggerAccountOption[] {
  // Generic/custom webhooks are not backed by a connected MCP account. Provider-backed triggers
  // silently reuse the sole attached account and only expose a chooser when there is a real choice.
  if (provider === "webhook" || provider === "custom") return [];
  return accounts.filter((account) => account.provider.toLocaleLowerCase("en-US") === provider);
}

function triggerTarget(provider: CompanionTriggerV2Provider, repo: string, events: string): CompanionTriggerTarget | null {
  if (provider !== "github") return null;
  return {
    repo: repo.trim() || undefined,
    events: events.split(",").map((event) => event.trim()).filter(Boolean),
  };
}

function registrationLabel(trigger: CompanionTriggerV2): string {
  if (trigger.registration_status === "registered") return "Registered";
  if (trigger.registration_status === "failed") return "Registration failed";
  return "Manual fallback";
}

function registrationTone(trigger: CompanionTriggerV2): "neutral" | "ok" | "danger" {
  if (trigger.registration_status === "registered") return "ok";
  if (trigger.registration_status === "failed") return "danger";
  return "neutral";
}

function TriggerEditor({
  orgId,
  companionId,
  api,
  initial,
  accountOptions,
  onSaved,
  onClose,
}: {
  orgId: string;
  companionId: string;
  api: CompanionTriggersApi;
  initial: TriggerEditorValue | null;
  accountOptions: readonly CompanionTriggerAccountOption[];
  onSaved: (trigger: CompanionTriggerV2) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [provider, setProvider] = useState<CompanionTriggerV2Provider>(initial?.provider ?? "webhook");
  const [mode, setMode] = useState<CompanionTriggerV2Mode>(initial?.mode ?? "relay");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [repo, setRepo] = useState(initial?.target?.repo ?? "");
  const [events, setEvents] = useState(initial?.target?.events?.join(", ") ?? "push");
  const [providerAccountId, setProviderAccountId] = useState(initial?.provider_account_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eligibleAccounts = useMemo(
    () => eligibleAccountsFor(provider, accountOptions),
    [accountOptions, provider],
  );

  // A single attached account is an implementation detail, not an extra setup step. Preserve an
  // explicit choice when editing, otherwise select the only eligible account automatically.
  useEffect(() => {
    if (provider === initial?.provider && initial?.provider_account_id && eligibleAccounts.some(
      (account) => account.id === initial.provider_account_id,
    )) {
      setProviderAccountId(initial.provider_account_id);
      return;
    }
    if (eligibleAccounts.length === 1) {
      setProviderAccountId(eligibleAccounts[0]!.id);
      return;
    }
    setProviderAccountId(eligibleAccounts.some((account) => account.id === providerAccountId)
      ? providerAccountId
      : "");
    // `providerAccountId` is intentionally omitted: this effect should react to provider/account
    // catalog changes, not reset a user's in-progress account choice on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibleAccounts, initial?.provider, initial?.provider_account_id, provider]);

  const accountChoiceRequired = eligibleAccounts.length > 1 && !providerAccountId;
  const githubTargetIncomplete = provider === "github" && (!repo.trim() || !events.trim());
  const canSave = !busy
    && Boolean(name.trim())
    && Boolean(prompt.trim())
    && !accountChoiceRequired
    && !githubTargetIncomplete;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const target = triggerTarget(provider, repo, events);
    const request: TriggerCreateRequest | TriggerUpdateRequest = {
      name: name.trim(),
      prompt: prompt.trim(),
      provider,
      target,
      mode,
      enabled,
      ...(providerAccountId ? { provider_account_id: providerAccountId } : {}),
    };
    try {
      const trigger = initial
        ? await api.updateCompanionTrigger(
          orgId,
          companionId,
          initial.id,
          request as Parameters<typeof updateCompanionTrigger>[3],
        )
        : await api.createCompanionTrigger(
          orgId,
          companionId,
          {
            id: crypto.randomUUID(),
            ...request,
          } as Parameters<typeof createCompanionTrigger>[2],
        );
      onSaved(asV2Trigger(trigger));
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
      desc="A provider event will be registered for this Companion. Connected provider accounts are reused automatically."
      onClose={onClose}
      closeDisabled={busy}
      className="og-dialog companions-trigger-dialog"
      foot={(
        <>
          <button type="button" className="cds-btn cds-btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="cds-btn cds-btn--primary"
            onClick={() => void save()}
            disabled={!canSave}
            aria-busy={busy}
          >
            {busy ? "Saving…" : initial ? "Save trigger" : "Create trigger"}
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
          autoFocus
        />
      </label>

      <label className="og-field">
        <span>Provider</span>
        <select
          value={provider}
          onChange={(event) => {
            if (isProvider(event.target.value)) setProvider(event.target.value);
          }}
        >
          {COMPANION_TRIGGER_V2_PROVIDERS.map((option) => (
            <option key={option} value={option}>{PROVIDER_LABELS[option]}</option>
          ))}
        </select>
      </label>

      {eligibleAccounts.length === 1 && (
        <p className="companions-trigger-field-hint" role="status">
          Using the attached {providerLabel(provider)} account “{eligibleAccounts[0]!.label}”.
        </p>
      )}
      {eligibleAccounts.length > 1 && (
        <label className="og-field">
          <span>{providerLabel(provider)} account</span>
          <select
            value={providerAccountId}
            onChange={(event) => setProviderAccountId(event.target.value)}
            aria-describedby="companion-trigger-account-hint"
          >
            <option value="">Choose an attached account</option>
            {eligibleAccounts.map((account) => (
              <option key={account.id} value={account.id}>{account.label}</option>
            ))}
          </select>
          <span id="companion-trigger-account-hint" className="companions-trigger-field-hint">
            Choose which attached account should register this provider webhook.
          </span>
        </label>
      )}
      {eligibleAccounts.length === 0 && (provider === "linear" || provider === "github") && (
        <p className="companions-trigger-field-hint" role="status">
          Attach a {providerLabel(provider)} account in Plugins to register this provider webhook.
        </p>
      )}

      {provider === "github" && (
        <div className="companions-trigger-target">
          <p className="companions-trigger-field-label">GitHub event</p>
          <label className="og-field">
            <span>Repository</span>
            <input
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="owner/repository"
              autoComplete="off"
            />
          </label>
          <label className="og-field">
            <span>Events</span>
            <input
              value={events}
              onChange={(event) => setEvents(event.target.value)}
              placeholder="push, pull_request"
              autoComplete="off"
              aria-describedby="companion-trigger-events-hint"
            />
            <span id="companion-trigger-events-hint" className="companions-trigger-field-hint">
              Separate event names with commas. Use * for every event.
            </span>
          </label>
        </div>
      )}

      <fieldset className="companions-trigger-mode">
        <legend>When an event arrives</legend>
        {(Object.keys(MODE_LABELS) as CompanionTriggerV2Mode[]).map((option) => (
          <label key={option} className={mode === option ? "companions-trigger-mode__option companions-trigger-mode__option--selected" : "companions-trigger-mode__option"}>
            <input
              type="radio"
              name="companion-trigger-mode"
              value={option}
              checked={mode === option}
              onChange={() => setMode(option)}
            />
            <span>
              <strong>{MODE_LABELS[option]}</strong>
              <small>{MODE_DESCRIPTIONS[option]}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="og-field">
        <span>Processing prompt</span>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} />
      </label>

      <label className="companions-trigger-enabled">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>
          <strong>Enable trigger</strong>
          <small>Provider events can fire this trigger immediately after it is saved.</small>
        </span>
      </label>

      {error && <p className="text-destructive" role="alert">{error}</p>}
    </Dialog>
  );
}

export function CompanionTriggers({
  orgId,
  companionId,
  triggers,
  memberTimezone,
  canEdit,
  accountOptions = [],
  onChange,
  onOpenHistory,
  api = defaultCompanionTriggersApi,
}: {
  orgId: string;
  companionId: string;
  triggers: readonly (CompanionTrigger | CompanionTriggerV2)[];
  memberTimezone?: string | null;
  canEdit: boolean;
  /** Only attached, credential-free account projections should be passed here. */
  accountOptions?: readonly CompanionTriggerAccountOption[];
  onChange: TriggerChangeHandler;
  onOpenHistory?: (trigger: CompanionTriggerV2) => void;
  api?: CompanionTriggersApi;
}) {
  const displayTimezone = memberTimezone ?? detectedBrowserTimeZone();
  const [editing, setEditing] = useState<CompanionTriggerV2 | null | "new">(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingRotateId, setConfirmingRotateId] = useState<string | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emitChange = (next: CompanionTriggerV2[]) => {
    // The legacy callback remains accepted for the transition checkout; the v2 response is
    // structurally compatible at runtime and the shared contract will remove this cast after rebase.
    (onChange as (triggers: CompanionTriggerV2[]) => void)(next);
  };

  useEffect(() => () => {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
  }, []);

  async function toggle(trigger: CompanionTriggerV2) {
    if (!canEdit || busyId) return;
    setBusyId(trigger.id);
    setActionError(null);
    setConfirmingRotateId(null);
    try {
      const updated = await api.updateCompanionTrigger(orgId, companionId, trigger.id, {
        enabled: !trigger.enabled,
      });
      emitChange(triggers.map((item) => item.id === updated.id ? asV2Trigger(updated) : asV2Trigger(item)));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "This trigger could not be updated.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(trigger: CompanionTriggerV2) {
    if (!canEdit || busyId) return;
    setBusyId(trigger.id);
    setActionError(null);
    setConfirmingRotateId(null);
    try {
      await api.deleteCompanionTrigger(orgId, companionId, trigger.id);
      emitChange(triggers.filter((item) => item.id !== trigger.id).map(asV2Trigger));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "This trigger could not be deleted.");
    } finally {
      setBusyId(null);
    }
  }

  // Rotation silently breaks the external service still posting to the old URL, so it takes a
  // second explicit click rather than firing on the first.
  async function rotate(trigger: CompanionTriggerV2) {
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
      emitChange(triggers.map((item) => item.id === updated.id ? asV2Trigger(updated) : asV2Trigger(item)));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The secret could not be rotated.");
    } finally {
      setBusyId(null);
    }
  }

  async function retryRegistration(trigger: CompanionTriggerV2) {
    if (!canEdit || busyId) return;
    if (!api.retryCompanionTriggerRegistration) {
      setActionError("Registration retry is not available yet.");
      return;
    }
    setBusyId(trigger.id);
    setActionError(null);
    try {
      const updated = await api.retryCompanionTriggerRegistration(orgId, companionId, trigger.id);
      emitChange(triggers.map((item) => item.id === updated.id ? asV2Trigger(updated) : asV2Trigger(item)));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "This provider registration could not be retried.");
    } finally {
      setBusyId(null);
    }
  }

  async function copy(trigger: CompanionTriggerV2) {
    if (!trigger.webhook_url) return;
    try {
      await navigator.clipboard.writeText(trigger.webhook_url);
    } catch {
      setActionError("The webhook URL could not be copied.");
      return;
    }
    setCopiedId(trigger.id);
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopiedId(null), 2_000);
  }

  return (
    <section className="chat-context__block">
      <div className="chat-context__titlerow">
        <div>
          <h3 className="chat-context__title">Triggers</h3>
          <p className="chat-context__section-hint">Provider events that notify or ask this Companion to work.</p>
        </div>
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
        <p className="chat-context__empty">
          No triggers connected. Add a provider event to notify or wake this Companion.
        </p>
      ) : (
        <ul className="chat-context__resources">
          {triggers.map((rawTrigger) => {
            const trigger = asV2Trigger(rawTrigger);
            const registrationError = trigger.last_registration_error
              ?? (trigger.registration_status === "failed" ? trigger.last_error_message : null);
            const mode = trigger.mode ?? "relay";
            return (
              <li key={trigger.id} className="chat-context__resource chat-context__trigger-resource">
                <div className="chat-context__routine-main">
                  <span className="chat-context__resource-head">
                    <span className="chat-context__routine-name chat-context__trigger-name">
                      {providerMark(trigger.provider)}
                      <span className="chat-context__trigger-name-text">{trigger.name}</span>
                    </span>
                    <Badge
                      tone={!trigger.enabled ? "neutral" : trigger.last_error_message ? "danger" : "ok"}
                      dot
                    >
                      {!trigger.enabled ? "Disabled" : trigger.last_error_message ? "Error" : "Enabled"}
                    </Badge>
                  </span>
                  <span className="chat-context__resource-meta">
                    <span>{providerLabel(trigger.provider)}</span>
                    <span>{MODE_LABELS[mode]}</span>
                    <Badge tone={registrationTone(trigger)}>{registrationLabel(trigger)}</Badge>
                  </span>
                  {trigger.provider === "github" && trigger.target?.repo && (
                    <span className="chat-context__caption mono">
                      {trigger.target.repo} · {trigger.target.events?.join(", ")}
                    </span>
                  )}
                  {trigger.last_fired_at && (
                    <span className="chat-context__caption">
                      Last fired {formatMemberDateTime(trigger.last_fired_at, displayTimezone)} · {displayTimezone}
                    </span>
                  )}
                  {registrationError && (
                    <span className="chat-context__routine-error" role="status">
                      {registrationError}
                    </span>
                  )}
                  {trigger.last_error_message && trigger.last_error_message !== registrationError && (
                    <span className="chat-context__routine-error" role="status">
                      {trigger.last_error_message}
                    </span>
                  )}
                </div>

                <div className="chat-context__routine-actions">
                  {onOpenHistory && (
                    <button
                      type="button"
                      className="chat-context__link"
                      onClick={() => onOpenHistory(trigger)}
                    >
                      History
                    </button>
                  )}
                  {canEdit && (
                    <>
                      {trigger.registration_status === "failed" && (
                        <button
                          type="button"
                          className="chat-context__link"
                          disabled={busyId === trigger.id}
                          onClick={() => void retryRegistration(trigger)}
                        >
                          {busyId === trigger.id ? "Retrying…" : "Retry registration"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="chat-context__link"
                        disabled={busyId === trigger.id}
                        onClick={() => void toggle(trigger)}
                      >
                        {trigger.enabled ? "Turn off" : "Turn on"}
                      </button>
                      <button
                        type="button"
                        className="chat-context__link"
                        onClick={() => setEditing(trigger)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="chat-context__link"
                        disabled={busyId === trigger.id}
                        onClick={() => void remove(trigger)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>

                {canEdit && trigger.webhook_url && (
                  <details className="chat-context__trigger-technical" open>
                    <summary>Technical details</summary>
                    <div className="chat-context__trigger-technical-body">
                      <span className="chat-context__caption">Fallback webhook URL (keep private)</span>
                      <code>{trigger.webhook_url}</code>
                      <div className="chat-context__routine-actions">
                        <button type="button" className="chat-context__link" onClick={() => void copy(trigger)}>
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
                      </div>
                    </div>
                  </details>
                )}
              </li>
            );
          })}
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
          accountOptions={accountOptions}
          onSaved={(trigger) => {
            const exists = triggers.some((item) => item.id === trigger.id);
            emitChange(exists
              ? triggers.map((item) => item.id === trigger.id ? trigger : asV2Trigger(item))
              : [...triggers.map(asV2Trigger), trigger]);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
