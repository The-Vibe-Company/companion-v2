import type { ModelRow, ModelsResponse } from "@companion/contracts";

/**
 * The model picker catalog. OpenCode enumerates providers/models from the models.dev registry and
 * addresses a model as `provider/model-id`, with provider API keys supplied via env vars. We fetch
 * the same registry and expose EVERY tool-capable model (agents run skills): the control plane
 * never injects its own provider keys — each user supplies the chosen model's key (the provider's
 * `env` var name) as a write-only agent secret. A small bundled fallback keeps the create form
 * usable when models.dev is unreachable.
 */

const REGISTRY_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface RegistryModel {
  id?: string;
  name?: string;
  description?: string;
  tool_call?: boolean;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
}

interface RegistryProvider {
  id?: string;
  name?: string;
  env?: string[];
  models?: Record<string, RegistryModel>;
}

type Registry = Record<string, RegistryProvider>;

/** Minimal registry used when models.dev is unreachable (keys per that registry's env conventions). */
const FALLBACK_REGISTRY: Registry = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", tool_call: true, limit: { context: 200_000 } },
      "claude-opus-4-5": { name: "Claude Opus 4.5", tool_call: true, limit: { context: 200_000 } },
      "claude-haiku-4-5": { name: "Claude Haiku 4.5", tool_call: true, limit: { context: 200_000 } },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    models: {
      "gpt-5.2": { name: "GPT-5.2", tool_call: true, limit: { context: 400_000 } },
    },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    env: ["OPENROUTER_API_KEY"],
    models: {
      "anthropic/claude-sonnet-4.5": { name: "Claude Sonnet 4.5 (OpenRouter)", tool_call: true },
    },
  },
};

let cached: { at: number; registry: Registry } | null = null;

async function loadRegistry(fetcher: typeof fetch): Promise<Registry> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.registry;
  try {
    const res = await fetcher(REGISTRY_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`models.dev responded ${res.status}`);
    const registry = (await res.json()) as Registry;
    cached = { at: Date.now(), registry };
    return registry;
  } catch {
    // Keep a previously cached copy alive past its TTL rather than downgrading to the fallback.
    if (cached) return cached.registry;
    return FALLBACK_REGISTRY;
  }
}

/** The stateless part of the models response — `connected`/`activated` are API-layer concerns. */
export type ModelCatalogListing = Pick<ModelsResponse, "models" | "providers">;

export interface ModelCatalog {
  listModels(): Promise<ModelCatalogListing>;
  /** Validate a `provider/model` ref; returns the provider's API-key env var name(s), or null. */
  resolveModel(modelRef: string): Promise<{ envKeys: string[] } | null>;
  /** Test seam. */
  clearCache(): void;
}

export function createModelCatalog(input: {
  fetcher?: typeof fetch;
} = {}): ModelCatalog {
  const fetcher = input.fetcher ?? fetch;

  async function allProviders(): Promise<Array<[string, RegistryProvider]>> {
    const registry = await loadRegistry(fetcher);
    // A provider with no key env var cannot be user-configured — skip it.
    return Object.entries(registry).filter(([, provider]) => (provider.env ?? []).length > 0);
  }

  return {
    async listModels() {
      const providers = await allProviders();
      const models: ModelRow[] = [];
      for (const [providerId, provider] of providers) {
        for (const [modelKey, model] of Object.entries(provider.models ?? {})) {
          if (model.tool_call !== true) continue;
          models.push({
            id: `${providerId}/${modelKey}`,
            provider: providerId,
            provider_name: provider.name ?? providerId,
            name: model.name ?? modelKey,
            description: model.description ?? null,
            context: model.limit?.context ?? null,
            cost_input: model.cost?.input ?? null,
            cost_output: model.cost?.output ?? null,
            env_keys: provider.env ?? [],
          });
        }
      }
      models.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
      return {
        models,
        // `connected` is per-user and filled in by the API layer; the catalog is stateless.
        providers: providers.map(([id, provider]) => ({
          id,
          name: provider.name ?? id,
          env_keys: provider.env ?? [],
          connected: false,
        })),
      };
    },

    async resolveModel(modelRef: string) {
      const slash = modelRef.indexOf("/");
      if (slash <= 0) return null;
      const providerId = modelRef.slice(0, slash);
      const modelKey = modelRef.slice(slash + 1);
      const providers = await allProviders();
      const entry = providers.find(([id]) => id === providerId);
      if (!entry) return null;
      const provider = entry[1];
      const model = provider.models?.[modelKey];
      if (!model || model.tool_call !== true) return null;
      return { envKeys: provider.env ?? [] };
    },

    clearCache() {
      cached = null;
    },
  };
}
