ALTER TABLE "invitations" DROP CONSTRAINT IF EXISTS "invitations_org_email_status_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_pending_email_uq" ON "invitations" ("org_id","email") WHERE "status" = 'pending';--> statement-breakpoint
