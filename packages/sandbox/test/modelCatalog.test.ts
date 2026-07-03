import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelCatalog } from "../src/modelCatalog";

const REGISTRY = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-x": { name: "Claude X", tool_call: true, limit: { context: 200000 }, cost: { input: 3, output: 15 } },
      "claude-embed": { name: "Claude Embed", tool_call: false },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    models: { "gpt-x": { name: "GPT X", tool_call: true } },
  },
  requesty: {
    id: "requesty",
    name: "Requesty",
    env: ["REQUESTY_API_KEY"],
    models: { "xai/grok-4": { name: "Grok 4", tool_call: true } },
  },
};

function fetcherReturning(payload: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
}

describe("createModelCatalog", () => {
  let catalog: ReturnType<typeof createModelCatalog>;

  beforeEach(() => {
    catalog = createModelCatalog({ fetcher: fetcherReturning(REGISTRY) });
    catalog.clearCache();
  });

  it("lists every tool-capable model with its provider env key names (no control-plane filter)", async () => {
    const res = await catalog.listModels();
    expect(res.providers.map((p) => p.id).sort()).toEqual(["anthropic", "openai", "requesty"]);
    expect(res.models.map((m) => m.id)).toEqual(["anthropic/claude-x", "openai/gpt-x", "requesty/xai/grok-4"]);
    const claude = res.models[0];
    expect(claude).toMatchObject({
      provider_name: "Anthropic",
      context: 200000,
      cost_input: 3,
      env_keys: ["ANTHROPIC_API_KEY"],
    });
  });

  it("resolveModel validates the ref and returns the provider's key env var names", async () => {
    expect(await catalog.resolveModel("anthropic/claude-x")).toEqual({ envKeys: ["ANTHROPIC_API_KEY"] });
    // Nested model keys (provider ids with slashes in the model part) resolve on the FIRST slash.
    expect(await catalog.resolveModel("requesty/xai/grok-4")).toEqual({ envKeys: ["REQUESTY_API_KEY"] });
    expect(await catalog.resolveModel("openai/gpt-x")).toEqual({ envKeys: ["OPENAI_API_KEY"] });
    expect(await catalog.resolveModel("anthropic/claude-embed")).toBeNull(); // not tool-capable
    expect(await catalog.resolveModel("anthropic/nope")).toBeNull();
    expect(await catalog.resolveModel("garbage")).toBeNull();
  });

  it("falls back to the bundled registry when models.dev is unreachable", async () => {
    const failing = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const offline = createModelCatalog({ fetcher: failing });
    offline.clearCache();
    const res = await offline.listModels();
    expect(res.providers.map((p) => p.id)).toContain("anthropic");
    expect(res.models.some((m) => m.id.startsWith("anthropic/claude"))).toBe(true);
  });

  it("caches the registry between calls", async () => {
    const fetcher = fetcherReturning(REGISTRY);
    const cachedCatalog = createModelCatalog({ fetcher });
    cachedCatalog.clearCache();
    await cachedCatalog.listModels();
    await cachedCatalog.listModels();
    await cachedCatalog.resolveModel("anthropic/claude-x");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
