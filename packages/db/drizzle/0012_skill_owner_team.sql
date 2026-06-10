ALTER TABLE "skills" ADD COLUMN "owner_team_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_team_id_teams_id_fk" FOREIGN KEY ("owner_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_team_org_fk" FOREIGN KEY ("org_id","owner_team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skills_owner_team_idx" ON "skills" USING btree ("org_id","owner_team_id");
