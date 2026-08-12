ALTER TABLE "companions" ADD COLUMN "persona" text;
--> statement-breakpoint
ALTER TABLE "companions"
  ADD CONSTRAINT "companions_persona_check"
  CHECK ("persona" IS NULL OR char_length("persona") <= 280);
