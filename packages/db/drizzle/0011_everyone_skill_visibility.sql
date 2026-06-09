ALTER TABLE "skills" ADD COLUMN "everyone" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "skills" SET "everyone" = true WHERE "scope" = 'public';--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_id_uq" UNIQUE("org_id","id");--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_org_id_id_uq" UNIQUE("org_id","id");--> statement-breakpoint
CREATE TABLE "skill_team_shares" (
	"org_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_team_shares_skill_id_team_id_pk" PRIMARY KEY("skill_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "skill_team_shares" ADD CONSTRAINT "skill_team_shares_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_team_shares" ADD CONSTRAINT "skill_team_shares_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_team_shares" ADD CONSTRAINT "skill_team_shares_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_team_shares" ADD CONSTRAINT "skill_team_shares_skill_org_fk" FOREIGN KEY ("org_id","skill_id") REFERENCES "public"."skills"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_team_shares" ADD CONSTRAINT "skill_team_shares_team_org_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "skill_team_shares" ("org_id", "skill_id", "team_id")
SELECT s."org_id", s."id", s."team_id"
FROM "skills" s
INNER JOIN "teams" t ON t."id" = s."team_id" AND t."org_id" = s."org_id"
WHERE s."scope" = 'team' AND s."team_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "skill_filter_preferences"
SET "active_filters" = COALESCE((
  SELECT jsonb_agg(
    CASE
      WHEN filter->>'type' = 'scope' THEN jsonb_build_object(
        'type', 'visibility',
        'value', CASE filter->>'value' WHEN 'public' THEN 'everyone' ELSE filter->>'value' END
      )
      ELSE filter
    END
  )
  FROM jsonb_array_elements("active_filters") AS filter
), '[]'::jsonb);--> statement-breakpoint
UPDATE "skill_filter_preferences"
SET "custom_views" = COALESCE((
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(view->'filters') = 'array' THEN jsonb_set(
        view,
        '{filters}',
        COALESCE((
          SELECT jsonb_agg(
            CASE
              WHEN filter->>'type' = 'scope' THEN jsonb_build_object(
                'type', 'visibility',
                'value', CASE filter->>'value' WHEN 'public' THEN 'everyone' ELSE filter->>'value' END
              )
              ELSE filter
            END
          )
          FROM jsonb_array_elements(view->'filters') AS filter
        ), '[]'::jsonb),
        true
      )
      ELSE view
    END
  )
  FROM jsonb_array_elements("custom_views") AS view
), '[]'::jsonb);--> statement-breakpoint
CREATE INDEX "skills_everyone_idx" ON "skills" USING btree ("org_id","everyone");--> statement-breakpoint
CREATE INDEX "skill_team_shares_org_skill_idx" ON "skill_team_shares" USING btree ("org_id","skill_id");--> statement-breakpoint
CREATE INDEX "skill_team_shares_org_team_idx" ON "skill_team_shares" USING btree ("org_id","team_id");--> statement-breakpoint
ALTER TABLE "skill_team_shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "skill_team_shares_tenant_rls" ON "skill_team_shares"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP INDEX IF EXISTS "skills_visibility_idx";--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT IF EXISTS "skills_team_scope_check";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN IF EXISTS "team_id";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN IF EXISTS "scope";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."scope";
