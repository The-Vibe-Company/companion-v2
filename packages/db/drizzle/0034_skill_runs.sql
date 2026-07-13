CREATE TYPE "skill_run_status" AS ENUM ('queued', 'starting', 'running', 'frozen', 'error', 'canceled');--> statement-breakpoint
CREATE TYPE "skill_run_phase" AS ENUM ('queued', 'resolve_inputs', 'fork', 'push_workspace', 'start_server', 'healthcheck', 'create_session', 'prompt', 'record', 'collect_artifacts', 'freeze', 'cancel', 'cleanup', 'complete');--> statement-breakpoint
CREATE TYPE "skill_run_secret_provenance" AS ENUM ('skill', 'model_provider', 'runtime');--> statement-breakpoint
CREATE TYPE "skill_run_job_status" AS ENUM ('queued', 'leased', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "skill_run_prompt_kind" AS ENUM ('initial', 'follow_up');--> statement-breakpoint
CREATE TYPE "skill_run_prompt_status" AS ENUM ('queued', 'processing', 'completed', 'error', 'canceled');--> statement-breakpoint

ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_org_skill_id_uq" UNIQUE("org_id", "skill_id", "id");--> statement-breakpoint

CREATE TABLE "skill_run_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "name" text NOT NULL,
  "model" text NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_configs_org_id_id_uq" UNIQUE("org_id", "id"),
  CONSTRAINT "skill_run_configs_identity_uq" UNIQUE("org_id", "id", "creator_id", "skill_id"),
  CONSTRAINT "skill_run_configs_name_uq" UNIQUE("org_id", "creator_id", "skill_id", "name"),
  CONSTRAINT "skill_run_configs_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "skill_run_configs_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120)
);--> statement-breakpoint

CREATE TABLE "skill_run_config_secrets" (
  "org_id" uuid NOT NULL,
  "config_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "slot_id" uuid NOT NULL,
  "secret_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_config_secrets_pk" PRIMARY KEY("org_id", "config_id", "skill_id", "slot_id")
);--> statement-breakpoint

CREATE TABLE "skill_run_config_variables" (
  "org_id" uuid NOT NULL,
  "config_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "env_key" text NOT NULL,
  "value" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_config_variables_pk" PRIMARY KEY("org_id", "config_id", "skill_id", "env_key"),
  CONSTRAINT "skill_run_config_variables_key_check" CHECK ("env_key" ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND "env_key" !~ '^OPENCODE_SERVER_'),
  CONSTRAINT "skill_run_config_variables_value_size_check" CHECK (octet_length("value") <= 32768)
);--> statement-breakpoint

CREATE TABLE "skill_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "skill_version_id" uuid NOT NULL,
  "skill_version" text NOT NULL,
  "run_config_id" uuid,
  "run_config_name_snapshot" text,
  "idempotency_key" text NOT NULL,
  "payload_hash" text NOT NULL,
  "model" text NOT NULL,
  "prompt" text NOT NULL,
  "status" "skill_run_status" DEFAULT 'queued' NOT NULL,
  "phase" "skill_run_phase" DEFAULT 'queued' NOT NULL,
  "error_code" text,
  "user_message" text,
  "cancel_requested_at" timestamp with time zone,
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
  "sandbox_cleaned_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_runs_org_id_id_uq" UNIQUE("org_id", "id"),
  CONSTRAINT "skill_runs_org_id_id_creator_uq" UNIQUE("org_id", "id", "creator_id"),
  CONSTRAINT "skill_runs_idempotency_uq" UNIQUE("org_id", "creator_id", "skill_id", "idempotency_key"),
  CONSTRAINT "skill_runs_timeout_check" CHECK ("timeout_ms" BETWEEN 10000 AND 3600000),
  CONSTRAINT "skill_runs_idempotency_key_check" CHECK (char_length("idempotency_key") BETWEEN 8 AND 200),
  CONSTRAINT "skill_runs_payload_hash_check" CHECK (char_length("payload_hash") BETWEEN 32 AND 128)
);--> statement-breakpoint

