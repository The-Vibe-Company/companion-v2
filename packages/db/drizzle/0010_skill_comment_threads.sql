ALTER TABLE "skill_comments" ADD COLUMN IF NOT EXISTS "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_comments" ADD COLUMN IF NOT EXISTS "version_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_comments" ADD COLUMN IF NOT EXISTS "deprecated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_comments" ADD CONSTRAINT "skill_comments_parent_id_skill_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."skill_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_comments" ADD CONSTRAINT "skill_comments_version_id_skill_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_comments_skill_parent_idx" ON "skill_comments" USING btree ("skill_id","parent_id");
