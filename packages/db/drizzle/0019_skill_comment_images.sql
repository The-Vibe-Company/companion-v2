CREATE TABLE IF NOT EXISTS "skill_comment_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_comment_images" ADD CONSTRAINT "skill_comment_images_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_comment_images" ADD CONSTRAINT "skill_comment_images_comment_id_skill_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."skill_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_comment_images" ADD CONSTRAINT "skill_comment_images_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_comment_images_comment_idx" ON "skill_comment_images" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_comment_images_org_idx" ON "skill_comment_images" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "skill_comment_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "skill_comment_images_tenant_rls" ON "skill_comment_images"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
