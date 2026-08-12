"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  Companion,
  CompanionProviderAuthMethod,
  CompanionProvidersResponse,
  SaveCompanionProviderInput,
} from "@companion/contracts";
import type { OrgVM } from "@/lib/types";
import {
  createCompanion,
  deleteCompanionProvider,
  saveCompanionProvider,
  setDefaultCompanionProvider,
} from "@/lib/companions";
import { Icon } from "../Icon";
import { Onboarding } from "../org/Onboarding";
import { useOrgActions } from "../org/useOrgActions";
import { Sidebar } from "../skills/Sidebar";
import { skillsRouteHref, type SkillsLibrary } from "../skills/route";
import type { TreeRow } from "../skills/sidebarTree";

export interface CompanionNavigation {
  mineTreeRows: TreeRow[];
  orgTreeRows: TreeRow[];
  mineCount: number;
  orgCount: number;
  installedCount: number;
  installedUpdateCount: number;
  localUpdateCount: number;
  archivedCount: number;
}

export function CompanionsApp({
  orgs,
  currentOrg,
  navigation,
  initialCompanions,
  initialProviders,
}: {
  orgs: OrgVM[];
  currentOrg: OrgVM;
  navigation: CompanionNavigation;
  initialCompanions: Companion[];
  initialProviders: CompanionProvidersResponse;
}) {
  const router = useRouter();
  const orgActions = useOrgActions();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [companions, setCompanions] = useState(initialCompanions);
  const [providers, setProviders] = useState(initialProviders);
  const [name, setName] = useState("");
  const [selectedProvider, setSelectedProvider] = useState(
    initialProviders.default_provider_id ?? initialProviders.connections[0]?.provider_id ?? "",
  );
  const firstAvailableProvider = initialProviders.catalog.find(
    (provider) => !initialProviders.connections.some(
      (connection) => connection.provider_id === provider.id,
    ),
  );
  const [providerToAdd, setProviderToAdd] = useState(firstAvailableProvider?.id ?? "");
  const [authMethod, setAuthMethod] = useState<CompanionProviderAuthMethod>(
    firstAvailableProvider?.auth_methods[0] ?? "api_key",
  );
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState<"create" | "provider" | "default" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const noop = () => {};
  const connectedIds = useMemo(
    () => new Set(providers.connections.map((connection) => connection.provider_id)),
    [providers.connections],
  );
  const providersAvailableToAdd = providers.catalog.filter((provider) => !connectedIds.has(provider.id));
  const selectedProviderDefinition = providers.catalog.find((provider) => provider.id === providerToAdd);

  const providerName = (providerId: string) =>
    providers.catalog.find((provider) => provider.id === providerId)?.name ?? providerId;

  const onCreateCompanion = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProvider) {
      setError("Connect a provider before creating a Companion.");
      return;
    }
    setBusy("create");
    setError(null);
    try {
      const companion = await createCompanion(currentOrg.id, {
        name: name.trim(),
        provider_id: selectedProvider,
      });
      setCompanions((current) => [companion, ...current]);
      setName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Companion could not be created.");
    } finally {
      setBusy(null);
    }
  };

  const onSaveProvider = async (event: FormEvent) => {
    event.preventDefault();
    if (!providerToAdd) return;
    setBusy("provider");
    setError(null);
    try {
      const parsedCredential = authMethod === "subscription"
        ? JSON.parse(credential) as Record<string, unknown>
        : credential.trim();
      if (
        authMethod === "subscription"
        && (!parsedCredential || typeof parsedCredential !== "object" || parsedCredential.type !== "oauth")
      ) {
        throw new Error("Paste one Pi subscription entry whose type is oauth.");
      }
      const input: SaveCompanionProviderInput = authMethod === "subscription"
        ? { auth_method: "subscription", credential: parsedCredential as Record<string, unknown> }
        : { auth_method: "api_key", credential: parsedCredential as string };
      const connection = await saveCompanionProvider(currentOrg.id, providerToAdd, input);
      let defaultProviderId = providers.default_provider_id;
      if (!defaultProviderId) {
        await setDefaultCompanionProvider(currentOrg.id, providerToAdd);
        defaultProviderId = providerToAdd;
        setSelectedProvider(providerToAdd);
      }
      const nextConnections = [...providers.connections, connection];
      setProviders((current) => ({
        ...current,
        connections: nextConnections,
        default_provider_id: defaultProviderId,
      }));
      setCredential("");
      const next = providers.catalog.find((provider) =>
        !nextConnections.some((candidate) => candidate.provider_id === provider.id));
      setProviderToAdd(next?.id ?? "");
      setAuthMethod(next?.auth_methods[0] ?? "api_key");
    } catch (cause) {
      setError(cause instanceof SyntaxError
        ? "Subscription credential must be valid JSON."
        : cause instanceof Error ? cause.message : "Provider could not be connected.");
    } finally {
      setBusy(null);
    }
  };

  const onDefaultProvider = async (providerId: string) => {
    setBusy("default");
    setError(null);
    try {
      await setDefaultCompanionProvider(currentOrg.id, providerId);
      setProviders((current) => ({ ...current, default_provider_id: providerId }));
      setSelectedProvider(providerId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Default provider could not be saved.");
    } finally {
      setBusy(null);
    }
  };

  const onDeleteProvider = async (providerId: string) => {
    if (!window.confirm(
      `Disconnect ${providerName(providerId)}? Companions using it cannot start until it is reconnected.`,
    )) return;
    setBusy("delete");
    setError(null);
    try {
      await deleteCompanionProvider(currentOrg.id, providerId);
      const nextConnections = providers.connections.filter(
        (connection) => connection.provider_id !== providerId,
      );
      setProviders((current) => ({
        ...current,
        connections: nextConnections,
        default_provider_id:
          current.default_provider_id === providerId ? null : current.default_provider_id,
      }));
      if (selectedProvider === providerId) setSelectedProvider(nextConnections[0]?.provider_id ?? "");
      if (!providerToAdd) {
        const restored = providers.catalog.find((provider) => provider.id === providerId);
        setProviderToAdd(providerId);
        setAuthMethod(restored?.auth_methods[0] ?? "api_key");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider could not be disconnected.");
    } finally {
      setBusy(null);
    }
  };

  const navigateToLabel = (lib: SkillsLibrary, path: string) => {
    router.push(skillsRouteHref({ lib, kind: "label", label: path }));
  };
  const toggleExpanded = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMobileSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileSidebarOpen]);

  return (
    <div className={"app app--skills companions-app" + (mobileSidebarOpen ? " app--side-open" : "")}>
      <Sidebar
        orgs={orgs}
        currentOrg={currentOrg}
        onSwitchOrg={orgActions.switchOrg}
        onOnboard={orgActions.setOnboarding}
        onOpenSettings={() => router.push("/settings")}
        onWarmSettings={noop}
        mineTreeRows={navigation.mineTreeRows}
        orgTreeRows={navigation.orgTreeRows}
        expanded={expanded}
        onToggleExpand={toggleExpanded}
        selection={null}
        mineCount={navigation.mineCount}
        orgCount={navigation.orgCount}
        installedCount={navigation.installedCount}
        installedUpdateCount={navigation.installedUpdateCount}
        onOpenPalette={() => router.push("/skills")}
        onSelectMineAll={() => router.push(skillsRouteHref({ lib: "mine", kind: "all" }))}
        onSelectOrgAll={() => router.push(skillsRouteHref({ lib: "org", kind: "all" }))}
        onSelectInstalled={() => router.push(skillsRouteHref({ lib: "mine", kind: "installed" }))}
        onSelectLabel={navigateToLabel}
        onCreateLabel={noop}
        onSetLabelColor={noop}
        onSetLabelIcon={noop}
        onRenameLabel={noop}
        onDeleteLabel={noop}
        drag={null}
        hovered={null}
        openPendingPath={null}
        dropDone={null}
        onReparentLabel={noop}
        onLabelStartDrag={noop}
        onSelectLocal={() => router.push(skillsRouteHref({ kind: "local" }))}
        onSelectArchived={() => router.push(skillsRouteHref({ kind: "archived" }))}
        onSelectSecrets={() => router.push("/secrets")}
        onSelectCompanions={noop}
        companionsEnabled
        companionsActive
        navigationOnly
        localActive={false}
        localUpdateCount={navigation.localUpdateCount}
        archivedActive={false}
        archivedCount={navigation.archivedCount}
        mobileOpen={mobileSidebarOpen}
        onToggleMobile={() => setMobileSidebarOpen((open) => !open)}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />
      {mobileSidebarOpen && (
        <button
          type="button"
          className="side-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      <main
        className="companions-main"
        aria-hidden={mobileSidebarOpen || undefined}
        inert={mobileSidebarOpen ? true : undefined}
      >
        <header className="companions-head">
          <div>
            <p>Workspace</p>
            <h1>Companions</h1>
            <span>Create a Companion with one connected model provider.</span>
          </div>
        </header>
        <div className="companions-content">
          {error && (
            <div className="companions-error" role="alert">
              {error}
            </div>
          )}

          <section className="companions-section" aria-labelledby="companion-create-title">
            <div className="companions-section-head">
              <div>
                <h2 id="companion-create-title">Create Companion</h2>
                <p>The provider can be changed by creating another Companion.</p>
              </div>
            </div>
            <form className="companions-create-form" onSubmit={onCreateCompanion}>
              <label>
                Name
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Research"
                />
              </label>
              <label>
                Provider
                <select
                  required
                  value={selectedProvider}
                  onChange={(event) => setSelectedProvider(event.target.value)}
                  disabled={!providers.connections.length}
                >
                  {!providers.connections.length && <option value="">No connected providers</option>}
                  {providers.connections.map((connection) => (
                    <option key={connection.provider_id} value={connection.provider_id}>
                      {providerName(connection.provider_id)}
                      {providers.default_provider_id === connection.provider_id ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="cds-btn cds-btn--primary cds-btn--md"
                disabled={busy !== null || !providers.connections.length || !name.trim()}
              >
                {busy === "create" ? "Creating..." : "Create Companion"}
              </button>
            </form>
          </section>

          <section className="companions-section" aria-labelledby="companion-providers-title">
            <div className="companions-section-head">
              <div>
                <h2 id="companion-providers-title">Providers</h2>
                <p>Credentials stay encrypted and are sent only to the selected Companion.</p>
              </div>
            </div>
            {providers.connections.length ? (
              <div className="companions-provider-list">
                {providers.connections.map((connection) => (
                  <div className="companions-provider-row" key={connection.provider_id}>
                    <div>
                      <strong>{providerName(connection.provider_id)}</strong>
                      <span>
                        {connection.auth_method === "api_key" ? "API key" : "Subscription"}
                        {providers.default_provider_id === connection.provider_id
                          ? " · Workspace default"
                          : ""}
                      </span>
                    </div>
                    {providers.can_manage && (
                      <div className="companions-provider-actions">
                        {providers.default_provider_id !== connection.provider_id && (
                          <button
                            type="button"
                            className="cds-btn cds-btn--secondary cds-btn--sm"
                            disabled={busy !== null}
                            onClick={() => void onDefaultProvider(connection.provider_id)}
                          >
                            Make default
                          </button>
                        )}
                        <button
                          type="button"
                          className="cds-btn cds-btn--ghost cds-btn--sm"
                          disabled={busy !== null}
                          onClick={() => void onDeleteProvider(connection.provider_id)}
                        >
                          Disconnect
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="companions-provider-empty">
                <Icon name="bot" size={20} />
                <div>
                  <strong>No provider connected</strong>
                  <span>
                    {providers.can_manage
                      ? "Connect one provider to create a Companion."
                      : "Ask a workspace admin to connect a provider."}
                  </span>
                </div>
              </div>
            )}

            {providers.can_manage && providersAvailableToAdd.length > 0 && (
              <details className="companions-provider-add" open={!providers.connections.length}>
                <summary>Connect provider</summary>
                <form onSubmit={onSaveProvider}>
                  <label>
                    Provider
                    <select
                      value={providerToAdd}
                      onChange={(event) => {
                        const providerId = event.target.value;
                        const definition = providers.catalog.find((provider) => provider.id === providerId);
                        setProviderToAdd(providerId);
                        setAuthMethod(definition?.auth_methods[0] ?? "api_key");
                        setCredential("");
                      }}
                    >
                      {providersAvailableToAdd.map((provider) => (
                        <option key={provider.id} value={provider.id}>{provider.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Authentication
                    <select
                      value={authMethod}
                      onChange={(event) => {
                        setAuthMethod(event.target.value as CompanionProviderAuthMethod);
                        setCredential("");
                      }}
                    >
                      {selectedProviderDefinition?.auth_methods.map((method) => (
                        <option key={method} value={method}>
                          {method === "api_key" ? "API key" : "Subscription"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="companions-credential">
                    {authMethod === "api_key" ? "API key" : "Pi subscription credential"}
                    {authMethod === "api_key" ? (
                      <input
                        required
                        type="password"
                        autoComplete="off"
                        value={credential}
                        onChange={(event) => setCredential(event.target.value)}
                      />
                    ) : (
                      <>
                        <input
                          required
                          type="password"
                          autoComplete="off"
                          value={credential}
                          onChange={(event) => setCredential(event.target.value)}
                          placeholder={'{"type":"oauth", ...}'}
                        />
                        <span>Paste only this provider's entry from Pi <code>auth.json</code>.</span>
                      </>
                    )}
                  </label>
                  <button
                    type="submit"
                    className="cds-btn cds-btn--secondary cds-btn--md"
                    disabled={busy !== null || !credential.trim() || !providerToAdd}
                  >
                    {busy === "provider" ? "Connecting..." : "Connect provider"}
                  </button>
                </form>
              </details>
            )}
          </section>

          <section className="companions-section" aria-labelledby="companion-list-title">
            <div className="companions-section-head">
              <div>
                <h2 id="companion-list-title">Workspace Companions</h2>
                <p>{companions.length} total</p>
              </div>
            </div>
            {companions.length ? (
              <div className="companions-list">
                {companions.map((companion) => (
                  <div className="companions-row" key={companion.id}>
                    <div>
                      <strong>{companion.name}</strong>
                      <span>{providerName(companion.runtime.provider_ids[0] ?? "unconfigured")}</span>
                    </div>
                    <span className="companions-state">
                      <i aria-hidden="true" />
                      {companion.runtime.state.replace("_", " ")}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="companions-list-empty">
                <Icon name="bot" size={20} />
                <div>
                  <strong>No Companions yet</strong>
                  <span>Choose a provider above to create the first one.</span>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      {orgActions.onboarding && (
        <Onboarding
          mode={orgActions.onboarding}
          onMode={orgActions.setOnboarding}
          onCreate={orgActions.createOrg}
          onJoin={orgActions.joinOrg}
          busy={orgActions.busy}
        />
      )}
      {orgActions.error && (
        <div className="og-toast" role="alert" onClick={() => orgActions.setError(null)}>
          {orgActions.error}
        </div>
      )}
    </div>
  );
}
