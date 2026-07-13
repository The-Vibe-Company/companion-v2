"use client";

import { useEffect, useState } from "react";
import type { SkillSecretConfiguration as Configuration } from "@companion/contracts";
import {
  acceptSkillSecretSuggestion,
  fetchSkillSecretConfiguration,
  removeSkillSecretBinding,
  removeSkillSecretSuggestion,
  setSkillSecretBinding,
  setSkillSecretSuggestion,
} from "@/lib/secrets";
import { Icon } from "../Icon";

function statusCopy(slot: Configuration["slots"][number]): { icon: string; title: string; detail: string } {
  if (slot.status === "personal" && slot.binding) return { icon: "user", title: "Using my key", detail: slot.binding.name };
  if (slot.status === "shared" && slot.binding) return { icon: "users", title: `Using key shared by ${slot.binding.owner.name}`, detail: slot.binding.name };
  if (slot.status === "optional_missing") return { icon: "info", title: "Optional secret absent", detail: "This skill can run without it." };
  return { icon: "alert-triangle", title: "Configuration required", detail: "Choose a credential before installing or syncing." };
}

export function SkillSecretConfiguration({
  slug,
  canSuggest,
}: {
  slug: string;
  canSuggest: boolean;
}) {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busySlot, setBusySlot] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setConfig(null);
    setError(null);
    void fetchSkillSecretConfiguration(slug).then(
      (value) => { if (live) setConfig(value); },
      (caught) => { if (live) setError(caught instanceof Error ? caught.message : String(caught)); },
    );
    return () => { live = false; };
  }, [slug]);

  const mutate = (slotId: string, action: () => Promise<Configuration>) => {
    if (busySlot !== null) return;
    setBusySlot(slotId);
    setError(null);
    void action().then(setConfig, (caught) => setError(caught instanceof Error ? caught.message : String(caught))).finally(() => setBusySlot(null));
  };

  if (error && !config) return <div className="sksec-error"><Icon name="alert-triangle" size={14} />{error}</div>;
  if (!config) return <div className="sksec-loading"><Icon name="loader" size={14} />Checking secret configuration…</div>;
  if (config.slots.length === 0) return null;

  return (
    <div className="sksec">
      {error && <div className="sksec-error"><Icon name="alert-triangle" size={14} />{error}</div>}
      <div className="sksec__summary">
        <span className={config.configured ? "is-ready" : "is-blocked"}><Icon name={config.configured ? "shield-check" : "alert-triangle"} size={14} />{config.configured ? "Ready to install" : `${config.blockers} required configuration${config.blockers === 1 ? "" : "s"}`}</span>
      </div>
      {config.slots.map((slot) => {
        const copy = statusCopy(slot);
        const suggested = slot.suggestion;
        return (
          <div className="sksec-slot" key={slot.slot_id}>
            <div className="sksec-slot__head">
              <span className={`sksec-state sksec-state--${slot.status}`}><Icon name={copy.icon} size={14} /></span>
              <span className="sksec-slot__name"><code>{slot.env_key}</code><small>{slot.description || copy.detail}</small></span>
              {!slot.required && <span className="sksec-optional">Optional</span>}
            </div>
            <div className="sksec-slot__status"><b>{copy.title}</b>{copy.detail && <span>{copy.detail}</span>}</div>
            {suggested && !slot.binding && (
              <button className="sksec-suggestion" disabled={busySlot !== null} onClick={() => mutate(slot.slot_id, () => acceptSkillSecretSuggestion(slug, slot.slot_id))}>
                <Icon name="users" size={13} /> Use the key shared by {suggested.owner.name}
              </button>
            )}
            <div className="sksec-slot__controls">
              <select
                aria-label={`Credential for ${slot.env_key}`}
                disabled={busySlot !== null}
                value={slot.binding?.id ?? ""}
                onChange={(event) => {
                  const id = event.target.value;
                  mutate(slot.slot_id, () => id ? setSkillSecretBinding(slug, slot.slot_id, id) : removeSkillSecretBinding(slug, slot.slot_id));
                }}
              >
                <option value="">{slot.required ? "Choose a credential…" : "No credential"}</option>
                {slot.candidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.personal ? "My key" : `Shared by ${candidate.owner.name}`} · {candidate.name}</option>)}
              </select>
              <a href={`/secrets?create=1&key=${encodeURIComponent(slot.env_key)}`}><Icon name="plus" size={13} />Create personal secret</a>
            </div>
            {canSuggest && (
              <label className="sksec-share-default">
                <span>Shared suggestion</span>
                <select
                  value={slot.suggestion?.id ?? ""}
                  disabled={busySlot !== null}
                  onChange={(event) => {
                    const id = event.target.value;
                    mutate(slot.slot_id, () => id ? setSkillSecretSuggestion(slug, slot.slot_id, id) : removeSkillSecretSuggestion(slug, slot.slot_id));
                  }}
                >
                  <option value="">No accessible suggestion</option>
                  {slot.candidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name} · {candidate.owner.name}</option>)}
                </select>
              </label>
            )}
          </div>
        );
      })}
      <p className="sksec-download-note"><Icon name="info" size={13} />Manual downloads do not configure secrets and do not mark this skill ready.</p>
    </div>
  );
}
