ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_stars" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "organizations_tenant_rls" ON "organizations"
  USING ("id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY "memberships_tenant_rls" ON "memberships"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY "teams_tenant_rls" ON "teams"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY "team_memberships_tenant_rls" ON "team_memberships"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY "invitations_tenant_rls" ON "invitations"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY "skills_tenant_rls" ON "skills"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY "skill_versions_tenant_rls" ON "skill_versions"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY "skill_stars_tenant_rls" ON "skill_stars"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY "skill_comments_tenant_rls" ON "skill_comments"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY "audit_log_tenant_rls" ON "audit_log"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
