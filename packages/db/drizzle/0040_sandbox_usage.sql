CREATE TYPE "public"."sandbox_usage_kind" AS ENUM('prewarm', 'run');--> statement-breakpoint
CREATE TABLE "user_run_preferences" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"prewarm_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_run_preferences_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);--> statement-breakpoint
CREATE TABLE "sandbox_usage_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"creator_id" text NOT NULL,
	"kind" "sandbox_usage_kind" NOT NULL,
	"source_id" uuid NOT NULL,
	"sandbox_name" text NOT NULL,
	"activation_revision" integer DEFAULT 0 NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"reserved_ms" integer NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"settled_ms" integer,
	"reservation_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_usage_sessions_source_activation_uq" UNIQUE("org_id","kind","source_id","activation_revision"),
	CONSTRAINT "sandbox_usage_sessions_sandbox_activation_uq" UNIQUE("org_id","sandbox_name","activation_revision"),
	CONSTRAINT "sandbox_usage_sessions_duration_check" CHECK ("reserved_ms" >= 60000 AND ("settled_ms" IS NULL OR "settled_ms" >= 0)),
	CONSTRAINT "sandbox_usage_sessions_revision_check" CHECK ("activation_revision" >= 0),
	CONSTRAINT "sandbox_usage_sessions_lifecycle_check" CHECK (("ended_at" IS NULL AND "settled_ms" IS NULL) OR ("ended_at" IS NOT NULL AND "settled_ms" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "user_run_preferences" ADD CONSTRAINT "user_run_preferences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_run_preferences" ADD CONSTRAINT "user_run_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_usage_sessions" ADD CONSTRAINT "sandbox_usage_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_usage_sessions" ADD CONSTRAINT "sandbox_usage_sessions_creator_id_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_usage_sessions_period_idx" ON "sandbox_usage_sessions" USING btree ("org_id","period_start");--> statement-breakpoint
ALTER TABLE "user_run_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sandbox_usage_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_run_preferences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sandbox_usage_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_run_preferences_owner_rls" ON "user_run_preferences"
  USING (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.user_id', true), '')
  );--> statement-breakpoint
CREATE POLICY "sandbox_usage_sessions_tenant_rls" ON "sandbox_usage_sessions"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
