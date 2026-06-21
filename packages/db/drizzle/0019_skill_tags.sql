CREATE TABLE "skill_tags" (
	"org_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_tags_skill_id_tag_pk" PRIMARY KEY("skill_id","tag")
);
--> statement-breakpoint
ALTER TABLE "skill_tags" ADD CONSTRAINT "skill_tags_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_tags" ADD CONSTRAINT "skill_tags_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_tags" ADD CONSTRAINT "skill_tags_skill_org_fk" FOREIGN KEY ("org_id","skill_id") REFERENCES "public"."skills"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_tags_org_tag_idx" ON "skill_tags" USING btree ("org_id","tag");--> statement-breakpoint
CREATE INDEX "skill_tags_org_skill_idx" ON "skill_tags" USING btree ("org_id","skill_id");--> statement-breakpoint
ALTER TABLE "skill_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "skill_tags_tenant_rls" ON "skill_tags"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
