import type { CompanionProvidersResponse } from "@companion/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  COMPANION_PROVIDER_SETTINGS_CACHE_TTL_MS,
  CompanionProviderSettingsCache,
} from "./companionProviderSettingsCache";

function providers(defaultProviderId = "anthropic"): CompanionProvidersResponse {
  return {
    catalog: [{
      id: "anthropic",
      name: "Claude",
      auth_methods: ["api_key"],
      description: "",
      models: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8", default: true }],
    }],
    connections: [{
      provider_id: "anthropic",
      auth_method: "api_key",
      connected_by: "user-1",
      created_at: "2026-08-12T12:00:00.000Z",
      updated_at: "2026-08-12T12:00:00.000Z",
    }],
    default_provider_id: defaultProviderId,
    can_manage: true,
  };
}

describe("CompanionProviderSettingsCache", () => {
  it("keeps an entry fresh for five minutes and then serves it as stale", () => {
    const cache = new CompanionProviderSettingsCache();
    cache.set("user-1", "org-1", providers(), 1_000);

    expect(cache.read(
      "user-1",
      "org-1",
      1_000 + COMPANION_PROVIDER_SETTINGS_CACHE_TTL_MS - 1,
    )).toMatchObject({ fresh: true, providers: providers() });
    expect(cache.read(
      "user-1",
      "org-1",
      1_000 + COMPANION_PROVIDER_SETTINGS_CACHE_TTL_MS,
    )).toMatchObject({ fresh: false, providers: providers() });
  });

  it("isolates provider settings by both reader and organization", () => {
    const cache = new CompanionProviderSettingsCache();
    cache.set("user-1", "org-1", providers(), 1_000);

    expect(cache.read("user-2", "org-1", 1_001)).toBeNull();
    expect(cache.read("user-1", "org-2", 1_001)).toBeNull();
    expect(cache.read("user-1", "org-1", 1_001)?.providers).toEqual(providers());
  });

  it("deduplicates concurrent refreshes for the same reader and organization", async () => {
    const cache = new CompanionProviderSettingsCache();
    let resolve!: (value: CompanionProvidersResponse) => void;
    const load = vi.fn(() => new Promise<CompanionProvidersResponse>((done) => {
      resolve = done;
    }));

    const first = cache.refresh("user-1", "org-1", load, () => 2_000);
    const second = cache.refresh("user-1", "org-1", load, () => 2_000);
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);

    resolve(providers());
    await expect(first).resolves.toEqual(providers());
    expect(cache.read("user-1", "org-1", 2_000)?.fresh).toBe(true);
  });

  it("merges a refreshed catalog without overwriting a concurrent provider mutation", async () => {
    const cache = new CompanionProviderSettingsCache();
    const before = providers("anthropic");
    const afterMutation = providers("openai");
    const afterRefresh = {
      ...before,
      catalog: before.catalog.map((provider) => ({ ...provider, name: "Claude refreshed" })),
    };
    let resolve!: (value: CompanionProvidersResponse) => void;
    cache.set("user-1", "org-1", before, 1_000);

    const refresh = cache.refresh(
      "user-1",
      "org-1",
      () => new Promise<CompanionProvidersResponse>((done) => {
        resolve = done;
      }),
      () => 3_000,
    );
    cache.updateAfterMutation("user-1", "org-1", afterMutation, 2_000);
    resolve(afterRefresh);

    await expect(refresh).resolves.toMatchObject({
      catalog: [expect.objectContaining({ name: "Claude refreshed" })],
      default_provider_id: "openai",
    });
    expect(cache.read("user-1", "org-1", 3_000)).toMatchObject({
      fresh: true,
      providers: {
        catalog: [expect.objectContaining({ name: "Claude refreshed" })],
        default_provider_id: "openai",
      },
    });
  });

  it("does not extend a stale catalog's freshness after a provider mutation", () => {
    const cache = new CompanionProviderSettingsCache();
    cache.set("user-1", "org-1", providers("anthropic"), 1_000);

    cache.updateAfterMutation("user-1", "org-1", providers("openai"), 10_000);

    expect(cache.read(
      "user-1",
      "org-1",
      1_000 + COMPANION_PROVIDER_SETTINGS_CACHE_TTL_MS,
    )).toMatchObject({
      fresh: false,
      storedAt: 1_000,
      providers: { default_provider_id: "openai" },
    });
  });

  it("preserves a refreshed catalog when an older mutation response finishes afterward", async () => {
    const cache = new CompanionProviderSettingsCache();
    const before = providers("anthropic");
    const refreshed = {
      ...before,
      catalog: before.catalog.map((provider) => ({ ...provider, name: "Claude refreshed" })),
    };
    cache.set("user-1", "org-1", before, 1_000);

    await cache.refresh("user-1", "org-1", async () => refreshed, () => 3_000);
    const merged = cache.updateAfterMutation(
      "user-1",
      "org-1",
      providers("openai"),
      4_000,
    );

    expect(merged).toMatchObject({
      catalog: [expect.objectContaining({ name: "Claude refreshed" })],
      default_provider_id: "openai",
    });
    expect(cache.read("user-1", "org-1", 3_000)).toMatchObject({
      fresh: true,
      storedAt: 3_000,
      providers: {
        catalog: [expect.objectContaining({ name: "Claude refreshed" })],
        default_provider_id: "openai",
      },
    });
  });

  it("keeps stale data available when a refresh fails and allows a later retry", async () => {
    const cache = new CompanionProviderSettingsCache();
    cache.set("user-1", "org-1", providers(), 1_000);
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("pi.dev unavailable"))
      .mockResolvedValueOnce(providers("openai"));

    await expect(cache.refresh("user-1", "org-1", load)).rejects.toThrow("pi.dev unavailable");
    expect(cache.read("user-1", "org-1", 1_000 + COMPANION_PROVIDER_SETTINGS_CACHE_TTL_MS))
      .toMatchObject({ fresh: false, providers: providers() });

    await expect(cache.refresh("user-1", "org-1", load, () => 9_000))
      .resolves.toEqual(providers("openai"));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
