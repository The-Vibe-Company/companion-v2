ALTER TABLE "skill_runs" ADD COLUMN "sandbox_cleaned_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "skill_runs_sweep_idx" ON "skill_runs" ("updated_at") WHERE "sandbox_cleaned_at" IS NULL;