CREATE TABLE "skill_run_skills" (
  "org_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "skill_version_id" uuid NOT NULL,
  "is_root" boolean DEFAULT false NOT NULL,
  "mount_order" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_skills_pk" PRIMARY KEY("org_id", "run_id", "skill_id"),
  CONSTRAINT "skill_run_skills_mount_order_uq" UNIQUE("org_id", "run_id", "mount_order"),
  CONSTRAINT "skill_run_skills_mount_order_check" CHECK ("mount_order" >= 0)
);--> statement-breakpoint

CREATE TABLE "skill_run_secret_inputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "skill_id" uuid,
  "slot_id" uuid,
  "source_key" text NOT NULL,
  "env_key" text NOT NULL,
  "secret_id" uuid,
  "secret_version" integer,
  "secret_name_snapshot" text,
  "provenance" "skill_run_secret_provenance" NOT NULL,
  "required" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_secret_inputs_source_uq" UNIQUE("org_id", "run_id", "provenance", "source_key"),
  CONSTRAINT "skill_run_secret_inputs_key_check" CHECK ("env_key" ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND ("provenance" = 'runtime' OR "env_key" !~ '^OPENCODE_SERVER_')),
  CONSTRAINT "skill_run_secret_inputs_provenance_check" CHECK (
    (("provenance" = 'runtime' AND "secret_id" IS NULL AND "secret_version" IS NULL)
      OR ("provenance" IN ('skill', 'model_provider') AND "secret_id" IS NOT NULL AND "secret_version" IS NOT NULL))
    AND ("provenance" <> 'skill' OR ("skill_id" IS NOT NULL AND "slot_id" IS NOT NULL))
  )
);--> statement-breakpoint

CREATE TABLE "skill_run_variable_inputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "env_key" text NOT NULL,
  "value" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_variable_inputs_declaration_uq" UNIQUE("org_id", "run_id", "skill_id", "env_key"),
  CONSTRAINT "skill_run_variable_inputs_key_check" CHECK ("env_key" ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND "env_key" !~ '^OPENCODE_SERVER_'),
  CONSTRAINT "skill_run_variable_inputs_value_size_check" CHECK (octet_length("value") <= 32768)
);--> statement-breakpoint

CREATE TABLE "skill_run_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "status" "skill_run_job_status" DEFAULT 'queued' NOT NULL,
  "phase" "skill_run_phase" DEFAULT 'queued' NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 3 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "heartbeat_at" timestamp with time zone,
  "last_error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_jobs_run_uq" UNIQUE("org_id", "run_id"),
  CONSTRAINT "skill_run_jobs_attempt_check" CHECK ("attempt" >= 0 AND "max_attempts" BETWEEN 1 AND 10 AND "attempt" <= "max_attempts"),
  CONSTRAINT "skill_run_jobs_lease_check" CHECK (("status" = 'leased') = ("lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL))
);--> statement-breakpoint

CREATE TABLE "skill_run_prompts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "kind" "skill_run_prompt_kind" NOT NULL,
  "idempotency_key" text NOT NULL,
  "payload_hash" text NOT NULL,
  "message_id" text NOT NULL,
  "prompt" text NOT NULL,
  "status" "skill_run_prompt_status" DEFAULT 'queued' NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "heartbeat_at" timestamp with time zone,
  "error_code" text,
  "user_message" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_prompts_ordinal_uq" UNIQUE("org_id", "run_id", "ordinal"),
  CONSTRAINT "skill_run_prompts_message_uq" UNIQUE("org_id", "run_id", "message_id"),
  CONSTRAINT "skill_run_prompts_idempotency_uq" UNIQUE("org_id", "run_id", "idempotency_key"),
  CONSTRAINT "skill_run_prompts_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "skill_run_prompts_attempt_check" CHECK ("attempt" BETWEEN 0 AND 10),
  CONSTRAINT "skill_run_prompts_idempotency_key_check" CHECK (char_length("idempotency_key") BETWEEN 8 AND 200),
  CONSTRAINT "skill_run_prompts_payload_hash_check" CHECK (char_length("payload_hash") BETWEEN 32 AND 128)
);--> statement-breakpoint

CREATE TABLE "skill_run_events" (
  "org_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_events_pk" PRIMARY KEY("org_id", "run_id", "sequence"),
  CONSTRAINT "skill_run_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "skill_run_events_type_check" CHECK (char_length("type") BETWEEN 1 AND 100)
);--> statement-breakpoint

