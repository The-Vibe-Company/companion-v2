ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "domain" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "domain_auto_join" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "color" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "logo_url" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "color" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "icon" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "onboarded_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_domain_uq" ON "organizations" (lower("domain")) WHERE "domain" IS NOT NULL;--> statement-breakpoint
UPDATE "profiles" p SET "onboarded_at" = now()
  WHERE "onboarded_at" IS NULL
    AND EXISTS (SELECT 1 FROM "memberships" m WHERE m."user_id" = p."id");
