/** Pi reads this file from the agent directory selected by PI_CODING_AGENT_DIR. */
export const COMPANION_PI_MODELS_PATH = ".companion/pi/models.json";

const GLM_5_3_FLASH = {
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
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 1_000_000,
  maxTokens: 131_072,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    maxTokensField: "max_tokens",
    thinkingFormat: "zai",
  },
} as const;

/**
 * Build the exact custom-model snapshot for one selected provider/model.
 *
 * Pi 0.84.2 does not know GLM 5.3 Flash. Its models.json layer upserts custom models over the
 * built-in provider catalog, so the supplement is present only for that selected gap. Writing an
 * empty provider map for every other selection clears a supplement left by an earlier setting and
 * ensures a future pinned Pi entry becomes authoritative when this stopgap is removed.
 */
export function companionPiModelsJson(providerId: string | undefined, modelId: string): string {
  const providers = providerId === "zai" && modelId === GLM_5_3_FLASH.id
    ? {
        zai: {
          baseUrl: GLM_5_3_FLASH.baseUrl,
          api: GLM_5_3_FLASH.api,
          models: [GLM_5_3_FLASH],
        },
      }
    : {};
  return `${JSON.stringify({ providers }, null, 2)}\n`;
}
