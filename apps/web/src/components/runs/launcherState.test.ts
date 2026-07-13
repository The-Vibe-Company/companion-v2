import { describe, expect, it } from "vitest";
import type { RunOptions } from "@companion/contracts";
import {
  authoritativeInputs,
  configurationIsModified,
  groupRunInputs,
  prefilledInputs,
  runDraftBlockers,
  withRunDraft,
} from "./launcherState";

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const SLOT_ID = "33333333-3333-4333-8333-333333333333";
const SECRET_ID = "44444444-4444-4444-8444-444444444444";
const PROVIDER_SECRET_ID = "55555555-5555-4555-8555-555555555555";

function options(): RunOptions {
  return {
    root: { skill_id: ROOT_ID, skill_version_id: VERSION_ID, slug: "root", version: "1.0.0", root: true, depth: 0, via: null },
    dependencies: [],
    declared_secrets: [{
      skill_id: ROOT_ID,
      skill_version_id: VERSION_ID,
      skill_slug: "root",
      slot_id: SLOT_ID,
      env_key: "SERVICE_TOKEN",
      description: "",
      required: true,
      candidates: [{
        id: SECRET_ID,
        name: "Production",
        key: "SERVICE_TOKEN",
        owner: { id: ROOT_ID, name: "Ada", initials: "AD", avatar_url: null },
        audience: "personal",
        personal: true,
      }],
      prefill_secret_id: SECRET_ID,
    }],
    declared_variables: [{
      skill_id: ROOT_ID,
      skill_version_id: VERSION_ID,
      skill_slug: "root",
      env_key: "OUTPUT_FORMAT",
      description: "",
      required: false,
    }],
    configurations: [],
    models: [{
      model: {
        id: "openai/gpt-5",
        provider: "openai",
        provider_name: "OpenAI",
        name: "GPT-5",
        description: null,
        context: null,
        cost_input: null,
        cost_output: null,
        env_keys: ["OPENAI_API_KEY"],
      },
      readiness: "ready",
      message: null,
      provider_secret_pin: {
        env_key: "OPENAI_API_KEY",
        secret_id: PROVIDER_SECRET_ID,
        secret_version: 2,
        secret_name: "OpenAI personal",
        secret_audience: "personal",
        secret_owner_name: "Ada Lovelace",
      },
    }],
    runtime: { available: true, message: null },
  };
}

describe("run launcher state", () => {
  it("uses install bindings only as a Custom draft prefill", () => {
    expect(prefilledInputs(options()).secrets).toEqual([{ skill_id: ROOT_ID, slot_id: SLOT_ID, secret_id: SECRET_ID }]);
  });

  it("keeps the root first and drops inputs removed from the exact version", () => {
    expect(groupRunInputs(options())[0]?.skill.root).toBe(true);
    expect(authoritativeInputs(options(), {
      secrets: [{ skill_id: ROOT_ID, slot_id: SLOT_ID, secret_id: SECRET_ID }],
      variables: [
        { skill_id: ROOT_ID, env_key: "OUTPUT_FORMAT", value: "json" },
        { skill_id: ROOT_ID, env_key: "REMOVED", value: "stale" },
      ],
    }).variables).toEqual([{ skill_id: ROOT_ID, env_key: "OUTPUT_FORMAT", value: "json" }]);
  });

  it("blocks a required unavailable secret and reports configuration modifications deterministically", () => {
    const base = options();
    expect(runDraftBlockers(base, "openai/gpt-5", { secrets: [], variables: [] })).toEqual([
      "root: SERVICE_TOKEN requires a secret.",
    ]);
    expect(configurationIsModified({
      id: ROOT_ID,
      skill_id: ROOT_ID,
      skill_slug: "root",
      name: "Daily",
      model: "openai/gpt-5",
      revision: 1,
      is_default: false,
      status: "ready",
      issues: [],
      inputs: { secrets: [{ skill_id: ROOT_ID, slot_id: SLOT_ID, secret_id: SECRET_ID }], variables: [] },
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
      last_used_at: null,
    }, "openai/gpt-5", { variables: [], secrets: [{ secret_id: SECRET_ID, slot_id: SLOT_ID, skill_id: ROOT_ID }] })).toBe(false);
  });

  it("blocks a model-provider env collision unless the same vault secret is selected", () => {
    const base = options();
    base.declared_secrets[0] = {
      ...base.declared_secrets[0]!,
      env_key: "OPENAI_API_KEY",
      candidates: [
        ...base.declared_secrets[0]!.candidates,
        { ...base.declared_secrets[0]!.candidates[0]!, id: PROVIDER_SECRET_ID, key: "OPENAI_API_KEY" },
      ],
    };
    expect(runDraftBlockers(base, "openai/gpt-5", {
      secrets: [{ skill_id: ROOT_ID, slot_id: SLOT_ID, secret_id: SECRET_ID }],
      variables: [],
    })).toContain("OPENAI_API_KEY has conflicting values across the dependency closure.");
    expect(runDraftBlockers(base, "openai/gpt-5", {
      secrets: [{ skill_id: ROOT_ID, slot_id: SLOT_ID, secret_id: PROVIDER_SECRET_ID }],
      variables: [],
    })).toEqual([]);
  });

  it("blocks launch when ready model options no longer carry the explicit provider reference", () => {
    const base = options();
    base.declared_secrets = [];
    base.models[0] = { ...base.models[0]!, provider_secret_pin: null };

    expect(runDraftBlockers(base, "openai/gpt-5", { secrets: [], variables: [] })).toEqual([
      "Reload run options to select the model provider secret explicitly.",
    ]);
  });

  it("keeps complete drafts isolated by skill slug", () => {
    const first = { prompt: "first", files: [], model: "openai/gpt-5", inputs: { secrets: [], variables: [] }, configurationId: null };
    const second = { ...first, prompt: "second" };
    const drafts = withRunDraft(withRunDraft(new Map(), "alpha", first), "beta", second);
    expect(drafts.get("alpha")?.prompt).toBe("first");
    expect(drafts.get("beta")?.prompt).toBe("second");
    expect(withRunDraft(drafts, "alpha", null).has("alpha")).toBe(false);
  });
});
