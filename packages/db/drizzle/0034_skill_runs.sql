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
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "transcript_event_sequence" integer DEFAULT 0 NOT NULL,
  "transcript_updated_at" timestamp with time zone,
  "last_active_at" timestamp with time zone,
  "frozen_at" timestamp with time zone,
  "sandbox_cleaned_at" timestamp with time zone,
  "cleanup_lease_owner" text,
  "cleanup_lease_expires_at" timestamp with time zone,
  "cleanup_attempt" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_runs_org_id_id_uq" UNIQUE("org_id", "id"),
  CONSTRAINT "skill_runs_org_id_id_creator_uq" UNIQUE("org_id", "id", "creator_id"),
  CONSTRAINT "skill_runs_idempotency_uq" UNIQUE("org_id", "creator_id", "skill_id", "idempotency_key"),
  CONSTRAINT "skill_runs_timeout_check" CHECK ("timeout_ms" BETWEEN 10000 AND 3600000),
  CONSTRAINT "skill_runs_warnings_array_check" CHECK (jsonb_typeof("warnings") = 'array'),
  CONSTRAINT "skill_runs_transcript_event_sequence_check" CHECK ("transcript_event_sequence" >= 0),
  CONSTRAINT "skill_runs_cleanup_attempt_check" CHECK ("cleanup_attempt" >= 0),
  CONSTRAINT "skill_runs_cleanup_lease_check" CHECK (("cleanup_lease_owner" IS NULL) = ("cleanup_lease_expires_at" IS NULL)),
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
  "lease_reclaim_count" integer DEFAULT 0 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "heartbeat_at" timestamp with time zone,
  "last_error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_jobs_run_uq" UNIQUE("org_id", "run_id"),
  CONSTRAINT "skill_run_jobs_attempt_check" CHECK ("attempt" >= 0 AND "max_attempts" BETWEEN 1 AND 10 AND "attempt" <= "max_attempts"),
  CONSTRAINT "skill_run_jobs_lease_reclaim_check" CHECK ("lease_reclaim_count" >= 0),
  CONSTRAINT "skill_run_jobs_lease_check" CHECK (("status" = 'leased') = ("lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL))
);--> statement-breakpoint

CREATE TABLE "skill_run_worker_heartbeats" (
  "worker_id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_worker_heartbeats_worker_id_check" CHECK (length(btrim("worker_id")) BETWEEN 1 AND 512)
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
  "lease_reclaim_count" integer DEFAULT 0 NOT NULL,
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
  CONSTRAINT "skill_run_prompts_lease_reclaim_check" CHECK ("lease_reclaim_count" >= 0),
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
CREATE INDEX "skill_runs_cleanup_idx" ON "skill_runs" ("status", "cleanup_lease_expires_at", "updated_at") WHERE "sandbox_cleaned_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_run_skills_root_uq" ON "skill_run_skills" ("org_id", "run_id") WHERE "is_root" = true;--> statement-breakpoint
CREATE INDEX "skill_run_secret_inputs_run_env_idx" ON "skill_run_secret_inputs" ("org_id", "run_id", "env_key");--> statement-breakpoint
CREATE INDEX "skill_run_variable_inputs_run_env_idx" ON "skill_run_variable_inputs" ("org_id", "run_id", "env_key");--> statement-breakpoint
CREATE INDEX "skill_run_jobs_claim_idx" ON "skill_run_jobs" ("status", "available_at", "lease_expires_at");--> statement-breakpoint
CREATE INDEX "skill_run_worker_heartbeats_expires_idx" ON "skill_run_worker_heartbeats" ("expires_at");--> statement-breakpoint
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

-- Custom GUCs are caller-settable and are never an authority by themselves. Worker-only policies
-- additionally require the current SQL identity to be the migration/table owner; ordinary API and
-- worker connections use a separate NOBYPASSRLS role and can reach these paths only through the
-- narrow SECURITY DEFINER functions below.
CREATE FUNCTION companion_run_policy_definer() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT current_user = pg_get_userbyid(
    (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.skill_runs'::regclass)
  )
$$;--> statement-breakpoint

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
CREATE POLICY "skill_runs_worker_cleanup" ON "skill_runs" FOR SELECT USING (companion_run_policy_definer() AND current_setting('app.run_worker', true) = 'cleanup');--> statement-breakpoint
CREATE POLICY "skill_runs_worker_cleanup_update" ON "skill_runs" FOR UPDATE USING (companion_run_policy_definer() AND current_setting('app.run_worker', true) = 'cleanup') WITH CHECK (companion_run_policy_definer() AND current_setting('app.run_worker', true) = 'cleanup');--> statement-breakpoint

CREATE POLICY "skill_run_skills_creator" ON "skill_run_skills" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_skills"."org_id" AND r."id" = "skill_run_skills"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_skills"."org_id" AND r."id" = "skill_run_skills"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "skill_run_secret_inputs_creator" ON "skill_run_secret_inputs" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_secret_inputs"."org_id" AND r."id" = "skill_run_secret_inputs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_secret_inputs"."org_id" AND r."id" = "skill_run_secret_inputs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "skill_run_variable_inputs_creator" ON "skill_run_variable_inputs" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_variable_inputs"."org_id" AND r."id" = "skill_run_variable_inputs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_variable_inputs"."org_id" AND r."id" = "skill_run_variable_inputs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "skill_run_jobs_creator_or_worker" ON "skill_run_jobs" USING (("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_jobs"."org_id" AND r."id" = "skill_run_jobs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) OR (companion_run_policy_definer() AND current_setting('app.run_worker', true) = 'claim')) WITH CHECK (("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_jobs"."org_id" AND r."id" = "skill_run_jobs"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) OR (companion_run_policy_definer() AND current_setting('app.run_worker', true) = 'claim'));--> statement-breakpoint
CREATE POLICY "skill_run_prompts_creator" ON "skill_run_prompts" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_prompts"."org_id" AND r."id" = "skill_run_prompts"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_prompts"."org_id" AND r."id" = "skill_run_prompts"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "skill_run_events_creator" ON "skill_run_events" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_events"."org_id" AND r."id" = "skill_run_events"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_events"."org_id" AND r."id" = "skill_run_events"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "skill_run_events_worker_cleanup" ON "skill_run_events" FOR DELETE USING (companion_run_policy_definer() AND current_setting('app.run_worker', true) = 'cleanup');--> statement-breakpoint
CREATE POLICY "skill_run_attachments_creator" ON "skill_run_attachments" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_attachments"."org_id" AND r."id" = "skill_run_attachments"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_attachments"."org_id" AND r."id" = "skill_run_attachments"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint
CREATE POLICY "skill_run_artifacts_creator" ON "skill_run_artifacts" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_artifacts"."org_id" AND r."id" = "skill_run_artifacts"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), ''))) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND EXISTS (SELECT 1 FROM "skill_runs" r WHERE r."org_id" = "skill_run_artifacts"."org_id" AND r."id" = "skill_run_artifacts"."run_id" AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')));--> statement-breakpoint

-- A creator can lose organization membership while a worker owns the run lease. These policies do
-- not create a general worker bypass: every row must match the exact org/run/creator/worker tuple,
-- and the corresponding unexpired lease must still be owned by that worker. Only the narrow
-- SECURITY DEFINER functions below establish this context.
CREATE POLICY "skill_run_jobs_exact_worker_lease_select" ON "skill_run_jobs" FOR SELECT USING (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "run_id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.run_worker_creator_id', true), '')
  AND "status" = 'leased'
  AND "lease_owner" = NULLIF(current_setting('app.run_worker_id', true), '')
  AND "lease_expires_at" > clock_timestamp()
);--> statement-breakpoint
CREATE POLICY "skill_run_jobs_exact_worker_lease_update" ON "skill_run_jobs" FOR UPDATE USING (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "run_id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.run_worker_creator_id', true), '')
  AND "status" = 'leased'
  AND "lease_owner" = NULLIF(current_setting('app.run_worker_id', true), '')
  AND "lease_expires_at" > clock_timestamp()
) WITH CHECK (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "run_id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.run_worker_creator_id', true), '')
  AND "status" IN ('failed', 'canceled')
  AND "lease_owner" IS NULL
  AND "lease_expires_at" IS NULL
);--> statement-breakpoint
CREATE POLICY "skill_runs_exact_worker_lease_select" ON "skill_runs" FOR SELECT USING (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.run_worker_creator_id', true), '')
);--> statement-breakpoint
CREATE POLICY "skill_runs_exact_worker_lease_update" ON "skill_runs" FOR UPDATE USING (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.run_worker_creator_id', true), '')
) WITH CHECK (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.run_worker_creator_id', true), '')
  AND "status" IN ('error', 'canceled')
);--> statement-breakpoint
CREATE POLICY "skill_run_prompts_exact_worker_lease_select" ON "skill_run_prompts" FOR SELECT USING (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "run_id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
);--> statement-breakpoint
CREATE POLICY "skill_run_prompts_exact_worker_lease_update" ON "skill_run_prompts" FOR UPDATE USING (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "run_id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
) WITH CHECK (
  companion_run_policy_definer()
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "run_id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
  AND "status" = 'canceled' AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL
);--> statement-breakpoint
CREATE POLICY "skill_run_events_exact_worker_lease_select" ON "skill_run_events" FOR SELECT USING (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "run_id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
);--> statement-breakpoint
CREATE POLICY "skill_run_events_exact_worker_lease_insert" ON "skill_run_events" FOR INSERT WITH CHECK (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "run_id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
);--> statement-breakpoint

-- Runtime admission is backed by a short worker heartbeat instead of deployment flags in the API.
-- These functions expose only a boolean and the caller's own opaque worker id; no tenant payload is
-- reachable through this operational table.
CREATE FUNCTION companion_heartbeat_skill_run_worker(p_worker_id text, p_ttl_seconds integer DEFAULT 15)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_worker_id IS NULL OR length(btrim(p_worker_id)) < 1 OR length(p_worker_id) > 512 THEN
    RAISE EXCEPTION 'valid worker id is required' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds < 5 OR p_ttl_seconds > 300 THEN
    RAISE EXCEPTION 'invalid worker heartbeat ttl' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public."skill_run_worker_heartbeats" ("worker_id", "expires_at", "updated_at")
  VALUES (p_worker_id, clock_timestamp() + make_interval(secs => p_ttl_seconds), clock_timestamp())
  ON CONFLICT ("worker_id") DO UPDATE
  SET "expires_at" = EXCLUDED."expires_at", "updated_at" = EXCLUDED."updated_at";
  DELETE FROM public."skill_run_worker_heartbeats"
  WHERE "expires_at" <= clock_timestamp() - interval '1 hour';
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_heartbeat_skill_run_worker(text, integer) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_remove_skill_run_worker(p_worker_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_worker_id IS NULL OR length(btrim(p_worker_id)) < 1 OR length(p_worker_id) > 512 THEN
    RAISE EXCEPTION 'valid worker id is required' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public."skill_run_worker_heartbeats" WHERE "worker_id" = p_worker_id;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_remove_skill_run_worker(text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_skill_run_worker_ready()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."skill_run_worker_heartbeats"
    WHERE "expires_at" > clock_timestamp()
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_skill_run_worker_ready() FROM PUBLIC;--> statement-breakpoint

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
      AND (
        (j."status" = 'queued' AND j."attempt" < j."max_attempts")
        -- A crashed/deployed worker did not consume an execution retry. Reclaim the same attempt
        -- even when its transient-failure budget is already at the limit.
        OR (j."status" = 'leased' AND j."lease_expires_at" <= clock_timestamp())
      )
    ORDER BY j."available_at", j."created_at", j."id"
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public."skill_run_jobs" j
  SET "status" = 'leased',
      "attempt" = CASE WHEN j."status" = 'queued' THEN j."attempt" + 1 ELSE j."attempt" END,
      "lease_reclaim_count" = CASE
        WHEN j."status" = 'leased' THEN j."lease_reclaim_count" + 1
        ELSE j."lease_reclaim_count"
      END,
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

CREATE FUNCTION companion_get_skill_run_worker_control(
  p_org_id uuid,
  p_run_id uuid,
  p_creator_id text,
  p_worker_id text
)
RETURNS TABLE (
  "status" "skill_run_status",
  "phase" "skill_run_phase",
  "cancel_requested_at" timestamp with time zone,
  "sandbox_name" text,
  "sandbox_id" text,
  "timeout_ms" integer,
  "membership_active" boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_worker_context text;
  previous_worker_id text;
  previous_worker_org_id text;
  previous_worker_run_id text;
  previous_worker_creator_id text;
  previous_org_id text;
BEGIN
  IF p_org_id IS NULL OR p_run_id IS NULL OR p_creator_id IS NULL OR btrim(p_creator_id) = ''
    OR p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'complete worker lease identity is required' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_worker', true);
  previous_worker_id := current_setting('app.run_worker_id', true);
  previous_worker_org_id := current_setting('app.run_worker_org_id', true);
  previous_worker_run_id := current_setting('app.run_worker_run_id', true);
  previous_worker_creator_id := current_setting('app.run_worker_creator_id', true);
  previous_org_id := current_setting('app.org_id', true);
  PERFORM set_config('app.run_worker', 'exact_lease', true);
  PERFORM set_config('app.run_worker_id', p_worker_id, true);
  PERFORM set_config('app.run_worker_org_id', p_org_id::text, true);
  PERFORM set_config('app.run_worker_run_id', p_run_id::text, true);
  PERFORM set_config('app.run_worker_creator_id', p_creator_id, true);
  PERFORM set_config('app.org_id', p_org_id::text, true);
  RETURN QUERY
  SELECT r."status", r."phase", r."cancel_requested_at", r."sandbox_name", r."sandbox_id",
         r."timeout_ms", EXISTS (
           SELECT 1 FROM public."memberships" m
           WHERE m."org_id" = r."org_id" AND m."user_id" = r."creator_id"
         )
  FROM public."skill_runs" r
  JOIN public."skill_run_jobs" j
    ON j."org_id" = r."org_id" AND j."run_id" = r."id" AND j."creator_id" = r."creator_id"
  WHERE r."org_id" = p_org_id AND r."id" = p_run_id AND r."creator_id" = p_creator_id
    AND j."status" = 'leased' AND j."lease_owner" = p_worker_id
    AND j."lease_expires_at" > clock_timestamp();
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
  PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
  PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
  PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
  PERFORM set_config('app.org_id', COALESCE(previous_org_id, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
  PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
  PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
  PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
  PERFORM set_config('app.org_id', COALESCE(previous_org_id, ''), true);
  RAISE;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_get_skill_run_worker_control(uuid, uuid, text, text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_terminalize_revoked_skill_run(
  p_org_id uuid,
  p_run_id uuid,
  p_creator_id text,
  p_worker_id text,
  p_cleanup_confirmed boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_worker_context text;
  previous_worker_id text;
  previous_worker_org_id text;
  previous_worker_run_id text;
  previous_worker_creator_id text;
  previous_org_id text;
  cancellation boolean;
  failure_phase "skill_run_phase";
  next_sequence integer;
BEGIN
  IF p_org_id IS NULL OR p_run_id IS NULL OR p_creator_id IS NULL OR btrim(p_creator_id) = ''
    OR p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'complete worker lease identity is required' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_worker', true);
  previous_worker_id := current_setting('app.run_worker_id', true);
  previous_worker_org_id := current_setting('app.run_worker_org_id', true);
  previous_worker_run_id := current_setting('app.run_worker_run_id', true);
  previous_worker_creator_id := current_setting('app.run_worker_creator_id', true);
  previous_org_id := current_setting('app.org_id', true);
  PERFORM set_config('app.run_worker', 'exact_lease', true);
  PERFORM set_config('app.run_worker_id', p_worker_id, true);
  PERFORM set_config('app.run_worker_org_id', p_org_id::text, true);
  PERFORM set_config('app.run_worker_run_id', p_run_id::text, true);
  PERFORM set_config('app.run_worker_creator_id', p_creator_id, true);
  PERFORM set_config('app.org_id', p_org_id::text, true);

  SELECT r."cancel_requested_at" IS NOT NULL OR r."status" = 'canceled', r."phase"
  INTO cancellation, failure_phase
  FROM public."skill_runs" r
  JOIN public."skill_run_jobs" j
    ON j."org_id" = r."org_id" AND j."run_id" = r."id" AND j."creator_id" = r."creator_id"
  WHERE r."org_id" = p_org_id AND r."id" = p_run_id AND r."creator_id" = p_creator_id
    AND j."status" = 'leased' AND j."lease_owner" = p_worker_id
    AND j."lease_expires_at" > clock_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM public."memberships" m
      WHERE m."org_id" = r."org_id" AND m."user_id" = r."creator_id"
    )
  FOR UPDATE OF r, j;
  IF cancellation IS NULL THEN
    PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
    PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
    PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
    PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
    PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
    PERFORM set_config('app.org_id', COALESCE(previous_org_id, ''), true);
    RETURN false;
  END IF;

  UPDATE public."skill_runs" r
  SET "status" = CASE WHEN cancellation THEN 'canceled'::"skill_run_status" ELSE 'error'::"skill_run_status" END,
      "phase" = CASE WHEN cancellation THEN 'complete'::"skill_run_phase" ELSE failure_phase END,
      "error_code" = CASE WHEN cancellation THEN NULL ELSE 'membership_revoked' END,
      "user_message" = CASE WHEN cancellation THEN NULL ELSE 'Run stopped because its owner is no longer an organization member' END,
      "frozen_at" = clock_timestamp(),
      "sandbox_cleaned_at" = CASE
        WHEN p_cleanup_confirmed THEN COALESCE(r."sandbox_cleaned_at", clock_timestamp())
        ELSE r."sandbox_cleaned_at"
      END,
      "updated_at" = clock_timestamp()
  WHERE r."org_id" = p_org_id AND r."id" = p_run_id AND r."creator_id" = p_creator_id;

  IF NOT cancellation THEN
    SELECT COALESCE(MAX(e."sequence"), 0) + 1 INTO next_sequence
    FROM public."skill_run_events" e
    WHERE e."org_id" = p_org_id AND e."run_id" = p_run_id;
    INSERT INTO public."skill_run_events" ("org_id", "run_id", "sequence", "type", "payload")
    VALUES (
      p_org_id,
      p_run_id,
      next_sequence,
      'run.error',
      jsonb_build_object(
        'code', 'membership_revoked',
        'message', 'Run stopped because its owner is no longer an organization member',
        'phase', failure_phase::text
      )
    );
  END IF;

  UPDATE public."skill_run_prompts" p
  SET "status" = 'canceled', "lease_owner" = NULL, "lease_expires_at" = NULL,
      "heartbeat_at" = clock_timestamp(), "updated_at" = clock_timestamp()
  WHERE p."org_id" = p_org_id AND p."run_id" = p_run_id
    AND p."status" IN ('queued', 'processing');

  UPDATE public."skill_run_jobs" j
  SET "status" = CASE WHEN cancellation THEN 'canceled'::"skill_run_job_status" ELSE 'failed'::"skill_run_job_status" END,
      "phase" = CASE WHEN cancellation THEN 'complete'::"skill_run_phase" ELSE failure_phase END,
      "lease_owner" = NULL, "lease_expires_at" = NULL,
      "heartbeat_at" = clock_timestamp(), "last_error_code" = CASE WHEN cancellation THEN NULL ELSE 'membership_revoked' END,
      "updated_at" = clock_timestamp()
  WHERE j."org_id" = p_org_id AND j."run_id" = p_run_id AND j."creator_id" = p_creator_id
    AND j."status" = 'leased' AND j."lease_owner" = p_worker_id;

  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
  PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
  PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
  PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
  PERFORM set_config('app.org_id', COALESCE(previous_org_id, ''), true);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
  PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
  PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
  PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
  PERFORM set_config('app.org_id', COALESCE(previous_org_id, ''), true);
  RAISE;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_terminalize_revoked_skill_run(uuid, uuid, text, text, boolean) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_claim_skill_run_cleanups(p_worker_id text, p_limit integer DEFAULT 1, p_lease_seconds integer DEFAULT 30)
RETURNS TABLE (
  "org_id" uuid,
  "run_id" uuid,
  "creator_id" text,
  "sandbox_id" text,
  "sandbox_name" text,
  "cleanup_attempt" integer
)
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
    RAISE EXCEPTION 'invalid cleanup claim limits' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_worker', true);
  PERFORM set_config('app.run_worker', 'cleanup', true);
  RETURN QUERY
  WITH candidates AS (
    SELECT r."org_id", r."id"
    FROM public."skill_runs" r
    WHERE r."status" IN ('frozen', 'error', 'canceled')
      AND r."sandbox_cleaned_at" IS NULL
      AND (r."cleanup_lease_expires_at" IS NULL OR r."cleanup_lease_expires_at" <= clock_timestamp())
    ORDER BY r."updated_at", r."id"
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public."skill_runs" r
    SET "cleanup_lease_owner" = p_worker_id,
        "cleanup_lease_expires_at" = clock_timestamp() + make_interval(secs => p_lease_seconds),
        "cleanup_attempt" = r."cleanup_attempt" + 1
    FROM candidates c
    WHERE r."org_id" = c."org_id" AND r."id" = c."id"
    RETURNING r."org_id", r."id", r."creator_id", r."sandbox_id", r."sandbox_name", r."cleanup_attempt"
  )
  SELECT c."org_id", c."id", c."creator_id", c."sandbox_id", c."sandbox_name", c."cleanup_attempt"
  FROM claimed c;
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  RAISE;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_claim_skill_run_cleanups(text, integer, integer) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_complete_skill_run_cleanup(p_org_id uuid, p_run_id uuid, p_worker_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  updated_count integer;
  previous_worker_context text;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'worker id is required' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_worker', true);
  PERFORM set_config('app.run_worker', 'cleanup', true);
  UPDATE public."skill_runs" r
  SET "sandbox_cleaned_at" = clock_timestamp(),
      "cleanup_lease_owner" = NULL,
      "cleanup_lease_expires_at" = NULL
  WHERE r."org_id" = p_org_id
    AND r."id" = p_run_id
    AND r."sandbox_cleaned_at" IS NULL
    AND r."cleanup_lease_owner" = p_worker_id;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  RETURN updated_count = 1;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  RAISE;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_complete_skill_run_cleanup(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint

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
--> statement-breakpoint

-- The runtime login is intentionally NOBYPASSRLS. A handful of identity-discovery operations must
-- happen before an organization can be selected (or, for bearer tokens/share links, before an actor
-- is known at all). Keep those operations behind narrow SECURITY DEFINER RPCs instead of running the
-- API/worker as the migration owner. Every normal tenant query still uses app.org_id + app.user_id.

CREATE FUNCTION companion_list_user_orgs(p_user_id text)
RETURNS TABLE (
  "org_id" uuid,
  "name" text,
  "slug" text,
  "kind" public."org_kind",
  "org_role" public."org_role",
  "color" text,
  "logo_url" text,
  "member_count" bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT o."id", o."name", o."slug", o."kind", mine."org_role", o."color", o."logo_url",
         (SELECT count(*) FROM public."memberships" all_members WHERE all_members."org_id" = o."id")
  FROM public."memberships" mine
  JOIN public."organizations" o ON o."id" = mine."org_id"
  WHERE mine."user_id" = p_user_id
  ORDER BY mine."created_at"
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_list_user_orgs(text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_users_share_org(p_actor_id text, p_target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p_actor_id = p_target_id OR EXISTS (
    SELECT 1
    FROM public."memberships" actor_membership
    JOIN public."memberships" target_membership
      ON target_membership."org_id" = actor_membership."org_id"
    WHERE actor_membership."user_id" = p_actor_id
      AND target_membership."user_id" = p_target_id
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_users_share_org(text, text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_list_joinable_orgs(p_user_id text)
RETURNS TABLE (
  "org_id" uuid,
  "name" text,
  "domain" text,
  "member_count" bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT o."id", o."name", d."domain",
         (SELECT count(*) FROM public."memberships" members WHERE members."org_id" = o."id")
  FROM public."user" u
  JOIN public."organization_domains" d
    ON lower(d."domain") = lower(split_part(u."email", '@', 2))
  JOIN public."organizations" o ON o."id" = d."org_id" AND o."kind" = 'team'
  WHERE u."id" = p_user_id
    AND NOT EXISTS (
      SELECT 1 FROM public."memberships" mine
      WHERE mine."org_id" = o."id" AND mine."user_id" = p_user_id
    )
  ORDER BY o."name", o."id"
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_list_joinable_orgs(text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_lock_invitation_for_actor(p_user_id text, p_token text)
RETURNS TABLE ("invite_id" uuid, "org_id" uuid, "org_role" public."org_role")
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT i."id", i."org_id", i."org_role"
  FROM public."invitations" i
  JOIN public."user" u ON u."id" = p_user_id AND lower(u."email") = lower(i."email")
  WHERE i."token" = p_token
    AND i."status" = 'pending'
    AND i."expires_at" > clock_timestamp()
  FOR UPDATE OF i
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_lock_invitation_for_actor(text, text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_resolve_api_token(p_token_hash text)
RETURNS TABLE (
  "org_id" uuid,
  "user_id" text,
  "scopes" jsonb,
  "email" text,
  "name" text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH candidate AS MATERIALIZED (
    SELECT t."id", t."org_id", t."user_id", t."scopes",
           COALESCE(p."email", u."email") AS "email",
           COALESCE(NULLIF(p."name", ''), NULLIF(u."name", ''), p."email", u."email", t."user_id") AS "name"
    FROM public."api_tokens" t
    JOIN public."memberships" m ON m."org_id" = t."org_id" AND m."user_id" = t."user_id"
    JOIN public."user" u ON u."id" = t."user_id"
    LEFT JOIN public."profiles" p ON p."id" = t."user_id"
    WHERE t."token_hash" = p_token_hash
      AND t."revoked_at" IS NULL
      AND t."expires_at" > clock_timestamp()
    LIMIT 1
    FOR UPDATE OF t
  ), touched AS (
    UPDATE public."api_tokens" t
    SET "last_used_at" = clock_timestamp()
    FROM candidate c
    WHERE t."id" = c."id"
    RETURNING t."id"
  )
  SELECT c."org_id", c."user_id", c."scopes", c."email", c."name"
  FROM candidate c
  JOIN touched ON touched."id" = c."id"
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_resolve_api_token(text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_public_skill_preview(p_token text)
RETURNS TABLE (
  "slug" text,
  "display_name" text,
  "description" text,
  "creator_name" text,
  "creator_initials" text,
  "current_version" text,
  "frontmatter" text,
  "star_count" bigint,
  "updated_at" timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s."slug", s."display_name", s."description", p."name", p."initials", v."version",
         v."frontmatter", count(stars."user_id"), s."updated_at"
  FROM public."skills" s
  JOIN public."profiles" p ON p."id" = s."creator_id"
  JOIN public."skill_versions" v
    ON v."org_id" = s."org_id" AND v."skill_id" = s."id" AND v."id" = s."current_version_id"
  LEFT JOIN public."skill_stars" stars
    ON stars."org_id" = s."org_id" AND stars."skill_id" = s."id"
  WHERE s."share_token" = p_token AND s."scope" = 'org' AND s."archived_at" IS NULL
  GROUP BY s."id", p."id", v."id"
  LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_public_skill_preview(text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_skill_share_target(p_token text, p_user_id text)
RETURNS TABLE ("org_id" uuid, "slug" text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s."org_id", s."slug"
  FROM public."skills" s
  JOIN public."memberships" m ON m."org_id" = s."org_id" AND m."user_id" = p_user_id
  WHERE s."share_token" = p_token AND s."scope" = 'org' AND s."archived_at" IS NULL
  LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_skill_share_target(text, text) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION companion_billing_org_for_stripe_event(p_subscription_id text, p_customer_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT b."org_id"
  FROM public."billing_subscriptions" b
  WHERE (p_subscription_id IS NOT NULL AND b."stripe_subscription_id" = p_subscription_id)
     OR (p_customer_id IS NOT NULL AND b."stripe_customer_id" = p_customer_id)
  ORDER BY CASE WHEN p_subscription_id IS NOT NULL AND b."stripe_subscription_id" = p_subscription_id THEN 0 ELSE 1 END
  LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_billing_org_for_stripe_event(text, text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_list_billing_sync_candidates(
  p_now timestamp with time zone,
  p_full boolean,
  p_limit integer
)
RETURNS TABLE ("org_id" uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_now IS NULL OR p_full IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'invalid billing candidate scan input' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT b."org_id"
  FROM public."billing_subscriptions" b
  WHERE CASE
    WHEN p_full THEN b."last_reconciled_at" IS NULL OR b."last_reconciled_at" <= p_now - interval '15 minutes'
    ELSE b."seat_sync_status" IN ('pending', 'error')
      AND (b."next_retry_at" IS NULL OR b."next_retry_at" <= p_now)
  END
  ORDER BY COALESCE(b."next_retry_at", b."last_reconciled_at", b."created_at"), b."org_id"
  FOR UPDATE OF b SKIP LOCKED
  LIMIT p_limit;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_list_billing_sync_candidates(timestamp with time zone, boolean, integer) FROM PUBLIC;
