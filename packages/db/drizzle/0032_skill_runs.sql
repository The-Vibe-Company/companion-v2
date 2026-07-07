CREATE TYPE "public"."skill_run_status" AS ENUM('starting', 'running', 'frozen', 'error');--> statement-breakpoint
CREATE TABLE "skill_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"creator_id" text NOT NULL,
	"skill_version" text,
	"model" text NOT NULL,
	"prompt" text NOT NULL,
	"status" "skill_run_status" DEFAULT 'starting' NOT NULL,
	"status_detail" text,
	"sandbox_name" text,
	"sandbox_id" text,
	"sandbox_domain" text,
	"golden_snapshot_id" text,
	"opencode_version" text,
	"opencode_session_id" text,
	"server_password_enc" text,
	"timeout_ms" integer DEFAULT 300000 NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transcript_updated_at" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_runs_org_id_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_creator_id_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_org_fk" FOREIGN KEY ("org_id","skill_id") REFERENCES "public"."skills"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_runs_sessions_idx" ON "skill_runs" USING btree ("org_id","skill_id","creator_id","created_at" DESC);--> statement-breakpoint
ALTER TABLE "skill_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "skill_runs_tenant_rls" ON "skill_runs"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE TABLE "skill_run_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_run_attachments" ADD CONSTRAINT "skill_run_attachments_run_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "public"."skill_runs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_run_attachments_run_idx" ON "skill_run_attachments" USING btree ("org_id","run_id");--> statement-breakpoint
ALTER TABLE "skill_run_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "skill_run_attachments_tenant_rls" ON "skill_run_attachments"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE TABLE "skill_run_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"path" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text,
	"byte_size" integer NOT NULL,
	"vanish_id" text,
	"url" text NOT NULL,
	"expires_at" timestamp with time zone,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_run_artifacts_run_path_uq" UNIQUE("run_id","path")
);
--> statement-breakpoint
ALTER TABLE "skill_run_artifacts" ADD CONSTRAINT "skill_run_artifacts_run_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "public"."skill_runs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_run_artifacts_run_idx" ON "skill_run_artifacts" USING btree ("org_id","run_id");--> statement-breakpoint
ALTER TABLE "skill_run_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "skill_run_artifacts_tenant_rls" ON "skill_run_artifacts"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
