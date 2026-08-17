import { z } from "zod";
import {
  COMPANION_PROVIDER_CATALOG,
  companionModelIdSchema,
  companionModelInputSchema,
  type CompanionProviderDefinition,
} from "@companion/contracts";

const PI_MODELS_BASE_URL = "https://pi.dev/api/models/providers";
const PI_MODELS_CACHE_TTL_MS = 5 * 60_000;
export const PI_MODELS_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Companion intentionally supports only this fixed provider set. The values are Pi's provider
 * slugs; keeping the mapping explicit prevents pi.dev from expanding the connection surface.
 */
export const COMPANION_PI_PROVIDER_IDS = {
  anthropic: "anthropic",
  "openai-codex": "openai-codex",
  "kimi-coding": "kimi-coding",
  moonshotai: "moonshotai",
  zai: "zai",
  openai: "openai",
  google: "google",
} as const satisfies Record<(typeof COMPANION_PROVIDER_CATALOG)[number]["id"], string>;

const piModelSchema = z.object({
  id: companionModelIdSchema,
  name: z.string().trim().min(1).max(200),
  input: z.array(companionModelInputSchema).max(2).optional(),
}).passthrough();

type CatalogModels = CompanionProviderDefinition["models"];

interface CacheEntry {
  models: CatalogModels;
  storedAt: number;
}

/** Process-local last-known cache. Stale entries remain available when pi.dev cannot be reached. */
export class CompanionProviderCatalogCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly refreshes = new Map<string, Promise<CatalogModels>>();

  get(providerId: string): CacheEntry | undefined {
    return this.entries.get(providerId);
  }

  set(providerId: string, models: CatalogModels, storedAt: number): void {
    this.entries.set(providerId, { models, storedAt });
  }

  refresh(providerId: string, load: () => Promise<CatalogModels>): Promise<CatalogModels> {
    const active = this.refreshes.get(providerId);
    if (active) return active;
    const refresh = load().finally(() => {
      if (this.refreshes.get(providerId) === refresh) this.refreshes.delete(providerId);
    });
    this.refreshes.set(providerId, refresh);
    return refresh;
  }

  clear(): void {
    this.entries.clear();
    this.refreshes.clear();
  }
}

const defaultCache = new CompanionProviderCatalogCache();

interface CompanionProviderCatalogOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  cache?: CompanionProviderCatalogCache;
  now?: () => number;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
}

function bundledModels(providerId: string): CatalogModels {
  const provider = COMPANION_PROVIDER_CATALOG.find((candidate) => candidate.id === providerId);
  return provider?.models.map((model) => ({ ...model })) ?? [];
}

function normalizePiModels(providerId: string, value: unknown): CatalogModels {
  const parsed = z.record(piModelSchema).parse(value);
  const models = Object.entries(parsed).map(([key, model]) => {
    if (key !== model.id) {
      throw new Error(`pi.dev model key ${key} does not match id ${model.id}`);
    }
    return {
      id: model.id,
      name: model.name,
      ...(model.input === undefined ? {} : { input: [...model.input] }),
    };
  });
  if (models.length === 0) throw new Error(`pi.dev returned no models for ${providerId}`);

  const bundledDefault = bundledModels(providerId).find((model) => model.default)?.id;
  const defaultId = bundledDefault && models.some((model) => model.id === bundledDefault)
    ? bundledDefault
    : models[0]!.id;
  return models.map((model) => model.id === defaultId ? { ...model, default: true } : model);
}

async function fetchProviderModels(
  providerId: keyof typeof COMPANION_PI_PROVIDER_IDS,
  options: Required<
    Pick<CompanionProviderCatalogOptions, "baseUrl" | "fetchImpl" | "requestTimeoutMs">
  >,
): Promise<CatalogModels> {
  const piProviderId = COMPANION_PI_PROVIDER_IDS[providerId];
  const response = await options.fetchImpl(
    `${options.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(piProviderId)}`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    },
  );
  if (!response.ok) throw new Error(`pi.dev responded ${response.status} for ${piProviderId}`);
  return normalizePiModels(providerId, await response.json());
}

/**
 * Resolves every supported provider concurrently. Fresh pi.dev data wins; a failed refresh serves
 * the last-known value, or the bundled pin on a cold start, so every provider always has models.
 */
export async function getCompanionProviderCatalog(
  options: CompanionProviderCatalogOptions = {},
): Promise<CompanionProviderDefinition[]> {
  const cache = options.cache ?? defaultCache;
  const now = options.now ?? Date.now;
  const currentTime = now();
  const cacheTtlMs = options.cacheTtlMs ?? PI_MODELS_CACHE_TTL_MS;
  const fetchOptions = {
    baseUrl: options.baseUrl ?? PI_MODELS_BASE_URL,
    fetchImpl: options.fetchImpl ?? fetch,
    requestTimeoutMs: options.requestTimeoutMs ?? PI_MODELS_REQUEST_TIMEOUT_MS,
  };

  return Promise.all(COMPANION_PROVIDER_CATALOG.map(async (provider) => {
    const cached = cache.get(provider.id);
    let models = cached?.models;
    if (!cached || currentTime - cached.storedAt >= cacheTtlMs) {
      try {
        models = await cache.refresh(
          provider.id,
          () => fetchProviderModels(provider.id, fetchOptions),
        );
        cache.set(provider.id, models, currentTime);
      } catch {
        models = cached?.models?.length ? cached.models : bundledModels(provider.id);
        // Back off after a failed refresh so every picker/create request does not pay 15 seconds
        // while pi.dev is unavailable. The same TTL schedules the next live retry.
        cache.set(provider.id, models, currentTime);
      }
    }
    return {
      id: provider.id,
      name: provider.name,
      auth_methods: [...provider.auth_methods],
      description: provider.description,
      models: models?.length ? models.map((model) => ({ ...model })) : bundledModels(provider.id),
    };
  }));
}

export function companionCatalogModel(
  catalog: CompanionProviderDefinition[],
  providerId: string,
  requestedModelId?: string,
): string | undefined {
  const provider = catalog.find((candidate) => candidate.id === providerId);
  if (!provider) return undefined;
  if (requestedModelId) {
    return provider.models.some((model) => model.id === requestedModelId)
      ? requestedModelId
      : undefined;
  }
  return provider.models.find((model) => model.default)?.id ?? provider.models[0]?.id;
}
