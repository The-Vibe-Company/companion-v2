ALTER TABLE "companions" ADD COLUMN "last_error" text;
--> statement-breakpoint
ALTER TABLE "companions"
  ADD CONSTRAINT "companions_last_error_check"
  CHECK ("last_error" IS NULL OR char_length("last_error") <= 500);
