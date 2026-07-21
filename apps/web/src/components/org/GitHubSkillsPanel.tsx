"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitHubSkillInclusion,
  GitHubSkillSyncResponse,
  GitHubSkillSyncRow,
  GitHubSyncDestination,
  GitHubSyncStatus,
} from "@companion/contracts";
import {
  fetchGitHubSkillSync,
  selectGitHubDestinationSkill,
  unselectGitHubDestinationSkill,
} from "@/lib/github";
import { ApiFetchError } from "@/lib/apiClient";
import { Icon } from "../Icon";

const STATUS_PRIORITY: GitHubSyncStatus[] = ["error", "disconnected", "syncing", "pending", "synced"];

function readableDate(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function statusTone(status: GitHubSyncStatus): string {
  if (status === "synced") return "badge--ok";
  if (status === "error" || status === "disconnected") return "badge--warn";
  if (status === "pending" || status === "syncing") return "badge--accent";
  return "";
}

function inclusionLabel(inclusion: GitHubSkillInclusion): string {
  if (inclusion === "all") return "Automatic";
  if (inclusion === "selected") return "Selected";
  if (inclusion === "dependency") return "Required dependency";
  return "Not included";
}

function inclusionHint(inclusion: GitHubSkillInclusion, disconnected: boolean): string {
  if (disconnected) return "Resume this mirror before changing its skill selection.";
  if (inclusion === "all") return "This mirror publishes every active organization skill.";
  if (inclusion === "dependency") return "Another selected skill requires this skill, so it cannot be removed here.";
  if (inclusion === "selected") return "This skill is an explicit root in the repository mirror.";
  return "Add this skill as an explicit root in the repository mirror.";
}

function aggregateStatus(
  skill: GitHubSkillSyncRow,
  destinationsById: Map<string, GitHubSyncDestination>,
): GitHubSyncStatus | null {
  const statuses = skill.destinations.flatMap((entry) => {
    if (entry.inclusion === "none") return [];
    const status = destinationsById.get(entry.destination_id)?.status;
    return status ? [status] : [];
  });
  return STATUS_PRIORITY.find((status) => statuses.includes(status)) ?? null;
}

export function GitHubSkillsPanel({
  destinations,
  onRefreshDestinations,
  onManageDestination,
  onAddRepository,
}: {
  destinations: GitHubSyncDestination[];
  onRefreshDestinations: () => Promise<boolean>;
  onManageDestination: (destinationId: string) => void;
  onAddRepository: () => void;
}) {
  const [overview, setOverview] = useState<GitHubSkillSyncResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [busyDestinationId, setBusyDestinationId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    message: string;
    destinationId: string;
    manageable: boolean;
    retryable: boolean;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const skillRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const mutationInFlightRef = useRef(false);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const result = await fetchGitHubSkillSync();
      setOverview(result);
      setLoadError(null);
      setSelectedSkillId((current) => current && result.skills.some((skill) => skill.skill_id === current) ? current : null);
      return true;
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (selectedSkillId) detailHeadingRef.current?.focus();
  }, [selectedSkillId]);

  const destinationsById = useMemo(
    () => new Map(destinations.map((destination) => [destination.id, destination])),
    [destinations],
  );
  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return overview?.skills ?? [];
    return (overview?.skills ?? []).filter((skill) =>
      skill.slug.toLocaleLowerCase().includes(needle)
      || skill.display_name.toLocaleLowerCase().includes(needle),
    );
  }, [overview, query]);
  const selectedSkill = overview?.skills.find((skill) => skill.skill_id === selectedSkillId) ?? null;

  const mutateSelection = async (
    skill: GitHubSkillSyncRow,
    destination: GitHubSyncDestination,
    selected: boolean,
  ) => {
    if (mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setBusyDestinationId(destination.id);
    setActionError(null);
    setAnnouncement("");
    try {
      if (selected) await selectGitHubDestinationSkill(destination.id, skill.skill_id);
      else await unselectGitHubDestinationSkill(destination.id, skill.skill_id);
      const [overviewRefreshed, destinationsRefreshed] = await Promise.all([load(false), onRefreshDestinations()]);
      if (!overviewRefreshed || !destinationsRefreshed) {
        setActionError({
          message: "The selection was saved, but the refreshed synchronization state could not be loaded.",
          destinationId: destination.id,
          manageable: false,
          retryable: true,
        });
        setAnnouncement(`${skill.display_name} was saved, but the refreshed synchronization state could not be loaded.`);
        return;
      }
      setAnnouncement(`${skill.display_name} ${selected ? "added to" : "removed from"} ${destination.full_name}. Synchronization is pending.`);
    } catch (cause) {
      setActionError({
        message: cause instanceof Error ? cause.message : String(cause),
        destinationId: destination.id,
        manageable: cause instanceof ApiFetchError && cause.status === 409,
        retryable: false,
      });
    } finally {
      mutationInFlightRef.current = false;
      setBusyDestinationId(null);
    }
  };

  const retryRefresh = async (destinationId: string) => {
    if (mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setBusyDestinationId(destinationId);
    const [overviewRefreshed, destinationsRefreshed] = await Promise.all([load(false), onRefreshDestinations()]);
    if (overviewRefreshed && destinationsRefreshed) {
      setActionError(null);
      setAnnouncement("Synchronization state refreshed.");
    } else {
      setAnnouncement("Synchronization state could not be refreshed.");
    }
    mutationInFlightRef.current = false;
    setBusyDestinationId(null);
  };

  const returnToSkillList = (skillId: string) => {
    setSelectedSkillId(null);
    setActionError(null);
    window.requestAnimationFrame(() => {
      (skillRowRefs.current.get(skillId) ?? listHeadingRef.current)?.focus();
    });
  };

  if (loading && !overview) {
    return (
      <section className="gh-skill-pane" aria-label="Loading skill synchronization">
        <div className="gh-skill-search-skeleton" />
        <div className="gh-skill-list gh-skill-list--loading" aria-hidden="true">
          {[0, 1, 2, 3].map((item) => <div key={item} className="gh-skill-skeleton" />)}
        </div>
        <span className="sr-only" role="status">Loading skill synchronization…</span>
      </section>
    );
  }

  if (!overview) {
    return (
      <section className="gh-skill-pane">
        <div className="gh-alert" role="alert"><Icon name="alert-triangle" size={14} /><span>{loadError ?? "Skill synchronization could not be loaded."}</span></div>
        <button className="btn-sec" onClick={() => void load()}><Icon name="refresh-cw" size={14} />Retry</button>
      </section>
    );
  }

  if (selectedSkill) {
    return (
      <section className="gh-skill-pane" aria-labelledby="github-skill-detail-title">
        <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
        <div className="gh-skill-detail__head">
          <button className="btn-ghost" onClick={() => returnToSkillList(selectedSkill.skill_id)}>
            <Icon name="arrow-left" size={14} />Skills
          </button>
          <div>
            <h2 id="github-skill-detail-title" ref={detailHeadingRef} tabIndex={-1}>{selectedSkill.display_name}</h2>
            <p><code>{selectedSkill.slug}</code>{selectedSkill.current_version ? ` · v${selectedSkill.current_version}` : ""}</p>
          </div>
        </div>

        <p className="gh-skill-detail__note">
          Inclusion is desired state. Pending, syncing, or error means GitHub may still show the last applied revision.
        </p>
        {actionError && (
          <div className="gh-alert gh-skill-action-error" role="alert">
            <Icon name="alert-triangle" size={14} />
            <span>{actionError.message}</span>
            {actionError.manageable && (
              <button className="btn-sec" onClick={() => onManageDestination(actionError.destinationId)}>Manage repository</button>
            )}
            {actionError.retryable && (
              <button className="btn-sec" onClick={() => void retryRefresh(actionError.destinationId)}>Retry refresh</button>
            )}
          </div>
        )}

        {destinations.length === 0 ? (
          <div className="sx-empty gh-skill-empty">
            <Icon name="git-branch" size={20} />
            <strong>No repository mirrors yet</strong>
            <span>Add a repository before choosing where this skill should be synchronized.</span>
            <button className="btn-primary" onClick={onAddRepository}><Icon name="plus" size={14} />Add repository</button>
          </div>
        ) : (
          <div className="gh-skill-destinations">
            {destinations.map((destination) => {
              const inclusion = selectedSkill.destinations.find((entry) => entry.destination_id === destination.id)?.inclusion ?? "none";
              const checked = inclusion !== "none";
              const disconnected = destination.status === "disconnected";
              const mutable = destination.mode === "selected"
                && !disconnected
                && (inclusion === "selected" || inclusion === "none");
              const busy = busyDestinationId !== null;
              return (
                <article className="gh-skill-destination" key={destination.id}>
                  <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                    {`${destination.full_name} synchronization status: ${destination.status}${destination.last_error ? `. ${destination.last_error}` : ""}`}
                  </span>
                  <div className="gh-skill-destination__main">
                    <div className="gh-skill-destination__title">
                      <a href={destination.html_url} target="_blank" rel="noreferrer">{destination.full_name}</a>
                      <span className={`badge ${statusTone(destination.status)}`}>{destination.status}</span>
                    </div>
                    <div className="gh-skill-destination__meta">
                      <span className="badge">{inclusionLabel(inclusion)}</span>
                      <span>Last sync: {readableDate(destination.last_synced_at)}</span>
                      {destination.last_commit_sha && <span className="mono">Commit {destination.last_commit_sha.slice(0, 8)}</span>}
                    </div>
                    <p>{inclusionHint(inclusion, disconnected)}</p>
                    {destination.last_error && <div className="gh-row__error"><Icon name="alert-triangle" size={13} />{destination.last_error}</div>}
                  </div>
                  <label className={`gh-skill-switch${busy ? " is-busy" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!mutable || busy}
                      aria-label={`Synchronize ${selectedSkill.display_name} to ${destination.full_name}`}
                      onChange={(event) => void mutateSelection(selectedSkill, destination, event.target.checked)}
                    />
                    <span className="gh-skill-switch__track" aria-hidden="true" />
                    <span className="gh-skill-switch__thumb" aria-hidden="true" />
                  </label>
                </article>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="gh-skill-pane" aria-labelledby="github-skills-heading">
      <div className="gh-skill-pane__head">
        <div><h2 id="github-skills-heading" ref={listHeadingRef} tabIndex={-1}>Organization skills</h2><p>Choose a skill to manage its repository mirrors.</p></div>
        <label className="gh-skill-search">
          <span className="sr-only">Search organization skills</span>
          <Icon name="search" size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills…" />
        </label>
      </div>
      {loadError && <div className="gh-alert" role="alert"><Icon name="alert-triangle" size={14} /><span>{loadError}</span><button className="btn-sec" onClick={() => void load(false)}>Retry</button></div>}
      {overview.skills.length === 0 ? (
        <div className="sx-empty gh-skill-empty"><Icon name="package" size={20} /><strong>No active organization skills</strong><span>Publish or restore an organization skill to manage its GitHub mirrors.</span></div>
      ) : filteredSkills.length === 0 ? (
        <div className="sx-empty">No skills match “{query.trim()}”.</div>
      ) : (
        <div className="gh-skill-list">
          {filteredSkills.map((skill) => {
            const included = skill.destinations.filter((entry) => entry.inclusion !== "none" && destinationsById.has(entry.destination_id)).length;
            const status = aggregateStatus(skill, destinationsById);
            return (
              <button
                key={skill.skill_id}
                ref={(node) => { if (node) skillRowRefs.current.set(skill.skill_id, node); else skillRowRefs.current.delete(skill.skill_id); }}
                className="gh-skill-row"
                onClick={() => { setSelectedSkillId(skill.skill_id); setActionError(null); }}
              >
                <span className="gh-skill-row__identity"><strong>{skill.display_name}</strong><code>{skill.slug}{skill.current_version ? ` · v${skill.current_version}` : ""}</code></span>
                <span className="gh-skill-row__summary">
                  <span>{included === 0 ? "Not synchronized" : `${included} of ${destinations.length} repositor${destinations.length === 1 ? "y" : "ies"}`}</span>
                  {status && <span className={`badge ${statusTone(status)}`}>{status}</span>}
                  <Icon name="chevron-right" size={14} />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
