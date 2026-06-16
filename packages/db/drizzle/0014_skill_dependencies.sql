ALTER TABLE "skills" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "archived_by" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "archive_reason" text;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_archived_by_user_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skills_archived_idx" ON "skills" USING btree ("org_id","archived_at");--> statement-breakpoint
CREATE TABLE "skill_version_dependencies" (
	"org_id" uuid NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"depends_on_slug" text NOT NULL,
	"depends_on_skill_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_version_dependencies_skill_version_id_depends_on_slug_pk" PRIMARY KEY("skill_version_id","depends_on_slug")
);
--> statement-breakpoint
ALTER TABLE "skill_version_dependencies" ADD CONSTRAINT "skill_version_dependencies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version_dependencies" ADD CONSTRAINT "skill_version_dependencies_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version_dependencies" ADD CONSTRAINT "skill_version_dependencies_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version_dependencies" ADD CONSTRAINT "skill_version_dependencies_depends_on_skill_id_skills_id_fk" FOREIGN KEY ("depends_on_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_version_deps_skill_idx" ON "skill_version_dependencies" USING btree ("org_id","skill_id");--> statement-breakpoint
CREATE INDEX "skill_version_deps_target_idx" ON "skill_version_dependencies" USING btree ("org_id","depends_on_skill_id");--> statement-breakpoint
ALTER TABLE "skill_version_dependencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "skill_version_dependencies_tenant_rls" ON "skill_version_dependencies"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
