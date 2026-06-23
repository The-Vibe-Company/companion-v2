-- Drop the Team concept product-wide: the hierarchy is now Organization -> User. Skill ownership /
-- visibility (which were the only consumers of teams) were removed in 0022, so the team tables and
-- the `team_role` enum are now unreferenced.

DROP POLICY IF EXISTS "team_memberships_tenant_rls" ON "team_memberships";--> statement-breakpoint
DROP POLICY IF EXISTS "teams_tenant_rls" ON "teams";--> statement-breakpoint
DROP TABLE IF EXISTS "team_memberships";--> statement-breakpoint
DROP TABLE IF EXISTS "teams";--> statement-breakpoint
DROP TYPE IF EXISTS "team_role";
