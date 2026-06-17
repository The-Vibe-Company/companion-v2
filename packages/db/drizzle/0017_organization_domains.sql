DROP INDEX IF EXISTS "organizations_domain_uq";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_domains" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "domain" text NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_domains" ADD CONSTRAINT "organization_domains_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_domains" ADD CONSTRAINT "organization_domains_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_domains_org_domain_uq" ON "organization_domains" ("org_id", lower("domain"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_domains_domain_idx" ON "organization_domains" (lower("domain"));--> statement-breakpoint
ALTER TABLE "organization_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organization_domains_tenant_rls" ON "organization_domains"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
INSERT INTO "organization_domains" ("org_id", "domain", "created_by")
SELECT
  o."id",
  lower(trim(o."domain")),
  (
    SELECT m."user_id"
    FROM "memberships" m
    WHERE m."org_id" = o."id" AND m."org_role" = 'owner'
    ORDER BY m."created_at" ASC
    LIMIT 1
  )
FROM "organizations" o
WHERE o."domain" IS NOT NULL AND trim(o."domain") <> '' AND o."domain_auto_join" = true
ON CONFLICT DO NOTHING;
