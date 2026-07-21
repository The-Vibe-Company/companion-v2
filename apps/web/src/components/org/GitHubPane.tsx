"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitHubInstallation,
  GitHubRepositoryCandidate,
  GitHubSyncDestination,
  GitHubSyncMode,
  SkillListRow,
} from "@companion/contracts";
import {
  beginGitHubConnection,
  createGitHubDestination,
  createGitHubRepository,
  deleteGitHubDestination,
  disconnectGitHubAccount,
  fetchGitHubIntegration,
  fetchGitHubRepositories,
  syncGitHubDestination,
  updateGitHubDestination,
} from "@/lib/github";
import { fetchSkillLibrary } from "@/lib/queries";
import { Icon } from "../Icon";
import { UserAvatar } from "../UserAvatar";
import { PaneHead } from "./paneKit";
import type { OrgCtx } from "./model";

type Editor = { kind: "new" } | { kind: "edit"; destination: GitHubSyncDestination } | null;
type FocusTarget =
  | { kind: "connect" }
  | { kind: "destination"; id: string }
  | { kind: "mirrors-heading" };

function readableDate(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function statusTone(status: GitHubSyncDestination["status"]): string {
  if (status === "synced") return "badge--ok";
  if (status === "error") return "badge--warn";
  if (status === "pending" || status === "syncing") return "badge--accent";
  return "";
}

export function GitHubPane({ ctx }: { ctx: OrgCtx }) {
  const [integration, setIntegration] = useState<Awaited<ReturnType<typeof fetchGitHubIntegration>> | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepositoryCandidate[]>([]);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillListRow[]>([]);
  const [editor, setEditor] = useState<Editor>(null);
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [mode, setMode] = useState<GitHubSyncMode>("all");
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState("");
  const [createOwner, setCreateOwner] = useState("");
  const [createName, setCreateName] = useState("");
  const [createPrivate, setCreatePrivate] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [integrationLoading, setIntegrationLoading] = useState(true);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);
  const editorReturnFocusRef = useRef<HTMLElement | null>(null);
  const addRepositoryButtonRef = useRef<HTMLButtonElement>(null);
  const connectButtonRef = useRef<HTMLButtonElement>(null);
  const mirrorsHeadingRef = useRef<HTMLHeadingElement>(null);
  const destinationLinkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const pendingFocusRef = useRef<FocusTarget | null>(null);

  const load = useCallback(async (focusTarget?: FocusTarget) => {
    setIntegrationLoading(true);
    try {
      const next = await fetchGitHubIntegration();
      setLoadError(null);
      if (focusTarget) pendingFocusRef.current = focusTarget;
      setIntegration(next);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIntegrationLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setCallbackError(new URLSearchParams(window.location.search).get("github_error"));
  }, []);
  useEffect(() => {
    if (!integration?.destinations.some((destination) =>
      destination.status === "pending"
      || destination.status === "syncing"
      || (destination.status === "error" && Boolean(destination.next_retry_at)))) return;
    const timer = window.setInterval(() => void load(), 4_000);
    return () => window.clearInterval(timer);
  }, [integration, load]);
  useEffect(() => {
    if (!editor) return;
    editorHeadingRef.current?.focus();
  }, [editor]);
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    const target = pending.kind === "connect"
      ? connectButtonRef.current
      : pending.kind === "destination"
        ? destinationLinkRefs.current.get(pending.id) ?? null
        : mirrorsHeadingRef.current;
    if (target?.isConnected) target.focus();
  }, [integration]);

  const clearErrors = useCallback(() => {
    setCallbackError(null);
    setActionError(null);
  }, []);

  const loadRepositoryChoices = useCallback(async () => {
    const [github, orgSkills] = await Promise.all([fetchGitHubRepositories(), fetchSkillLibrary("org")]);
    setRepositories(github.repositories);
    setInstallations(github.installations);
    setInstallUrl(github.install_url);
    setSkills(orgSkills.filter((skill) => !skill.archived));
    if (!createOwner && github.installations[0]) setCreateOwner(github.installations[0].owner);
  }, [createOwner]);

  const openNew = async (trigger: HTMLElement) => {
    editorReturnFocusRef.current = trigger;
    setEditor({ kind: "new" });
    setMode("all");
    setSelectedSkillIds([]);
    setSelectedRepoId("");
    setConfirmation("");
    clearErrors();
    try { await loadRepositoryChoices(); } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const openEdit = async (destination: GitHubSyncDestination, trigger: HTMLElement) => {
    editorReturnFocusRef.current = trigger;
    setEditor({ kind: "edit", destination });
    setMode(destination.mode);
    setSelectedSkillIds(destination.selected_skill_ids);
    clearErrors();
    try {
      const [orgSkills, archivedOrgSkills] = await Promise.all([
        fetchSkillLibrary("org"),
        fetchSkillLibrary("org", true),
      ]);
      setSkills([...orgSkills, ...archivedOrgSkills].filter(
        (skill) => !skill.archived || destination.selected_skill_ids.includes(skill.id),
      ));
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const closeEditor = useCallback(() => {
    const returnTarget = editorReturnFocusRef.current;
    const returnToAddButton = editor?.kind === "new";
    setEditor(null);
    window.requestAnimationFrame(() => {
      const target = returnToAddButton ? addRepositoryButtonRef.current : returnTarget;
      if (target?.isConnected) target.focus();
    });
  }, [editor?.kind]);

  const candidate = repositories.find((repository) => repository.repository_id === selectedRepoId) ?? null;
  const selectedCount = selectedSkillIds.length;

  const connect = async () => {
    setBusy("connect");
    clearErrors();
    try {
      const result = await beginGitHubConnection();
      window.location.assign(result.url);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    }
  };

  const createRepo = async () => {
    const installation = installations.find((item) => item.owner === createOwner);
    if (!installation || !createName.trim()) return;
    setBusy("create-repo");
    clearErrors();
    try {
      const result = await createGitHubRepository({
        installation_id: installation.installation_id,
        owner: installation.owner,
        name: createName.trim(),
        private: createPrivate,
      });
      setRepositories((current) => [...current, result.repository].sort((a, b) => a.full_name.localeCompare(b.full_name)));
      setSelectedRepoId(result.repository.repository_id);
      setCreateName("");
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  const saveEditor = async () => {
    if (mode === "selected" && selectedCount === 0) return;
    setBusy("save");
    clearErrors();
    try {
      if (editor?.kind === "edit") {
        await updateGitHubDestination(editor.destination.id, { mode, selected_skill_ids: selectedSkillIds });
      } else if (candidate) {
        await createGitHubDestination({
          installation_id: candidate.installation_id,
          repository_id: candidate.repository_id,
          owner: candidate.owner,
          name: candidate.name,
          html_url: candidate.html_url,
          default_branch: candidate.default_branch || "main",
          private: candidate.private,
          mode,
          selected_skill_ids: selectedSkillIds,
          repository_empty: candidate.empty,
          overwrite_confirmation: confirmation || undefined,
        });
      }
      closeEditor();
      await load();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  const canSave = editor?.kind === "edit"
    ? mode === "all" || selectedCount > 0
    : Boolean(candidate && (candidate.empty || confirmation === candidate.full_name) && (mode === "all" || selectedCount > 0));

  const sortedSkills = useMemo(() => [...skills].sort((a, b) => a.slug.localeCompare(b.slug)), [skills]);
  const actionOrCallbackError = callbackError ?? actionError;
  const displayedError = actionOrCallbackError ?? loadError;

  if (!integration) {
    return (
      <div className="sx-pane sx-pane--github">
        <PaneHead
          title="GitHub"
          desc={loadError ? "GitHub synchronization could not be loaded." : "Loading GitHub synchronization…"}
        />
        {actionOrCallbackError && <div className="gh-alert" role="alert"><Icon name="alert-triangle" size={14} /><span>{actionOrCallbackError}</span></div>}
        {loadError && <div className="gh-alert" role="alert"><Icon name="alert-triangle" size={14} /><span>{loadError}</span></div>}
        {loadError && (
          <button className="btn-sec" disabled={integrationLoading} onClick={() => void load()}>
            <Icon name="refresh-cw" size={14} />
            {integrationLoading ? "Retrying…" : "Retry"}
          </button>
        )}
      </div>
    );
  }
  const { connection, destinations } = integration;

  return (
    <div className="sx-pane sx-pane--github">
      <PaneHead
        title="GitHub"
        desc="Mirror organization skills to GitHub repositories. Companion is the source of truth and replaces the repository branch on every sync."
        action={connection.configured && connection.connected && !editor ? (
          <button ref={addRepositoryButtonRef} className="btn-primary" onClick={(event) => void openNew(event.currentTarget)}><Icon name="plus" size={14} />Add repository</button>
        ) : undefined}
      />

      {displayedError && <div className="gh-alert" role="alert"><Icon name="alert-triangle" size={14} /><span>{displayedError}</span></div>}

      {!connection.configured ? (
        <div className="og-lockbar og-lockbar--wide">
          <Icon name="lock" size={13} />
          GitHub sync is unavailable. Configure OAuth credentials on the API, App ID and private key on the worker,
          and enable COMPANION_GITHUB_SYNC_ENABLED, then restart Companion.
        </div>
      ) : !connection.connected ? (
        <section className="gh-connect">
          <div className="gh-connect__mark"><Icon name="github" size={22} /></div>
          <div className="gh-connect__copy">
            <h2>Connect the {connection.app_name} GitHub App</h2>
            <p>Authorize your GitHub identity, choose repository access, then configure one or more independent mirrors. No personal access token is needed.</p>
            {destinations.length > 0 && (
              <div className="gh-resume-note" role="note">
                <strong>{destinations.length} mirror{destinations.length === 1 ? " remains" : "s remain"} paused</strong>
                <span>{destinations.map((destination) => destination.full_name).join(", ")}</span>
                <small>Reconnecting does not write to these repositories. Resume each mirror explicitly after authorization.</small>
              </div>
            )}
          </div>
          <button ref={connectButtonRef} className="btn-primary" disabled={busy === "connect"} onClick={() => void connect()}>
            <Icon name="github" size={15} />
            {connection.managed ? "Install Companion on GitHub" : `Install ${connection.app_name}`}
          </button>
        </section>
      ) : (
        <>
          <section className="gh-account" aria-label="Connected GitHub account">
            <div className="gh-account__identity">
              <UserAvatar
                className="gh-account__avatar"
                avatarUrl={connection.github_avatar_url}
                initials={(connection.github_login ?? "GH").slice(0, 2).toUpperCase()}
              />
              <div><strong>{connection.github_login}</strong><small>Connected with {connection.app_name}</small></div>
            </div>
            <button className="btn-sec" onClick={async () => {
              if (!window.confirm("Disconnect this GitHub account? Existing repositories will be left unchanged.")) return;
              clearErrors();
              setBusy("disconnect");
              try { await disconnectGitHubAccount(); setEditor(null); await load({ kind: "connect" }); }
              catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
              finally { setBusy(null); }
            }} disabled={busy === "disconnect"}>Disconnect</button>
          </section>

          {editor && (
            <section className="gh-editor" aria-labelledby="github-editor-title">
              <div className="gh-editor__head">
                <div><h2 id="github-editor-title" ref={editorHeadingRef} tabIndex={-1}>{editor.kind === "new" ? "Add a repository mirror" : `Edit ${editor.destination.full_name}`}</h2>
                  <p>{editor.kind === "new" ? "Choose an App-accessible repo or create a new one." : "Change which organization skills this mirror publishes."}</p></div>
                <button className="iconbtn" aria-label="Close editor" onClick={closeEditor}><Icon name="x" size={15} /></button>
              </div>

              {editor.kind === "new" && (
                <>
                  <div className="sx-field">
                    <label className="sx-field__label" htmlFor="github-repository">Repository</label>
                    <select id="github-repository" className="sx-input" value={selectedRepoId} onChange={(event) => { setSelectedRepoId(event.target.value); setConfirmation(""); }}>
                      <option value="">Select a repository…</option>
                      {repositories.map((repository) => <option key={repository.repository_id} value={repository.repository_id}>{repository.full_name}{repository.private ? " · private" : " · public"}</option>)}
                    </select>
                    <span className="sx-field__hint">Only repositories granted to the installed App are listed. <a href={installUrl ?? "#"} target="_blank" rel="noreferrer">Configure repository access</a></span>
                  </div>

                  {candidate && !candidate.empty && (
                    <div className="gh-overwrite">
                      <Icon name="alert-triangle" size={15} />
                      <div><strong>This repository is not empty.</strong><p>Every file on its default branch will be replaced. Type <code>{candidate.full_name}</code> to confirm.</p>
                        <input className="sx-input sx-input--mono" aria-label="Repository overwrite confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div>
                    </div>
                  )}

                  <details className="gh-create">
                    <summary>Create a new repository</summary>
                    {installations.length === 0 ? (
                      <p className="sx-field__hint">Install the App on a GitHub account or organization before creating a repository.</p>
                    ) : (
                      <div className="gh-create__fields">
                        <select className="sx-input" aria-label="Repository owner" value={createOwner} onChange={(event) => setCreateOwner(event.target.value)}>
                          {installations.map((installation) => <option key={installation.installation_id} value={installation.owner}>{installation.owner}</option>)}
                        </select>
                        <input className="sx-input sx-input--mono" aria-label="New repository name" placeholder="companion-skills" value={createName} onChange={(event) => setCreateName(event.target.value)} />
                        <label className="gh-private"><input type="checkbox" checked={createPrivate} onChange={(event) => setCreatePrivate(event.target.checked)} />Private</label>
                        <button className="btn-sec" disabled={!createName.trim() || busy === "create-repo"} onClick={() => void createRepo()}><Icon name="plus" size={14} />Create</button>
                      </div>
                    )}
                  </details>
                </>
              )}

              <fieldset className="gh-mode">
                <legend>Skills to synchronize</legend>
                <label className={mode === "all" ? "is-selected" : ""}><input type="radio" name="github-sync-mode" checked={mode === "all"} onChange={() => setMode("all")} /><span><strong>All organization skills</strong><small>New, renamed and restored skills are included automatically.</small></span></label>
                <label className={mode === "selected" ? "is-selected" : ""}><input type="radio" name="github-sync-mode" checked={mode === "selected"} onChange={() => setMode("selected")} /><span><strong>Selected skills</strong><small>Required skill dependencies are added automatically.</small></span></label>
              </fieldset>

              {mode === "selected" && (
                <div className="gh-skills" role="group" aria-label="Organization skills to synchronize">
                  {sortedSkills.length === 0 ? <p>No active organization skills are available.</p> : sortedSkills.map((skill) => (
                    <label key={skill.id}><input type="checkbox" checked={selectedSkillIds.includes(skill.id)} onChange={(event) => setSelectedSkillIds((current) => event.target.checked ? [...current, skill.id] : current.filter((id) => id !== skill.id))} />
                      <span><strong>{skill.display.name ?? skill.slug}</strong><code>{skill.slug}{skill.current_version ? ` · v${skill.current_version}` : ""}</code>{skill.archived && <small>Archived · paused until restored</small>}</span></label>
                  ))}
                  <div className="gh-skills__foot">{selectedCount} selected · dependencies will be included during sync</div>
                </div>
              )}

              <div className="sx-row-actions">
                <button className="btn-primary" disabled={!canSave || busy === "save"} onClick={() => void saveEditor()}><Icon name="check" size={14} />{editor.kind === "new" ? "Add mirror" : "Save selection"}</button>
                <button className="btn-sec" onClick={closeEditor}>Cancel</button>
              </div>
            </section>
          )}

          <section className="sx-sec">
            <h2 ref={mirrorsHeadingRef} className="sx-sec__h" tabIndex={-1}>Repository mirrors</h2>
            <p className="sx-sec__d">GitHub changes are overwritten on the next sync or drift check. Disconnecting a mirror never deletes its repository.</p>
            {destinations.length === 0 ? (
              <div className="sx-empty">No repository mirrors yet.</div>
            ) : (
              <div className="gh-list">
                {destinations.map((destination, index) => {
                  const automaticDependencies = Math.max(0, destination.resolved_skill_count - destination.selected_skill_ids.length);
                  const fallbackDestinationId = destinations[index + 1]?.id ?? destinations[index - 1]?.id ?? null;
                  return (
                    <article className="gh-row" key={destination.id}>
                      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                        {`${destination.full_name} synchronization status: ${destination.status}${destination.last_error ? `. ${destination.last_error}` : ""}`}
                      </span>
                      <div className="gh-row__top">
                        <div className="gh-repo"><span><Icon name="git-branch" size={15} /></span><div><a
                          ref={(node) => {
                            if (node) destinationLinkRefs.current.set(destination.id, node);
                            else destinationLinkRefs.current.delete(destination.id);
                          }}
                          href={destination.html_url}
                          target="_blank"
                          rel="noreferrer"
                        >{destination.full_name}</a><small>{destination.private ? "Private" : "Public"} · {destination.default_branch}</small></div></div>
                        <span className={`badge ${statusTone(destination.status)}`}>{destination.status}</span>
                      </div>
                      <div className="gh-row__meta">
                        <span>{destination.mode === "all" ? "All org skills" : `${destination.selected_skill_ids.length} selected`}</span>
                        {destination.mode === "selected" && automaticDependencies > 0 && <span>+{automaticDependencies} dependencies</span>}
                        <span>Last sync: {readableDate(destination.last_synced_at)}</span>
                        {destination.last_commit_sha && <span className="mono">Commit {destination.last_commit_sha.slice(0, 8)}</span>}
                      </div>
                      {destination.last_error && <div className="gh-row__error" role="alert"><Icon name="alert-triangle" size={13} />{destination.last_error}{destination.next_retry_at ? ` · retry ${readableDate(destination.next_retry_at)}` : ""}</div>}
                      <div className="gh-command"><code>npx skills add {destination.full_name}</code><button className="iconbtn" aria-label={`Copy install command for ${destination.full_name}`} onClick={() => void navigator.clipboard.writeText(`npx skills add ${destination.full_name}`)}><Icon name="copy" size={13} /></button></div>
                      <div className="gh-row__install-note">
                        {destination.private ? "Private repositories require local Git authentication to install." : "Public mirrors can also be referenced from skills.sh."}
                      </div>
                      <div className="gh-row__actions">
                        {destination.status === "disconnected" ? (
                          <button className="btn-primary" disabled={busy === `sync-${destination.id}`} onClick={async () => { if (!window.confirm(`Resume ${destination.full_name}? Companion will replace its default branch on the next sync.`)) return; setBusy(`sync-${destination.id}`); clearErrors(); try { await syncGitHubDestination(destination.id, true); await load({ kind: "destination", id: destination.id }); } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(null); } }}><Icon name="refresh-cw" size={13} />Resume mirror</button>
                        ) : (
                          <>
                            <button className="btn-sec" onClick={(event) => void openEdit(destination, event.currentTarget)}>Edit selection</button>
                            <button className="btn-sec" disabled={busy === `sync-${destination.id}`} onClick={async () => { setBusy(`sync-${destination.id}`); clearErrors(); try { await syncGitHubDestination(destination.id); await load(); } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(null); } }}><Icon name="refresh-cw" size={13} />Sync now</button>
                          </>
                        )}
                        <button className="iconbtn gh-row__remove" aria-label={`Disconnect ${destination.full_name}`} onClick={async () => { if (!window.confirm(`Disconnect ${destination.full_name}? The GitHub repository will not be deleted.`)) return; clearErrors(); try { await deleteGitHubDestination(destination.id); await load(fallbackDestinationId ? { kind: "destination", id: fallbackDestinationId } : { kind: "mirrors-heading" }); } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); } }}><Icon name="trash-2" size={14} /></button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
