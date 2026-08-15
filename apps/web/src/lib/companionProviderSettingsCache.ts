import type { CompanionProvidersResponse } from "@companion/contracts";

/** Keep the browser cache aligned with the API process's live pi.dev catalog cache. */
export const COMPANION_PROVIDER_SETTINGS_CACHE_TTL_MS = 5 * 60_000;

export interface CompanionProviderSettingsCacheSnapshot {
  providers: CompanionProvidersResponse;
  fresh: boolean;
  storedAt: number;
}

interface CacheEntry {
  providers: CompanionProvidersResponse;
  storedAt: number;
}

/**
 * Per-browser-process provider metadata. The key includes the reader because `can_manage` is
 * user-specific, and it includes the organization because connections and defaults are tenant data.
 * Provider credentials never enter this response or this cache.
 */
export class CompanionProviderSettingsCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly refreshes = new Map<string, Promise<CompanionProvidersResponse>>();
  private readonly revisions = new Map<string, number>();

  private key(userId: string, orgId: string): string {
    return JSON.stringify([userId, orgId]);
  }

  read(
    userId: string,
    orgId: string,
    now = Date.now(),
  ): CompanionProviderSettingsCacheSnapshot | null {
    const entry = this.entries.get(this.key(userId, orgId));
    if (!entry) return null;
    return {
      providers: entry.providers,
      fresh: now - entry.storedAt < COMPANION_PROVIDER_SETTINGS_CACHE_TTL_MS,
      storedAt: entry.storedAt,
    };
  }

  set(
    userId: string,
    orgId: string,
    providers: CompanionProvidersResponse,
    storedAt = Date.now(),
  ): void {
    const key = this.key(userId, orgId);
    this.entries.set(key, { providers, storedAt });
  }

  /** Update mutation-owned fields without extending the catalog's freshness window. */
  updateAfterMutation(
    userId: string,
    orgId: string,
    providers: CompanionProvidersResponse,
    storedAt = Date.now(),
  ): CompanionProvidersResponse {
    const key = this.key(userId, orgId);
    const current = this.entries.get(key);
    const merged = current
      ? {
          ...current.providers,
          connections: providers.connections,
          default_provider_id: providers.default_provider_id,
        }
      : providers;
    this.entries.set(key, {
      providers: merged,
      storedAt: current?.storedAt ?? storedAt,
    });
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    return merged;
  }

  /** Share one refresh per reader/workspace and fence it against a newer local mutation. */
  refresh(
    userId: string,
    orgId: string,
    load: () => Promise<CompanionProvidersResponse>,
    now: () => number = Date.now,
  ): Promise<CompanionProvidersResponse> {
    const key = this.key(userId, orgId);
    const active = this.refreshes.get(key);
    if (active) return active;

    const revision = this.revisions.get(key) ?? 0;
    const refresh = load()
      .then((providers) => {
        // A provider mutation completed while this older read was in flight. Keep its exact
        // connection/default state, but still accept the refreshed catalog and freshness stamp.
        if ((this.revisions.get(key) ?? 0) !== revision) {
          const current = this.entries.get(key);
          if (!current) return providers;
          const merged = {
            ...providers,
            connections: current.providers.connections,
            default_provider_id: current.providers.default_provider_id,
          };
          this.entries.set(key, { providers: merged, storedAt: now() });
          return merged;
        }
        this.set(userId, orgId, providers, now());
        return providers;
      })
      .finally(() => {
        if (this.refreshes.get(key) === refresh) this.refreshes.delete(key);
      });
    this.refreshes.set(key, refresh);
    return refresh;
  }

  clear(): void {
    this.entries.clear();
    this.refreshes.clear();
    this.revisions.clear();
  }
}

export const companionProviderSettingsCache = new CompanionProviderSettingsCache();
