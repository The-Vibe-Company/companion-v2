CREATE TABLE "skill_filter_preferences" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"active_filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_views" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_filter_preferences_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "skill_filter_preferences" ADD CONSTRAINT "skill_filter_preferences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_filter_preferences" ADD CONSTRAINT "skill_filter_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_filter_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "skill_filter_preferences_user_rls" ON "skill_filter_preferences"
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.user_id', true), '')
  );