CREATE TABLE "skill_run_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "storage_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_attachments_storage_key_uq" UNIQUE("storage_key"),
  CONSTRAINT "skill_run_attachments_size_check" CHECK ("byte_size" > 0 AND "byte_size" <= 10485760)
);--> statement-breakpoint

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
  CONSTRAINT "skill_run_artifacts_run_path_uq" UNIQUE("org_id", "run_id", "path"),
  CONSTRAINT "skill_run_artifacts_size_check" CHECK ("byte_size" >= 0 AND "byte_size" <= 10485760)
);--> statement-breakpoint

ALTER TABLE "skill_run_configs" ADD CONSTRAINT "skill_run_configs_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_configs" ADD CONSTRAINT "skill_run_configs_creator_fk" FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_configs" ADD CONSTRAINT "skill_run_configs_skill_org_fk" FOREIGN KEY ("org_id", "skill_id") REFERENCES "skills"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_config_secrets" ADD CONSTRAINT "skill_run_config_secrets_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_config_secrets" ADD CONSTRAINT "skill_run_config_secrets_config_org_fk" FOREIGN KEY ("org_id", "config_id") REFERENCES "skill_run_configs"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_config_secrets" ADD CONSTRAINT "skill_run_config_secrets_slot_org_fk" FOREIGN KEY ("org_id", "skill_id", "slot_id") REFERENCES "skill_secret_slots"("org_id", "skill_id", "slot_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_config_secrets" ADD CONSTRAINT "skill_run_config_secrets_secret_org_fk" FOREIGN KEY ("org_id", "secret_id") REFERENCES "secrets"("org_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "skill_run_config_variables" ADD CONSTRAINT "skill_run_config_variables_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_config_variables" ADD CONSTRAINT "skill_run_config_variables_config_org_fk" FOREIGN KEY ("org_id", "config_id") REFERENCES "skill_run_configs"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_config_variables" ADD CONSTRAINT "skill_run_config_variables_skill_org_fk" FOREIGN KEY ("org_id", "skill_id") REFERENCES "skills"("org_id", "id") ON DELETE cascade;--> statement-breakpoint

ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_creator_fk" FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_org_fk" FOREIGN KEY ("org_id", "skill_id") REFERENCES "skills"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_version_org_fk" FOREIGN KEY ("org_id", "skill_id", "skill_version_id") REFERENCES "skill_versions"("org_id", "skill_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_config_fk" FOREIGN KEY ("org_id", "run_config_id", "creator_id", "skill_id") REFERENCES "skill_run_configs"("org_id", "id", "creator_id", "skill_id");--> statement-breakpoint
ALTER TABLE "skill_run_skills" ADD CONSTRAINT "skill_run_skills_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_skills" ADD CONSTRAINT "skill_run_skills_run_org_fk" FOREIGN KEY ("org_id", "run_id") REFERENCES "skill_runs"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_skills" ADD CONSTRAINT "skill_run_skills_version_org_fk" FOREIGN KEY ("org_id", "skill_id", "skill_version_id") REFERENCES "skill_versions"("org_id", "skill_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "skill_run_secret_inputs" ADD CONSTRAINT "skill_run_secret_inputs_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_secret_inputs" ADD CONSTRAINT "skill_run_secret_inputs_run_org_fk" FOREIGN KEY ("org_id", "run_id") REFERENCES "skill_runs"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_secret_inputs" ADD CONSTRAINT "skill_run_secret_inputs_skill_org_fk" FOREIGN KEY ("org_id", "skill_id") REFERENCES "skills"("org_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "skill_run_secret_inputs" ADD CONSTRAINT "skill_run_secret_inputs_slot_org_fk" FOREIGN KEY ("org_id", "skill_id", "slot_id") REFERENCES "skill_secret_slots"("org_id", "skill_id", "slot_id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "skill_run_secret_inputs" ADD CONSTRAINT "skill_run_secret_inputs_secret_version_org_fk" FOREIGN KEY ("org_id", "secret_id", "secret_version") REFERENCES "secret_versions"("org_id", "secret_id", "version") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "skill_run_variable_inputs" ADD CONSTRAINT "skill_run_variable_inputs_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_variable_inputs" ADD CONSTRAINT "skill_run_variable_inputs_run_org_fk" FOREIGN KEY ("org_id", "run_id") REFERENCES "skill_runs"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_variable_inputs" ADD CONSTRAINT "skill_run_variable_inputs_skill_org_fk" FOREIGN KEY ("org_id", "skill_id") REFERENCES "skills"("org_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "skill_run_jobs" ADD CONSTRAINT "skill_run_jobs_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_jobs" ADD CONSTRAINT "skill_run_jobs_run_creator_fk" FOREIGN KEY ("org_id", "run_id", "creator_id") REFERENCES "skill_runs"("org_id", "id", "creator_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_prompts" ADD CONSTRAINT "skill_run_prompts_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_prompts" ADD CONSTRAINT "skill_run_prompts_run_org_fk" FOREIGN KEY ("org_id", "run_id") REFERENCES "skill_runs"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_events" ADD CONSTRAINT "skill_run_events_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_events" ADD CONSTRAINT "skill_run_events_run_org_fk" FOREIGN KEY ("org_id", "run_id") REFERENCES "skill_runs"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_attachments" ADD CONSTRAINT "skill_run_attachments_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_attachments" ADD CONSTRAINT "skill_run_attachments_run_fk" FOREIGN KEY ("org_id", "run_id") REFERENCES "skill_runs"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_artifacts" ADD CONSTRAINT "skill_run_artifacts_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "skill_run_artifacts" ADD CONSTRAINT "skill_run_artifacts_run_fk" FOREIGN KEY ("org_id", "run_id") REFERENCES "skill_runs"("org_id", "id") ON DELETE cascade;--> statement-breakpoint

CREATE UNIQUE INDEX "skill_run_configs_default_uq" ON "skill_run_configs" ("org_id", "creator_id", "skill_id") WHERE "is_default" = true;--> statement-breakpoint
CREATE INDEX "skill_run_configs_owner_skill_idx" ON "skill_run_configs" ("org_id", "creator_id", "skill_id", "updated_at" DESC);--> statement-breakpoint
CREATE INDEX "skill_run_config_secrets_secret_idx" ON "skill_run_config_secrets" ("org_id", "secret_id");--> statement-breakpoint
CREATE INDEX "skill_runs_sessions_idx" ON "skill_runs" ("org_id", "skill_id", "creator_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "skill_runs_cleanup_idx" ON "skill_runs" ("status", "updated_at") WHERE "sandbox_cleaned_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_run_skills_root_uq" ON "skill_run_skills" ("org_id", "run_id") WHERE "is_root" = true;--> statement-breakpoint
CREATE INDEX "skill_run_secret_inputs_run_env_idx" ON "skill_run_secret_inputs" ("org_id", "run_id", "env_key");--> statement-breakpoint
CREATE INDEX "skill_run_variable_inputs_run_env_idx" ON "skill_run_variable_inputs" ("org_id", "run_id", "env_key");--> statement-breakpoint
CREATE INDEX "skill_run_jobs_claim_idx" ON "skill_run_jobs" ("status", "available_at", "lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_run_prompts_pending_uq" ON "skill_run_prompts" ("org_id", "run_id") WHERE "status" IN ('queued', 'processing');--> statement-breakpoint
CREATE INDEX "skill_run_prompts_available_idx" ON "skill_run_prompts" ("status", "available_at");--> statement-breakpoint
CREATE INDEX "skill_run_events_retention_idx" ON "skill_run_events" ("created_at");--> statement-breakpoint
CREATE INDEX "skill_run_attachments_run_idx" ON "skill_run_attachments" ("org_id", "run_id");--> statement-breakpoint
CREATE INDEX "skill_run_artifacts_run_idx" ON "skill_run_artifacts" ("org_id", "run_id");--> statement-breakpoint

CREATE FUNCTION companion_reject_run_snapshot_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'run input snapshots are immutable' USING ERRCODE = '55000';
END
$$;--> statement-breakpoint
CREATE TRIGGER skill_run_skills_immutable BEFORE UPDATE ON "skill_run_skills" FOR EACH ROW EXECUTE FUNCTION companion_reject_run_snapshot_update();--> statement-breakpoint
CREATE TRIGGER skill_run_secret_inputs_immutable BEFORE UPDATE ON "skill_run_secret_inputs" FOR EACH ROW EXECUTE FUNCTION companion_reject_run_snapshot_update();--> statement-breakpoint
CREATE TRIGGER skill_run_variable_inputs_immutable BEFORE UPDATE ON "skill_run_variable_inputs" FOR EACH ROW EXECUTE FUNCTION companion_reject_run_snapshot_update();--> statement-breakpoint

CREATE FUNCTION companion_detach_deleted_run_config() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public."skill_runs" r
  SET "run_config_id" = NULL
  WHERE r."org_id" = OLD."org_id"
    AND r."run_config_id" = OLD."id"
    AND r."creator_id" = OLD."creator_id"
    AND r."skill_id" = OLD."skill_id";
  RETURN OLD;
END
$$;--> statement-breakpoint
CREATE TRIGGER skill_run_configs_detach BEFORE DELETE ON "skill_run_configs" FOR EACH ROW EXECUTE FUNCTION companion_detach_deleted_run_config();--> statement-breakpoint

ALTER TABLE "skill_run_configs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_config_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_config_variables" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_secret_inputs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_variable_inputs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_prompts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_configs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_config_secrets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_config_variables" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_skills" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_secret_inputs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_variable_inputs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_prompts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_attachments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_artifacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "skill_run_configs_creator" ON "skill_run_configs" USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM "memberships" m WHERE m."org_id" = "skill_run_configs"."org_id" AND m."user_id" = "skill_run_configs"."creator_id")
) WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM "memberships" m WHERE m."org_id" = "skill_run_configs"."org_id" AND m."user_id" = "skill_run_configs"."creator_id")
);--> statement-breakpoint
CREATE POLICY "skill_run_config_secrets_creator" ON "skill_run_config_secrets" USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM "skill_run_configs" c WHERE c."org_id" = "skill_run_config_secrets"."org_id" AND c."id" = "skill_run_config_secrets"."config_id" AND c."creator_id" = NULLIF(current_setting('app.user_id', true), ''))
) WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM "skill_run_configs" c WHERE c."org_id" = "skill_run_config_secrets"."org_id" AND c."id" = "skill_run_config_secrets"."config_id" AND c."creator_id" = NULLIF(current_setting('app.user_id', true), ''))
);--> statement-breakpoint
CREATE POLICY "skill_run_config_variables_creator" ON "skill_run_config_variables" USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM "skill_run_configs" c WHERE c."org_id" = "skill_run_config_variables"."org_id" AND c."id" = "skill_run_config_variables"."config_id" AND c."creator_id" = NULLIF(current_setting('app.user_id', true), ''))
) WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM "skill_run_configs" c WHERE c."org_id" = "skill_run_config_variables"."org_id" AND c."id" = "skill_run_config_variables"."config_id" AND c."creator_id" = NULLIF(current_setting('app.user_id', true), ''))
);--> statement-breakpoint
CREATE POLICY "skill_runs_creator" ON "skill_runs" USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM "memberships" m WHERE m."org_id" = "skill_runs"."org_id" AND m."user_id" = "skill_runs"."creator_id")
) WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM "memberships" m WHERE m."org_id" = "skill_runs"."org_id" AND m."user_id" = "skill_runs"."creator_id")
);--> statement-breakpoint
CREATE POLICY "skill_runs_worker_cleanup" ON "skill_runs" FOR SELECT USING (current_setting('app.run_worker', true) = 'cleanup');--> statement-breakpoint

