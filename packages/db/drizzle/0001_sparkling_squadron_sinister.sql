ALTER TABLE "skill_comments" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_stars" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD COLUMN "org_id" uuid;--> statement-breakpoint
UPDATE "skill_comments" SET "org_id" = "skills"."org_id" FROM "skills" WHERE "skill_comments"."skill_id" = "skills"."id";--> statement-breakpoint
UPDATE "skill_stars" SET "org_id" = "skills"."org_id" FROM "skills" WHERE "skill_stars"."skill_id" = "skills"."id";--> statement-breakpoint
UPDATE "skill_versions" SET "org_id" = "skills"."org_id" FROM "skills" WHERE "skill_versions"."skill_id" = "skills"."id";--> statement-breakpoint
ALTER TABLE "skill_comments" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_stars" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_versions" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_comments" ADD CONSTRAINT "skill_comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_stars" ADD CONSTRAINT "skill_stars_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_stars_org_idx" ON "skill_stars" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "skill_versions_org_idx" ON "skill_versions" USING btree ("org_id");
