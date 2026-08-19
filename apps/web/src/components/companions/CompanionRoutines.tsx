"use client";

import { useMemo, useState } from "react";
import type { CompanionRoutine } from "@companion/contracts";
import { computeNextFireAt, validateRoutineSchedule } from "@companion/core/companionRoutines";
import {
  createCompanionRoutine,
  deleteCompanionRoutine,
  updateCompanionRoutine,
} from "@/lib/companions";
import { Dialog } from "../org/primitives";
import { Icon } from "../Icon";

function nextFires(cron: string, timezone: string, count = 3): string[] {
  const validated = validateRoutineSchedule({ cron, timezone });
  if (!validated.ok) return [];
  const fires: string[] = [];
  let cursor = new Date();
  try {
    for (let i = 0; i < count; i += 1) {
      const next = computeNextFireAt(cron, timezone, cursor);
      fires.push(next.toLocaleString(undefined, { timeZone: timezone }));
      cursor = next;
    }
  } catch {
    return fires;
  }
  return fires;
}

function RoutineEditor({
  orgId,
  companionId,
  initial,
  onSaved,
  onClose,
}: {
  orgId: string;
  companionId: string;
  initial: CompanionRoutine | null;
  onSaved: (routine: CompanionRoutine) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [cron, setCron] = useState(initial?.cron ?? "0 9 * * 1-5");
  const [timezone, setTimezone] = useState(
    initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useMemo(() => nextFires(cron, timezone), [cron, timezone]);
  const schedule = useMemo(() => validateRoutineSchedule({ cron, timezone }), [cron, timezone]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const routine = initial
        ? await updateCompanionRoutine(orgId, companionId, initial.id, {
          name, prompt, cron, timezone, enabled,
        })
        : await createCompanionRoutine(orgId, companionId, {
          id: crypto.randomUUID(),
          name,
          prompt,
          cron,
          timezone,
          enabled,
        });
      onSaved(routine);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This routine could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      icon="clock"
      title={initial ? "Edit routine" : "New routine"}
      desc="Scheduled prompts fire as ordinary turns. The prompt stays hidden; the reply appears in the thread."
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
            disabled={busy || !schedule.ok || !name.trim() || !prompt.trim()}
          >
            {busy ? "Saving..." : initial ? "Save" : "Create"}
          </button>
        </>
      )}
    >
      <label className="og-field">
        <span>Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
      </label>
      <label className="og-field">
        <span>Prompt</span>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} />
      </label>
      <label className="og-field">
        <span>Cron</span>
        <input
          value={cron}
          onChange={(event) => setCron(event.target.value)}
          className="mono"
          spellCheck={false}
        />
      </label>
      <label className="og-field">
        <span>Timezone</span>
        <input value={timezone} onChange={(event) => setTimezone(event.target.value)} spellCheck={false} />
      </label>
      <label className="og-field og-field--check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span>Enabled</span>
      </label>
      <div className="chat-context__caption">
        {schedule.ok
          ? (
            <>
              Next fires: {preview.join(" · ") || "—"}
            </>
          )
          : schedule.code === "interval_too_short"
            ? "Routines must be at least five minutes apart."
            : schedule.code === "invalid_timezone"
              ? "Use an IANA timezone such as America/New_York."
              : "That cron expression is not valid."}
      </div>
      {error && <p className="text-destructive" role="alert">{error}</p>}
    </Dialog>
  );
}

export function CompanionRoutines({
  orgId,
  companionId,
  routines,
  canEdit,
  onChange,
}: {
  orgId: string;
  companionId: string;
  routines: CompanionRoutine[];
  canEdit: boolean;
  onChange: (routines: CompanionRoutine[]) => void;
}) {
  const [editing, setEditing] = useState<CompanionRoutine | null | "new">(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggle(routine: CompanionRoutine) {
    if (!canEdit || busyId) return;
    setBusyId(routine.id);
    try {
      const updated = await updateCompanionRoutine(orgId, companionId, routine.id, {
        enabled: !routine.enabled,
      });
      onChange(routines.map((item) => item.id === updated.id ? updated : item));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(routine: CompanionRoutine) {
    if (!canEdit || busyId) return;
    setBusyId(routine.id);
    try {
      await deleteCompanionRoutine(orgId, companionId, routine.id);
      onChange(routines.filter((item) => item.id !== routine.id));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="chat-context__block">
      <div className="chat-context__titlerow">
        <h3 className="chat-context__title">Routines</h3>
        {canEdit && (
          <button
            type="button"
            className="iconbtn chat-context__add"
            aria-label="Add a routine"
            onClick={() => setEditing("new")}
          >
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      {routines.length === 0 ? (
        <p className="chat-context__empty">No routines yet.</p>
      ) : (
        <ul className="chat-context__routines">
          {routines.map((routine) => (
            <li key={routine.id} className="chat-context__routine">
              <div className="chat-context__routine-main">
                <span className="chat-context__routine-name">{routine.name}</span>
                <span className="chat-context__caption mono">
                  {routine.cron} · {routine.timezone}
                </span>
                {routine.enabled && routine.next_fire_at && (
                  <span className="chat-context__caption">
                    Next {new Date(routine.next_fire_at).toLocaleString()}
                  </span>
                )}
                {routine.last_error_message && (
                  <span className="chat-context__routine-error" role="status">
                    {routine.last_error_message}
                  </span>
                )}
              </div>
              {canEdit && (
                <div className="chat-context__routine-actions">
                  <button
                    type="button"
                    className="chat-context__link"
                    disabled={busyId === routine.id}
                    onClick={() => void toggle(routine)}
                  >
                    {routine.enabled ? "On" : "Off"}
                  </button>
                  <button
                    type="button"
                    className="chat-context__link"
                    onClick={() => setEditing(routine)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="chat-context__link"
                    disabled={busyId === routine.id}
                    onClick={() => void remove(routine)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing !== null && (
        <RoutineEditor
          orgId={orgId}
          companionId={companionId}
          initial={editing === "new" ? null : editing}
          onSaved={(routine) => {
            const exists = routines.some((item) => item.id === routine.id);
            onChange(exists
              ? routines.map((item) => item.id === routine.id ? routine : item)
              : [...routines, routine]);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
