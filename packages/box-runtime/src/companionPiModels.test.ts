import { describe, expect, it } from "vitest";

import { companionPiModelsJson, COMPANION_PI_MODELS_PATH } from "./companionPiModels";

describe("Companion Pi custom models", () => {
  it("stages GLM 5.3 Flash with the z.ai Coding Plan transport and documented limits", () => {
    expect(COMPANION_PI_MODELS_PATH).toBe(".companion/pi/models.json");
    expect(JSON.parse(companionPiModelsJson("zai", "glm-5.3-flash"))).toEqual({
      providers: {
        zai: {
          baseUrl: "https://api.z.ai/api/coding/paas/v4",
          api: "openai-completions",
          models: [{
            id: "glm-5.3-flash",
            name: "GLM-5.3-Flash",
            api: "openai-completions",
            baseUrl: "https://api.z.ai/api/coding/paas/v4",
            reasoning: true,
            thinkingLevelMap: {
              off: null,
              minimal: null,
              low: "low",
              medium: null,
              high: "high",
              xhigh: null,
              max: "max",
            },
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_000_000,
            maxTokens: 131_072,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: true,
              maxTokensField: "max_tokens",
              thinkingFormat: "zai",
              zaiToolStream: true,
            },
          }],
        },
      },
    });
  });

  it("clears the supplement for another provider or model", () => {
    expect(JSON.parse(companionPiModelsJson("zai", "glm-5.3"))).toEqual({ providers: {} });
    expect(JSON.parse(companionPiModelsJson("openai", "glm-5.3-flash"))).toEqual({ providers: {} });
  });
});
