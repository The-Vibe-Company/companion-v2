CREATE TYPE "public"."agent_scope" AS ENUM('personal', 'org');--> statement-breakpoint
CREATE TYPE "public"."agent_lifecycle" AS ENUM('provisioning', 'ready', 'error');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"scope" "agent_scope" DEFAULT 'personal' NOT NULL,
	"creator_id" text NOT NULL,
	"client_label" text,
	"group_label" text,
	"instructions" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"region" text DEFAULT 'iad1' NOT NULL,
	"lifecycle" "agent_lifecycle" DEFAULT 'provisioning' NOT NULL,
	"sandbox_name" text,
	"sandbox_id" text,
	"sandbox_domain" text,
	"golden_snapshot_id" text,
	"opencode_version" text,
	"provision_attempt" integer DEFAULT 1 NOT NULL,
	"provision_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provision_error" jsonb,
	"pending_op" jsonb,
	"server_password_enc" text,
	"sessions_cache" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_resume_ms" integer,
	"timeout_ms" integer DEFAULT 300000 NOT NULL,
	"last_active_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_org_slug_uq" UNIQUE("org_id","slug"),
	CONSTRAINT "agents_org_id_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_creator_id_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_org_scope_creator_idx" ON "agents" USING btree ("org_id","scope","creator_id");--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "agents_tenant_rls" ON "agents"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"pushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_skills_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_org_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_org_fk" FOREIGN KEY ("org_id","skill_id") REFERENCES "public"."skills"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_skills_org_skill_idx" ON "agent_skills" USING btree ("org_id","skill_id");--> statement-breakpoint
ALTER TABLE "agent_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "agent_skills_tenant_rls" ON "agent_skills"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE TABLE "agent_secrets" (
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_secrets_agent_id_key_pk" PRIMARY KEY("agent_id","key"),
	CONSTRAINT "agent_secrets_key_check" CHECK ("key" ~ '^[A-Za-z_][A-Za-z0-9_]*$')
);
--> statement-breakpoint
ALTER TABLE "agent_secrets" ADD CONSTRAINT "agent_secrets_agent_org_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_secrets" ADD CONSTRAINT "agent_secrets_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "agent_secrets_tenant_rls" ON "agent_secrets"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
