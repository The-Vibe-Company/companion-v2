ALTER TABLE "companions" ADD COLUMN "model_id" text;

-- Existing rows keep the same provider-specific model Pi selected implicitly before THE-356.
UPDATE "companions"
SET "model_id" = CASE "provider_ids"->>0
  WHEN 'anthropic' THEN 'claude-opus-4-8'
  WHEN 'openai-codex' THEN 'gpt-5.5'
  WHEN 'kimi-coding' THEN 'kimi-for-coding'
  WHEN 'moonshotai' THEN 'kimi-k2.6'
  WHEN 'zai' THEN 'glm-4.7'
  WHEN 'openai' THEN 'gpt-5.5'
  WHEN 'google' THEN 'gemini-3.1-pro-preview'
  ELSE NULL
END
WHERE "model_id" IS NULL;
