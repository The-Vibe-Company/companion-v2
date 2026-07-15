CREATE TABLE "user_model_preferences" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"activated_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_model_preferences_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "user_model_preferences" ADD CONSTRAINT "user_model_preferences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_model_preferences" ADD CONSTRAINT "user_model_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_model_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_model_preferences_user_rls" ON "user_model_preferences"
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.user_id', true), '')
  );--> statement-breakpoint
CREATE TABLE "org_model_preferences" (
	"org_id" uuid NOT NULL,
	"activated_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_model_preferences_org_id_pk" PRIMARY KEY("org_id")
);
--> statement-breakpoint
ALTER TABLE "org_model_preferences" ADD CONSTRAINT "org_model_preferences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_model_preferences" ADD CONSTRAINT "org_model_preferences_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_model_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_model_preferences_tenant_rls" ON "org_model_preferences"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
