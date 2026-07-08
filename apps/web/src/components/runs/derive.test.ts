import { describe, expect, it } from "vitest";
import type { ModelRow } from "@companion/contracts";
import {
  effectiveActivatedSet,
  filterGroupsToActivated,
  firstConnectedModel,
  groupModelsByProvider,
  type ModelProviderVM,
} from "./derive";

function model(id: string): ModelRow {
  const [provider = "", key = ""] = id.split("/", 2);
  return {
    id,
    provider,
    provider_name: provider,
    name: key,
    description: null,
    context: null,
    cost_input: null,
    cost_output: null,
    env_keys: [`${provider.toUpperCase()}_API_KEY`],
  };
}

const MODELS = [model("anthropic/sonnet"), model("anthropic/opus"), model("openai/gpt")];
const PROVIDERS: ModelProviderVM[] = [
  { id: "anthropic", name: "Anthropic", envKeys: ["ANTHROPIC_API_KEY"], connected: true },
  { id: "openai", name: "OpenAI", envKeys: ["OPENAI_API_KEY"], connected: false },
];

describe("effectiveActivatedSet", () => {
  it("unions and dedupes the personal and org lists", () => {
    const set = effectiveActivatedSet({
      personal: ["anthropic/sonnet", "openai/gpt"],
      org: ["openai/gpt", "anthropic/opus"],
    });
    expect([...set].sort()).toEqual(["anthropic/opus", "anthropic/sonnet", "openai/gpt"]);
  });
});

describe("filterGroupsToActivated", () => {
  const groups = groupModelsByProvider(MODELS, PROVIDERS);

  it("keeps only activated models and drops groups left empty", () => {
    const filtered = filterGroupsToActivated(groups, new Set(["anthropic/sonnet"]));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.provider.id).toBe("anthropic");
    expect(filtered[0]!.models.map((m) => m.id)).toEqual(["anthropic/sonnet"]);
  });

  it("keeps a disconnected provider's group when one of its models is activated (inline Connect stays reachable)", () => {
    const filtered = filterGroupsToActivated(groups, new Set(["openai/gpt"]));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.provider.id).toBe("openai");
    expect(filtered[0]!.provider.connected).toBe(false);
  });

  it("returns nothing for an empty activated set (the picker's empty state)", () => {
    expect(filterGroupsToActivated(groups, new Set())).toEqual([]);
  });

  it("feeds firstConnectedModel only activated models (default selection respects the filter)", () => {
    const filtered = filterGroupsToActivated(groups, new Set(["anthropic/opus", "openai/gpt"]));
    expect(firstConnectedModel(filtered)).toBe("anthropic/opus");
    const noneConnected = filterGroupsToActivated(groups, new Set(["openai/gpt"]));
    expect(firstConnectedModel(noneConnected)).toBeNull();
  });
});