CREATE POLICY "skill_run_skills_creator" ON "skill_run_skills" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_skills"."org_id" AND r."id" = "skill_run_skills"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_skills"."org_id" AND r."id" = "skill_run_skills"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "skill_run_secret_inputs_creator" ON "skill_run_secret_inputs" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_secret_inputs"."org_id" AND r."id" = "skill_run_secret_inputs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_secret_inputs"."org_id" AND r."id" = "skill_run_secret_inputs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "skill_run_variable_inputs_creator" ON "skill_run_variable_inputs" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_variable_inputs"."org_id" AND r."id" = "skill_run_variable_inputs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_variable_inputs"."org_id" AND r."id" = "skill_run_variable_inputs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "skill_run_jobs_creator_or_worker" ON "skill_run_jobs" USING (("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_jobs"."org_id" AND r."id" = "skill_run_jobs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) OR current_setting('app.run_worker', true) = 'claim') WITH CHECK (("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_jobs"."org_id" AND r."id" = "skill_run_jobs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) OR current_setting('app.run_worker', true) = 'claim');--> statement-breakpoint
CREATE POLICY "skill_run_prompts_creator" ON "skill_run_prompts" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_prompts"."org_id" AND r."id" = "skill_run_prompts"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_prompts"."org_id" AND r."id" = "skill_run_prompts"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "skill_run_events_creator" ON "skill_run_events" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_events"."org_id" AND r."id" = "skill_run_events"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_events"."org_id" AND r."id" = "skill_run_events"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "skill_run_events_worker_cleanup" ON "skill_run_events" FOR DELETE USING (current_setting('app.run_worker', true) = 'cleanup');--> statement-breakpoint
CREATE POLICY "skill_run_attachments_creator" ON "skill_run_attachments" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_attachments"."org_id" AND r."id" = "skill_run_attachments"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_attachments"."org_id" AND r."id" = "skill_run_attachments"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "skill_run_artifacts_creator" ON "skill_run_artifacts" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_artifacts"."org_id" AND r."id" = "skill_run_artifacts"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_artifacts"."org_id" AND r."id" = "skill_run_artifacts"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint

