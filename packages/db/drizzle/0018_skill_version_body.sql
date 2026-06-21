ALTER TABLE "skill_versions" ADD COLUMN "body" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_versions_body_tsv_idx" ON "skill_versions" USING gin (to_tsvector('simple', "body"));
