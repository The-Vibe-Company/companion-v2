ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_org_id_id_uq" UNIQUE("org_id","id");--> statement-breakpoint
ALTER TABLE "skill_version_dependencies" DROP CONSTRAINT "skill_version_dependencies_skill_version_id_skill_versions_id_fk";--> statement-breakpoint
ALTER TABLE "skill_version_dependencies" DROP CONSTRAINT "skill_version_dependencies_skill_id_skills_id_fk";--> statement-breakpoint
ALTER TABLE "skill_version_dependencies" ADD CONSTRAINT "skill_version_deps_version_org_fk" FOREIGN KEY ("org_id","skill_version_id") REFERENCES "public"."skill_versions"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version_dependencies" ADD CONSTRAINT "skill_version_deps_skill_org_fk" FOREIGN KEY ("org_id","skill_id") REFERENCES "public"."skills"("org_id","id") ON DELETE cascade ON UPDATE no action;