CREATE FUNCTION companion_claim_skill_run_jobs(p_worker_id text, p_limit integer DEFAULT 1, p_lease_seconds integer DEFAULT 30)
RETURNS SETOF "skill_run_jobs"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_worker_context text;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'worker id is required' USING ERRCODE = '22023';
  END IF;
  IF p_limit < 1 OR p_limit > 32 OR p_lease_seconds < 5 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'invalid claim limits' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_worker', true);
  PERFORM set_config('app.run_worker', 'claim', true);
  RETURN QUERY
  WITH candidates AS (
    SELECT j."id"
    FROM public."skill_run_jobs" j
    WHERE j."available_at" <= clock_timestamp()
      AND j."attempt" < j."max_attempts"
      AND (
        j."status" = 'queued'
        OR (j."status" = 'leased' AND j."lease_expires_at" <= clock_timestamp())
      )
    ORDER BY j."available_at", j."created_at", j."id"
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public."skill_run_jobs" j
  SET "status" = 'leased',
      "attempt" = j."attempt" + 1,
      "lease_owner" = p_worker_id,
      "lease_expires_at" = clock_timestamp() + make_interval(secs => p_lease_seconds),
      "heartbeat_at" = clock_timestamp(),
      "updated_at" = clock_timestamp()
  FROM candidates c
  WHERE j."id" = c."id"
  RETURNING j.*;
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_claim_skill_run_jobs(text, integer, integer) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_notify_skill_run_event() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_notify(
    'skill_run_events',
    json_build_object('run_id', NEW."run_id", 'sequence', NEW."sequence")::text
  );
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER skill_run_events_notify AFTER INSERT ON "skill_run_events" FOR EACH ROW EXECUTE FUNCTION companion_notify_skill_run_event();--> statement-breakpoint

CREATE FUNCTION companion_cleanup_skill_run_events(p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted_count integer;
  previous_worker_context text;
BEGIN
  IF p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'invalid cleanup limit' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_worker', true);
  PERFORM set_config('app.run_worker', 'cleanup', true);
  WITH victims AS (
    SELECT e.ctid
    FROM public."skill_run_events" e
    JOIN public."skill_runs" r ON r."org_id" = e."org_id" AND r."id" = e."run_id"
    WHERE r."status" IN ('frozen', 'error', 'canceled')
      AND COALESCE(r."frozen_at", r."updated_at") < clock_timestamp() - interval '24 hours'
      AND e."created_at" < clock_timestamp() - interval '24 hours'
    ORDER BY e."created_at"
    FOR UPDATE OF e SKIP LOCKED
    LIMIT p_limit
  )
  DELETE FROM public."skill_run_events" e
  USING victims v
  WHERE e.ctid = v.ctid;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  RETURN deleted_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  RAISE;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_cleanup_skill_run_events(integer) FROM PUBLIC;
