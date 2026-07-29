CREATE TABLE "getting_started_states" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"companion_installed_at" timestamp with time zone,
	"local_reviewed_at" timestamp with time zone,
	"org_reviewed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "getting_started_states_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "getting_started_states" ADD CONSTRAINT "getting_started_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "getting_started_states" ADD CONSTRAINT "getting_started_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "getting_started_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "getting_started_states_tenant_rls" ON "getting_started_states"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
INSERT INTO "getting_started_states" (
  "org_id",
  "user_id",
  "companion_installed_at",
  "dismissed_at"
)
SELECT
  membership."org_id",
  membership."user_id",
  install."installed_at",
  now()
FROM "memberships" membership
LEFT JOIN "local_skill_installs" install
  ON install."org_id" = membership."org_id"
 AND install."user_id" = membership."user_id"
 AND install."skill_key" = 'companion'
ON CONFLICT ("org_id", "user_id") DO NOTHING;
