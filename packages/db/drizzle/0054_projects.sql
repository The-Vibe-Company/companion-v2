CREATE TYPE "project_workspace_status" AS ENUM (
  'queued', 'provisioning', 'ready', 'running', 'stopping', 'stopped',
  'needs_attention', 'deleting', 'deleted', 'error'
);--> statement-breakpoint
CREATE TYPE "project_session_status" AS ENUM (
  'queued', 'working', 'idle', 'stopping', 'stopped', 'completed', 'error'
);--> statement-breakpoint
CREATE TYPE "project_prompt_status" AS ENUM (
  'queued', 'dispatching', 'running', 'completed', 'failed', 'cancelled'
);--> statement-breakpoint
CREATE TYPE "project_attachment_status" AS ENUM ('uploaded', 'materialized', 'failed');--> statement-breakpoint
ALTER TYPE "sandbox_usage_kind" ADD VALUE IF NOT EXISTS 'project';--> statement-breakpoint

ALTER TABLE "audit_log"
  ADD COLUMN "private_to_user_id" text;--> statement-breakpoint
ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_private_to_user_fk"
  FOREIGN KEY ("private_to_user_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "audit_log_private_user_idx"
  ON "audit_log" ("org_id", "private_to_user_id", "created_at" DESC);--> statement-breakpoint
DROP POLICY "audit_log_tenant_rls" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_log_tenant_or_private_user_rls" ON "audit_log"
USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND (
    "private_to_user_id" IS NULL
    OR (
      "private_to_user_id" = NULLIF(current_setting('app.user_id', true), '')
      AND EXISTS (
        SELECT 1 FROM public."memberships" membership
        WHERE membership."org_id" = "audit_log"."org_id"
          AND membership."user_id" = "audit_log"."private_to_user_id"
      )
    )
  )
)
WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND (
    "private_to_user_id" IS NULL
    OR (
      "private_to_user_id" = NULLIF(current_setting('app.user_id', true), '')
      AND EXISTS (
        SELECT 1 FROM public."memberships" membership
        WHERE membership."org_id" = "audit_log"."org_id"
          AND membership."user_id" = "audit_log"."private_to_user_id"
      )
    )
  )
);--> statement-breakpoint

CREATE TABLE "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "payload_hash" text NOT NULL,
  "name" text NOT NULL,
  "default_model" text NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "delete_requested_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "projects_org_id_id_uq" UNIQUE("org_id", "id"),
  CONSTRAINT "projects_org_id_id_creator_uq" UNIQUE("org_id", "id", "creator_id"),
  CONSTRAINT "projects_idempotency_uq" UNIQUE("org_id", "creator_id", "idempotency_key"),
  CONSTRAINT "projects_idempotency_check" CHECK (char_length("idempotency_key") BETWEEN 8 AND 200),
  CONSTRAINT "projects_payload_hash_check" CHECK (char_length("payload_hash") BETWEEN 32 AND 128),
  CONSTRAINT "projects_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "projects_default_model_check" CHECK (char_length(btrim("default_model")) BETWEEN 1 AND 240),
  CONSTRAINT "projects_revision_check" CHECK ("revision" >= 1)
);--> statement-breakpoint

CREATE TABLE "project_workspaces" (
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "status" "project_workspace_status" DEFAULT 'queued' NOT NULL,
  "sandbox_name" text NOT NULL,
  "sandbox_id" text,
  "sandbox_domain" text,
  "opencode_password_ciphertext" text,
  "opencode_password_iv" text,
  "opencode_password_auth_tag" text,
  "opencode_password_wrapped_dek" text,
  "opencode_password_wrap_iv" text,
  "opencode_password_wrap_auth_tag" text,
  "opencode_password_key_id" text,
  "checkpoint_id" text,
  "checkpoint_created_at" timestamp with time zone,
  "checkpoint_generation" integer DEFAULT 0 NOT NULL,
  "desired_generation" integer DEFAULT 1 NOT NULL,
  "applied_generation" integer DEFAULT 0 NOT NULL,
  "activation_revision" integer DEFAULT 0 NOT NULL,
  "authority_revision" text,
  "activation_admission_token" uuid,
  "activation_admission_revision" integer,
  "activation_admission_authority_revision" text,
  "activation_admitted_at" timestamp with time zone,
  "environment_exposure_attempted_at" timestamp with time zone,
  "environment_injected_at" timestamp with time zone,
  "recycle_requested_at" timestamp with time zone,
  "recycle_reason" text,
  "skill_sync_error_at" timestamp with time zone,
  "skill_sync_error_code" text,
  "skill_sync_error_message" text,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
  "idle_deadline_at" timestamp with time zone,
  "attempt" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "heartbeat_at" timestamp with time zone,
  "lease_generation" integer DEFAULT 0 NOT NULL,
  "last_error_code" text,
  "last_error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_workspaces_pk" PRIMARY KEY("org_id", "project_id"),
  CONSTRAINT "project_workspaces_sandbox_name_uq" UNIQUE("sandbox_name"),
  CONSTRAINT "project_workspaces_generation_check"
    CHECK (
      "desired_generation" >= 1
      AND "applied_generation" >= 0
      AND "applied_generation" <= "desired_generation"
      AND "checkpoint_generation" >= 0
      AND "checkpoint_generation" <= "desired_generation"
      AND ("checkpoint_id" IS NOT NULL OR "checkpoint_generation" = 0)
    ),
  CONSTRAINT "project_workspaces_activation_check" CHECK ("activation_revision" >= 0),
  CONSTRAINT "project_workspaces_activation_admission_check" CHECK (
    (
      "activation_admission_token" IS NULL
      AND "activation_admission_revision" IS NULL
      AND "activation_admission_authority_revision" IS NULL
      AND "activation_admitted_at" IS NULL
    )
    OR (
      "activation_admission_token" IS NOT NULL
      AND "activation_admission_revision" = "activation_revision" + 1
      AND "activation_admission_authority_revision" IS NOT NULL
      AND "activation_admitted_at" IS NOT NULL
    )
  ),
  CONSTRAINT "project_workspaces_exposure_check"
    CHECK ("environment_injected_at" IS NULL OR "environment_exposure_attempted_at" IS NOT NULL),
  CONSTRAINT "project_workspaces_attempt_check" CHECK ("attempt" >= 0 AND "max_attempts" BETWEEN 1 AND 20),
  CONSTRAINT "project_workspaces_lease_check" CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "project_workspaces_lease_generation_check" CHECK ("lease_generation" >= 0),
  CONSTRAINT "project_workspaces_skill_sync_error_check" CHECK (
    ("skill_sync_error_at" IS NULL) = ("skill_sync_error_code" IS NULL)
    AND ("skill_sync_error_at" IS NULL) = ("skill_sync_error_message" IS NULL)
  ),
  CONSTRAINT "project_workspaces_opencode_password_check" CHECK (
    (
      "opencode_password_ciphertext" IS NULL
      AND "opencode_password_iv" IS NULL
      AND "opencode_password_auth_tag" IS NULL
      AND "opencode_password_wrapped_dek" IS NULL
      AND "opencode_password_wrap_iv" IS NULL
      AND "opencode_password_wrap_auth_tag" IS NULL
      AND "opencode_password_key_id" IS NULL
    ) OR (
      "opencode_password_ciphertext" IS NOT NULL
      AND "opencode_password_iv" IS NOT NULL
      AND "opencode_password_auth_tag" IS NOT NULL
      AND "opencode_password_wrapped_dek" IS NOT NULL
      AND "opencode_password_wrap_iv" IS NOT NULL
      AND "opencode_password_wrap_auth_tag" IS NOT NULL
      AND "opencode_password_key_id" IS NOT NULL
    )
  )
);--> statement-breakpoint

CREATE TABLE "project_worker_heartbeats" (
  "worker_id" text PRIMARY KEY NOT NULL,
  "protocol_version" integer DEFAULT 1 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_worker_heartbeats_worker_id_check"
    CHECK (length(btrim("worker_id")) BETWEEN 1 AND 512),
  CONSTRAINT "project_worker_heartbeats_protocol_check" CHECK ("protocol_version" >= 1)
);--> statement-breakpoint

CREATE TABLE "project_worker_lease_contexts" (
  "backend_pid" integer NOT NULL,
  "transaction_id" text NOT NULL,
  "token" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "worker_id" text NOT NULL,
  "lease_generation" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_worker_lease_contexts_pk" PRIMARY KEY("backend_pid", "transaction_id"),
  CONSTRAINT "project_worker_lease_contexts_token_uq" UNIQUE("token")
);--> statement-breakpoint

CREATE TABLE "project_skills" (
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "skill_id" uuid NOT NULL,
  "desired_version_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_skills_pk" PRIMARY KEY("org_id", "project_id", "skill_id")
);--> statement-breakpoint

CREATE TABLE "project_skill_snapshots" (
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "generation" integer NOT NULL,
  "root_skill_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "skill_version_id" uuid NOT NULL,
  "mount_order" integer NOT NULL,
  "is_root" boolean DEFAULT false NOT NULL,
  "checksum" text NOT NULL,
  "storage_path" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_skill_snapshots_pk"
    PRIMARY KEY("org_id", "project_id", "generation", "root_skill_id", "skill_id"),
  CONSTRAINT "project_skill_snapshots_mount_order_uq"
    UNIQUE("org_id", "project_id", "generation", "root_skill_id", "mount_order"),
  CONSTRAINT "project_skill_snapshots_generation_check" CHECK ("generation" >= 1),
  CONSTRAINT "project_skill_snapshots_mount_order_check" CHECK ("mount_order" >= 0),
  CONSTRAINT "project_skill_snapshots_checksum_check" CHECK (char_length("checksum") BETWEEN 32 AND 128)
);--> statement-breakpoint

CREATE TABLE "project_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "title" text NOT NULL,
  "model" text NOT NULL,
  "model_provider" text NOT NULL,
  "model_credential_env_keys" text[] DEFAULT '{}'::text[] NOT NULL,
  "status" "project_session_status" DEFAULT 'queued' NOT NULL,
  "opencode_session_id" text,
  "stop_requested_at" timestamp with time zone,
  "last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
  "error_code" text,
  "user_message" text,
  "transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "transcript_sequence" integer DEFAULT 0 NOT NULL,
  "transcript_event_sequence" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_sessions_org_project_id_uq" UNIQUE("org_id", "project_id", "id"),
  CONSTRAINT "project_sessions_identity_uq" UNIQUE("org_id", "project_id", "id", "creator_id"),
  CONSTRAINT "project_sessions_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 160),
  CONSTRAINT "project_sessions_model_check" CHECK (char_length(btrim("model")) BETWEEN 1 AND 240),
  CONSTRAINT "project_sessions_model_provider_check"
    CHECK (char_length(btrim("model_provider")) BETWEEN 1 AND 120),
  CONSTRAINT "project_sessions_model_credential_env_keys_check"
    CHECK (
      array_position("model_credential_env_keys", NULL) IS NULL
      AND cardinality("model_credential_env_keys") <= 16
    ),
  CONSTRAINT "project_sessions_transcript_check"
    CHECK (
      jsonb_typeof("transcript") = 'array'
      AND octet_length("transcript"::text) <= 786432
      AND "transcript_sequence" >= 0
      AND "transcript_event_sequence" >= 0
      AND "transcript_event_sequence" <= "transcript_sequence"
    )
);--> statement-breakpoint

CREATE TABLE "project_prompts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "text" text NOT NULL,
  "status" "project_prompt_status" DEFAULT 'queued' NOT NULL,
  "idempotency_key" text NOT NULL,
  "payload_hash" text NOT NULL,
  "usage_activation_revision" integer NOT NULL,
  "usage_reservation_ms" integer NOT NULL,
  "opencode_message_id" text NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "heartbeat_at" timestamp with time zone,
  "send_attempted_at" timestamp with time zone,
  "error_code" text,
  "error_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_prompts_identity_uq" UNIQUE("org_id", "project_id", "session_id", "id", "creator_id"),
  CONSTRAINT "project_prompts_sequence_uq" UNIQUE("org_id", "session_id", "sequence"),
  CONSTRAINT "project_prompts_idempotency_uq" UNIQUE("org_id", "creator_id", "idempotency_key"),
  CONSTRAINT "project_prompts_text_check" CHECK (char_length(btrim("text")) BETWEEN 1 AND 8000),
  CONSTRAINT "project_prompts_sequence_check" CHECK ("sequence" >= 1),
  CONSTRAINT "project_prompts_attempt_check" CHECK ("attempt" >= 0 AND "max_attempts" BETWEEN 1 AND 20),
  CONSTRAINT "project_prompts_lease_check" CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "project_prompts_idempotency_check" CHECK (char_length("idempotency_key") BETWEEN 8 AND 200),
  CONSTRAINT "project_prompts_payload_hash_check" CHECK (char_length("payload_hash") BETWEEN 32 AND 128),
  CONSTRAINT "project_prompts_usage_admission_check"
    CHECK ("usage_activation_revision" >= 1 AND "usage_reservation_ms" >= 0)
);--> statement-breakpoint

CREATE TABLE "project_session_events" (
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "event" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_session_events_pk" PRIMARY KEY("org_id", "session_id", "sequence"),
  CONSTRAINT "project_session_events_sequence_check" CHECK ("sequence" >= 1),
  CONSTRAINT "project_session_events_event_check"
    CHECK (
      jsonb_typeof("event") = 'object'
      AND octet_length("event"::text) <= 65536
    )
);--> statement-breakpoint

CREATE TABLE "project_attachment_uploads" (
  "storage_key" text PRIMARY KEY,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "kind" text DEFAULT 'attachment' NOT NULL,
  "committed_at" timestamp with time zone,
  "delete_requested_at" timestamp with time zone,
  "touched_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_attachment_uploads_kind_check"
    CHECK ("kind" IN ('attachment', 'file'))
);--> statement-breakpoint

CREATE TABLE "project_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "prompt_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "checksum" text NOT NULL,
  "storage_key" text NOT NULL,
  "workspace_path" text NOT NULL,
  "status" "project_attachment_status" DEFAULT 'uploaded' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_attachments_storage_key_uq" UNIQUE("storage_key"),
  CONSTRAINT "project_attachments_file_name_check"
    CHECK (char_length(btrim("file_name")) BETWEEN 1 AND 255 AND "file_name" !~ '[[:cntrl:]/\\]'),
  CONSTRAINT "project_attachments_workspace_path_check"
    CHECK (
      "workspace_path" ~ '^files/[^[:cntrl:]]+$'
      AND "workspace_path" !~ '(^|/)\.\.(/|$)'
      AND lower("workspace_path") !~ '^files/\.(claude|opencode|companion|git)(/|$)'
    ),
  CONSTRAINT "project_attachments_byte_size_check" CHECK ("byte_size" BETWEEN 1 AND 10485760),
  CONSTRAINT "project_attachments_checksum_check" CHECK (char_length("checksum") BETWEEN 32 AND 128)
);--> statement-breakpoint

CREATE TABLE "project_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "path" text NOT NULL,
  "current_version" integer DEFAULT 1 NOT NULL,
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "checksum" text NOT NULL,
  "storage_key" text NOT NULL,
  "modified_by_session_id" uuid,
  "conflict_detected" boolean DEFAULT false NOT NULL,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_files_identity_uq" UNIQUE("org_id", "project_id", "id", "creator_id"),
  CONSTRAINT "project_files_path_uq" UNIQUE("org_id", "project_id", "path"),
  CONSTRAINT "project_files_path_check"
    CHECK (
      "path" ~ '^files/[^[:cntrl:]]+$'
      AND "path" !~ '(^|/)\.\.(/|$)'
      AND lower("path") !~ '^files/\.(claude|opencode|companion|git)(/|$)'
    ),
  CONSTRAINT "project_files_version_check" CHECK ("current_version" >= 1),
  CONSTRAINT "project_files_byte_size_check" CHECK ("byte_size" >= 0),
  CONSTRAINT "project_files_checksum_check" CHECK (char_length("checksum") BETWEEN 32 AND 128)
);--> statement-breakpoint

CREATE TABLE "project_file_versions" (
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "file_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "version" integer NOT NULL,
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "checksum" text NOT NULL,
  "storage_key" text NOT NULL,
  "modified_by_session_id" uuid,
  "base_version" integer,
  "conflict_detected" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_file_versions_pk" PRIMARY KEY("org_id", "file_id", "version"),
  CONSTRAINT "project_file_versions_version_check"
    CHECK ("version" >= 1 AND ("base_version" IS NULL OR "base_version" >= 0))
);--> statement-breakpoint

CREATE TABLE "project_secret_inputs" (
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "activation_revision" integer NOT NULL,
  "env_key" text NOT NULL,
  "secret_id" uuid NOT NULL,
  "secret_version" integer NOT NULL,
  "secret_name_snapshot" text NOT NULL,
  "injected_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_secret_inputs_pk" PRIMARY KEY("org_id", "project_id", "activation_revision", "env_key"),
  CONSTRAINT "project_secret_inputs_activation_check" CHECK ("activation_revision" >= 1),
  CONSTRAINT "project_secret_inputs_key_check"
    CHECK ("env_key" ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND "env_key" !~ '^OPENCODE_SERVER_')
);--> statement-breakpoint

CREATE TABLE "project_model_provider_inputs" (
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "creator_id" text NOT NULL,
  "activation_revision" integer NOT NULL,
  "provider" text NOT NULL,
  "env_key" text NOT NULL,
  "connection_id" uuid NOT NULL,
  "credential_version" integer NOT NULL,
  "connection_scope" "model_provider_connection_scope" NOT NULL,
  "injected_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_model_provider_inputs_pk"
    PRIMARY KEY("org_id", "project_id", "activation_revision", "provider"),
  CONSTRAINT "project_model_inputs_activation_check" CHECK ("activation_revision" >= 1),
  CONSTRAINT "project_model_inputs_version_check" CHECK ("credential_version" >= 1),
  CONSTRAINT "project_model_inputs_key_check"
    CHECK ("env_key" ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND "env_key" !~ '^OPENCODE_SERVER_')
);--> statement-breakpoint

ALTER TABLE "projects" ADD CONSTRAINT "projects_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_creator_fk"
  FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_creator_fk"
  FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_project_creator_fk"
  FOREIGN KEY ("org_id", "project_id", "creator_id")
  REFERENCES "projects"("org_id", "id", "creator_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_skills" ADD CONSTRAINT "project_skills_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_skills" ADD CONSTRAINT "project_skills_creator_fk"
  FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_skills" ADD CONSTRAINT "project_skills_project_creator_fk"
  FOREIGN KEY ("org_id", "project_id", "creator_id")
  REFERENCES "projects"("org_id", "id", "creator_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_skills" ADD CONSTRAINT "project_skills_skill_org_fk"
  FOREIGN KEY ("org_id", "skill_id") REFERENCES "skills"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_skills" ADD CONSTRAINT "project_skills_version_org_fk"
  FOREIGN KEY ("org_id", "skill_id", "desired_version_id")
  REFERENCES "skill_versions"("org_id", "skill_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "project_skill_snapshots" ADD CONSTRAINT "project_skill_snapshots_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_skill_snapshots" ADD CONSTRAINT "project_skill_snapshots_creator_fk"
  FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_skill_snapshots" ADD CONSTRAINT "project_skill_snapshots_project_creator_fk"
  FOREIGN KEY ("org_id", "project_id", "creator_id")
  REFERENCES "projects"("org_id", "id", "creator_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_skill_snapshots" ADD CONSTRAINT "project_skill_snapshots_root_skill_org_fk"
  FOREIGN KEY ("org_id", "root_skill_id") REFERENCES "skills"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_skill_snapshots" ADD CONSTRAINT "project_skill_snapshots_version_org_fk"
  FOREIGN KEY ("org_id", "skill_id", "skill_version_id")
  REFERENCES "skill_versions"("org_id", "skill_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "project_sessions" ADD CONSTRAINT "project_sessions_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_sessions" ADD CONSTRAINT "project_sessions_creator_fk"
  FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_sessions" ADD CONSTRAINT "project_sessions_project_creator_fk"
  FOREIGN KEY ("org_id", "project_id", "creator_id")
  REFERENCES "projects"("org_id", "id", "creator_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_prompts" ADD CONSTRAINT "project_prompts_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_prompts" ADD CONSTRAINT "project_prompts_creator_fk"
  FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_prompts" ADD CONSTRAINT "project_prompts_session_creator_fk"
  FOREIGN KEY ("org_id", "project_id", "session_id", "creator_id")
  REFERENCES "project_sessions"("org_id", "project_id", "id", "creator_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_session_events" ADD CONSTRAINT "project_session_events_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_session_events" ADD CONSTRAINT "project_session_events_creator_fk"
  FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_session_events" ADD CONSTRAINT "project_session_events_session_creator_fk"
  FOREIGN KEY ("org_id", "project_id", "session_id", "creator_id")
  REFERENCES "project_sessions"("org_id", "project_id", "id", "creator_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_creator_fk"
  FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_prompt_creator_fk"
  FOREIGN KEY ("org_id", "project_id", "session_id", "prompt_id", "creator_id")
  REFERENCES "project_prompts"("org_id", "project_id", "session_id", "id", "creator_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_creator_fk"
  FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_creator_fk"
  FOREIGN KEY ("org_id", "project_id", "creator_id")
  REFERENCES "projects"("org_id", "id", "creator_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_modified_by_session_fk"
  FOREIGN KEY ("org_id", "project_id", "modified_by_session_id", "creator_id")
  REFERENCES "project_sessions"("org_id", "project_id", "id", "creator_id")
  ON DELETE SET NULL ("modified_by_session_id");--> statement-breakpoint
ALTER TABLE "project_file_versions" ADD CONSTRAINT "project_file_versions_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_file_versions" ADD CONSTRAINT "project_file_versions_creator_fk"
  FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_file_versions" ADD CONSTRAINT "project_file_versions_file_creator_fk"
  FOREIGN KEY ("org_id", "project_id", "file_id", "creator_id")
  REFERENCES "project_files"("org_id", "project_id", "id", "creator_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_file_versions" ADD CONSTRAINT "project_file_versions_modified_by_session_fk"
  FOREIGN KEY ("org_id", "project_id", "modified_by_session_id", "creator_id")
  REFERENCES "project_sessions"("org_id", "project_id", "id", "creator_id")
  ON DELETE SET NULL ("modified_by_session_id");--> statement-breakpoint
ALTER TABLE "project_secret_inputs" ADD CONSTRAINT "project_secret_inputs_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_secret_inputs" ADD CONSTRAINT "project_secret_inputs_creator_fk"
  FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_secret_inputs" ADD CONSTRAINT "project_secret_inputs_project_creator_fk"
  FOREIGN KEY ("org_id", "project_id", "creator_id")
  REFERENCES "projects"("org_id", "id", "creator_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_secret_inputs" ADD CONSTRAINT "project_secret_inputs_secret_version_org_fk"
  FOREIGN KEY ("org_id", "secret_id", "secret_version")
  REFERENCES "secret_versions"("org_id", "secret_id", "version") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "project_model_provider_inputs" ADD CONSTRAINT "project_model_inputs_org_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_model_provider_inputs" ADD CONSTRAINT "project_model_inputs_creator_fk"
  FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "project_model_provider_inputs" ADD CONSTRAINT "project_model_inputs_project_creator_fk"
  FOREIGN KEY ("org_id", "project_id", "creator_id")
  REFERENCES "projects"("org_id", "id", "creator_id") ON DELETE cascade;--> statement-breakpoint

CREATE INDEX "projects_creator_idx" ON "projects" ("org_id", "creator_id", "updated_at" DESC);--> statement-breakpoint
CREATE INDEX "project_worker_heartbeats_expiry_idx" ON "project_worker_heartbeats" ("expires_at");--> statement-breakpoint
CREATE INDEX "project_worker_lease_contexts_created_idx" ON "project_worker_lease_contexts" ("created_at");--> statement-breakpoint
CREATE INDEX "project_workspaces_claim_idx" ON "project_workspaces" ("status", "available_at", "lease_expires_at");--> statement-breakpoint
CREATE INDEX "project_workspaces_idle_idx" ON "project_workspaces" ("status", "idle_deadline_at");--> statement-breakpoint
CREATE INDEX "project_skills_skill_idx" ON "project_skills" ("org_id", "skill_id");--> statement-breakpoint
CREATE INDEX "project_sessions_project_idx" ON "project_sessions" ("org_id", "project_id", "updated_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "project_sessions_opencode_session_uq"
  ON "project_sessions" ("org_id", "project_id", "opencode_session_id")
  WHERE "opencode_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "project_prompts_claim_idx" ON "project_prompts" ("status", "available_at", "lease_expires_at");--> statement-breakpoint
ALTER TABLE "project_prompts"
  ADD CONSTRAINT "project_prompts_opencode_message_uq"
  UNIQUE ("org_id", "opencode_message_id");--> statement-breakpoint
CREATE INDEX "project_session_events_session_idx" ON "project_session_events" ("org_id", "session_id", "sequence");--> statement-breakpoint
CREATE INDEX "project_attachment_uploads_age_idx" ON "project_attachment_uploads" ("touched_at");--> statement-breakpoint
CREATE INDEX "project_attachment_uploads_project_idx"
  ON "project_attachment_uploads" ("org_id", "project_id", "creator_id");--> statement-breakpoint
CREATE INDEX "project_attachments_prompt_idx" ON "project_attachments" ("org_id", "prompt_id");--> statement-breakpoint
CREATE INDEX "project_files_project_idx" ON "project_files" ("org_id", "project_id", "updated_at" DESC);--> statement-breakpoint
CREATE INDEX "project_file_versions_project_idx" ON "project_file_versions" ("org_id", "project_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "project_file_versions_storage_key_idx" ON "project_file_versions" ("storage_key");--> statement-breakpoint

-- GUCs are caller-settable and are never authority by themselves. Internal modes are accepted only
-- while a narrow SECURITY DEFINER function is executing as the migration/table owner.
CREATE FUNCTION companion_project_policy_definer() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT current_user = pg_get_userbyid(
    (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.projects'::regclass)
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_project_policy_definer() FROM PUBLIC;--> statement-breakpoint

-- Exact worker authority persists for one transaction after lease admission. The opaque proof is
-- stored server-side so setting the visible tuple GUCs cannot manufacture access.
CREATE FUNCTION companion_project_exact_lease_visible(
  p_org_id uuid,
  p_project_id uuid,
  p_creator_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT current_setting('app.project_worker', true) = 'exact_lease'
    AND p_org_id = NULLIF(current_setting('app.project_worker_org_id', true), '')::uuid
    AND p_project_id = NULLIF(current_setting('app.project_worker_project_id', true), '')::uuid
    AND p_creator_id = NULLIF(current_setting('app.project_worker_creator_id', true), '')
    AND EXISTS (
      SELECT 1
      FROM public."project_worker_lease_contexts" context
      WHERE context."backend_pid" = pg_backend_pid()
        AND context."transaction_id" = txid_current()::text
        AND context."token" =
          NULLIF(current_setting('app.project_worker_context_token', true), '')::uuid
        AND context."org_id" = p_org_id
        AND context."project_id" = p_project_id
        AND context."creator_id" = p_creator_id
        AND context."worker_id" =
          NULLIF(current_setting('app.project_worker_id', true), '')
        AND context."lease_generation" =
          NULLIF(current_setting('app.project_worker_lease_generation', true), '')::integer
    )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_project_exact_lease_visible(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_project_row_visible(p_org_id uuid, p_project_id uuid, p_creator_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT (
    coalesce(current_setting('app.project_worker', true), '') <> 'exact_lease'
    AND p_org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND p_creator_id = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM public."memberships" m
      WHERE m."org_id" = p_org_id AND m."user_id" = p_creator_id
    )
  )
  OR companion_project_exact_lease_visible(p_org_id, p_project_id, p_creator_id)
  OR (
    companion_project_policy_definer()
    AND current_setting('app.project_worker', true) IN (
      'claim',
      'enter_lease',
      'skill_refresh',
      'secret_signal',
      'provider_signal',
      'member_cleanup',
      'usage_aggregate',
      'attachment_orphan'
    )
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_project_row_visible(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint

ALTER TABLE "project_worker_lease_contexts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_skill_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_prompts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_session_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_attachment_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_file_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_secret_inputs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_model_provider_inputs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_worker_lease_contexts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_workspaces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_skills" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_skill_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_prompts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_session_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_attachment_uploads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_attachments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_file_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_secret_inputs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_model_provider_inputs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "project_worker_lease_contexts_internal" ON "project_worker_lease_contexts"
  USING (
    companion_project_policy_definer()
    AND current_setting('app.project_worker', true) IN ('enter_lease', 'exact_lease')
  )
  WITH CHECK (
    companion_project_policy_definer()
    AND current_setting('app.project_worker', true) IN ('enter_lease', 'exact_lease')
  );--> statement-breakpoint
CREATE POLICY "projects_creator_or_worker" ON "projects"
  USING (companion_project_row_visible("org_id", "id", "creator_id"))
  WITH CHECK (companion_project_row_visible("org_id", "id", "creator_id"));--> statement-breakpoint
CREATE POLICY "project_workspaces_creator_or_worker" ON "project_workspaces"
  USING (companion_project_row_visible("org_id", "project_id", "creator_id"))
  WITH CHECK (companion_project_row_visible("org_id", "project_id", "creator_id"));--> statement-breakpoint
CREATE POLICY "project_skills_creator_or_worker" ON "project_skills"
  USING (companion_project_row_visible("org_id", "project_id", "creator_id"))
  WITH CHECK (
    companion_project_row_visible("org_id", "project_id", "creator_id")
    AND (
      current_setting('app.project_worker', true) = 'exact_lease'
      OR EXISTS (
        SELECT 1 FROM "skills" s
        WHERE s."org_id" = "project_skills"."org_id"
          AND s."id" = "project_skills"."skill_id"
          AND s."archived_at" IS NULL
          AND (s."scope" = 'org' OR s."creator_id" = "project_skills"."creator_id")
      )
    )
  );--> statement-breakpoint
CREATE POLICY "project_skill_snapshots_creator_or_worker" ON "project_skill_snapshots"
  USING (companion_project_row_visible("org_id", "project_id", "creator_id"))
  WITH CHECK (companion_project_row_visible("org_id", "project_id", "creator_id"));--> statement-breakpoint
CREATE POLICY "project_sessions_creator_or_worker" ON "project_sessions"
  USING (companion_project_row_visible("org_id", "project_id", "creator_id"))
  WITH CHECK (companion_project_row_visible("org_id", "project_id", "creator_id"));--> statement-breakpoint
CREATE POLICY "project_prompts_creator_or_worker" ON "project_prompts"
  USING (companion_project_row_visible("org_id", "project_id", "creator_id"))
  WITH CHECK (companion_project_row_visible("org_id", "project_id", "creator_id"));--> statement-breakpoint
CREATE POLICY "project_session_events_creator_or_worker" ON "project_session_events"
  USING (companion_project_row_visible("org_id", "project_id", "creator_id"))
  WITH CHECK (companion_project_row_visible("org_id", "project_id", "creator_id"));--> statement-breakpoint
CREATE POLICY "project_attachment_uploads_creator_or_worker" ON "project_attachment_uploads"
  USING (companion_project_row_visible("org_id", "project_id", "creator_id"))
  WITH CHECK (companion_project_row_visible("org_id", "project_id", "creator_id"));--> statement-breakpoint
CREATE POLICY "project_attachments_creator_or_worker" ON "project_attachments"
  USING (companion_project_row_visible("org_id", "project_id", "creator_id"))
  WITH CHECK (companion_project_row_visible("org_id", "project_id", "creator_id"));--> statement-breakpoint
CREATE POLICY "project_files_creator_or_worker" ON "project_files"
  USING (companion_project_row_visible("org_id", "project_id", "creator_id"))
  WITH CHECK (companion_project_row_visible("org_id", "project_id", "creator_id"));--> statement-breakpoint
CREATE POLICY "project_file_versions_creator_or_worker" ON "project_file_versions"
  USING (companion_project_row_visible("org_id", "project_id", "creator_id"))
  WITH CHECK (companion_project_row_visible("org_id", "project_id", "creator_id"));--> statement-breakpoint
CREATE POLICY "project_secret_inputs_creator_or_worker" ON "project_secret_inputs"
  USING (companion_project_row_visible("org_id", "project_id", "creator_id"))
  WITH CHECK (companion_project_row_visible("org_id", "project_id", "creator_id"));--> statement-breakpoint
CREATE POLICY "project_model_inputs_creator_or_worker" ON "project_model_provider_inputs"
  USING (companion_project_row_visible("org_id", "project_id", "creator_id"))
  WITH CHECK (companion_project_row_visible("org_id", "project_id", "creator_id"));--> statement-breakpoint

CREATE FUNCTION companion_lock_project_attachment_orphan(
  p_storage_key text,
  p_before timestamp with time zone
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate text;
  previous_worker_context text := current_setting('app.project_worker', true);
BEGIN
  PERFORM set_config('app.project_worker', 'attachment_orphan', true);
  SELECT upload."storage_key" INTO candidate
  FROM public."project_attachment_uploads" upload
  WHERE upload."storage_key" = p_storage_key
    AND upload."touched_at" < p_before
    AND (
      upload."committed_at" IS NULL
      OR upload."delete_requested_at" IS NOT NULL
    )
  FOR UPDATE;
  IF candidate IS NULL THEN
    PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
    RETURN false;
  END IF;
  IF (
    SELECT upload."delete_requested_at" IS NULL
    FROM public."project_attachment_uploads" upload
    WHERE upload."storage_key" = p_storage_key
  ) AND (
    EXISTS (
      SELECT 1 FROM public."project_attachments" attachment
      WHERE attachment."storage_key" = p_storage_key
    )
    OR EXISTS (
      SELECT 1 FROM public."project_files" file
      WHERE file."storage_key" = p_storage_key
    )
    OR EXISTS (
      SELECT 1 FROM public."project_file_versions" version
      WHERE version."storage_key" = p_storage_key
    )
  ) THEN
    UPDATE public."project_attachment_uploads"
    SET "committed_at" = COALESCE("committed_at", clock_timestamp()),
        "touched_at" = clock_timestamp()
    WHERE "storage_key" = p_storage_key;
    PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
    RETURN false;
  END IF;
  PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
  RETURN true;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_lock_project_attachment_orphan(text, timestamp with time zone) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_complete_project_attachment_orphan(p_storage_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_worker_context text := current_setting('app.project_worker', true);
BEGIN
  PERFORM set_config('app.project_worker', 'attachment_orphan', true);
  DELETE FROM public."project_attachment_uploads" WHERE "storage_key" = p_storage_key;
  PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_complete_project_attachment_orphan(text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_defer_project_attachment_orphan(
  p_storage_key text,
  p_before timestamp with time zone
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deferred boolean;
  previous_worker_context text := current_setting('app.project_worker', true);
BEGIN
  PERFORM set_config('app.project_worker', 'attachment_orphan', true);
  WITH updated AS (
    UPDATE public."project_attachment_uploads" upload
    SET "touched_at" = clock_timestamp()
    WHERE upload."storage_key" = p_storage_key
      AND upload."touched_at" < p_before
      AND (
        upload."committed_at" IS NULL
        OR upload."delete_requested_at" IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM public."project_attachments" attachment
        WHERE attachment."storage_key" = p_storage_key
          AND upload."delete_requested_at" IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM public."project_files" file
        WHERE file."storage_key" = p_storage_key
          AND upload."delete_requested_at" IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM public."project_file_versions" version
        WHERE version."storage_key" = p_storage_key
          AND upload."delete_requested_at" IS NULL
      )
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated) INTO deferred;
  PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
  RETURN deferred;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_defer_project_attachment_orphan(text, timestamp with time zone) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_list_project_attachment_orphans(
  p_before timestamp with time zone,
  p_limit integer
)
RETURNS TABLE (storage_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_worker_context text := current_setting('app.project_worker', true);
BEGIN
  PERFORM set_config('app.project_worker', 'attachment_orphan', true);
  RETURN QUERY
  SELECT upload."storage_key"
  FROM public."project_attachment_uploads" upload
  WHERE upload."touched_at" < p_before
    AND (
      upload."committed_at" IS NULL
      OR upload."delete_requested_at" IS NOT NULL
    )
  ORDER BY upload."touched_at", upload."storage_key"
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
  PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_list_project_attachment_orphans(timestamp with time zone, integer) FROM PUBLIC;--> statement-breakpoint

-- Legacy run/prewarm usage remains organization-visible. Project usage carries a private Project id,
-- creator identity and sandbox lifecycle metadata, so only that Project creator may see or mutate
-- the raw row. Shared billing reads use the aggregate-only SECURITY DEFINER function below.
DROP POLICY "sandbox_usage_sessions_tenant_rls" ON "sandbox_usage_sessions";--> statement-breakpoint
CREATE POLICY "sandbox_usage_sessions_tenant_or_project_creator_rls"
ON "sandbox_usage_sessions"
USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND (
    "kind"::text <> 'project'
    OR (
      (
        "creator_id" = NULLIF(current_setting('app.user_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public."memberships" membership
          WHERE membership."org_id" = "sandbox_usage_sessions"."org_id"
            AND membership."user_id" = "sandbox_usage_sessions"."creator_id"
        )
        AND EXISTS (
          SELECT 1
          FROM public."projects" project
          WHERE project."org_id" = "sandbox_usage_sessions"."org_id"
            AND project."id" = "sandbox_usage_sessions"."source_id"
            AND project."creator_id" = "sandbox_usage_sessions"."creator_id"
        )
      )
      OR (
        current_setting('app.project_worker', true) = 'exact_lease'
        AND companion_project_row_visible(
          "org_id",
          "source_id",
          "creator_id"
        )
      )
      OR (
        companion_project_policy_definer()
        AND current_setting('app.project_worker', true) = 'usage_aggregate'
      )
    )
  )
)
WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND (
    "kind"::text <> 'project'
    OR (
      (
        "creator_id" = NULLIF(current_setting('app.user_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public."memberships" membership
          WHERE membership."org_id" = "sandbox_usage_sessions"."org_id"
            AND membership."user_id" = "sandbox_usage_sessions"."creator_id"
        )
        AND EXISTS (
          SELECT 1
          FROM public."projects" project
          WHERE project."org_id" = "sandbox_usage_sessions"."org_id"
            AND project."id" = "sandbox_usage_sessions"."source_id"
            AND project."creator_id" = "sandbox_usage_sessions"."creator_id"
        )
      )
      OR (
        current_setting('app.project_worker', true) = 'exact_lease'
        AND companion_project_row_visible(
          "org_id",
          "source_id",
          "creator_id"
        )
      )
      OR (
        companion_project_policy_definer()
        AND current_setting('app.project_worker', true) = 'usage_aggregate'
      )
    )
  )
);--> statement-breakpoint

CREATE FUNCTION companion_sandbox_usage_totals(
  p_org_id uuid,
  p_period_start timestamp with time zone,
  p_period_end timestamp with time zone,
  p_now timestamp with time zone
)
RETURNS TABLE ("used_ms" bigint, "reserved_ms" bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id text := NULLIF(current_setting('app.user_id', true), '');
  tenant_id uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  previous_worker_context text := current_setting('app.project_worker', true);
BEGIN
  IF tenant_id IS DISTINCT FROM p_org_id
    OR actor_id IS NULL
    OR p_period_start IS NULL
    OR p_period_end IS NULL
    OR p_now IS NULL
    OR p_period_end <= p_period_start
  THEN
    RAISE EXCEPTION 'sandbox usage aggregate context is invalid' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public."memberships" membership
    WHERE membership."org_id" = p_org_id
      AND membership."user_id" = actor_id
  ) THEN
    RAISE EXCEPTION 'sandbox usage aggregate requires membership' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.project_worker', 'usage_aggregate', true);
  RETURN QUERY
  SELECT
    COALESCE(SUM(
      CASE
        WHEN usage."settled_ms" IS NOT NULL THEN usage."settled_ms"::bigint
        ELSE 0::bigint
      END
    ), 0::numeric)::bigint AS "used_ms",
    COALESCE(SUM(
      CASE
        WHEN usage."settled_ms" IS NOT NULL THEN 0::bigint
        WHEN usage."started_at" IS NOT NULL THEN GREATEST(
          usage."reserved_ms"::bigint,
          (
            GREATEST(
              0::numeric,
              CEIL(EXTRACT(EPOCH FROM (p_now - usage."started_at")) * 1000 / 60000)
            ) * 60000
          )::bigint
        )
        WHEN usage."reservation_expires_at" > p_now THEN usage."reserved_ms"::bigint
        ELSE 0::bigint
      END
    ), 0::numeric)::bigint AS "reserved_ms"
  FROM public."sandbox_usage_sessions" usage
  WHERE usage."org_id" = p_org_id
    AND usage."period_start" >= p_period_start
    AND usage."period_start" < p_period_end;
  PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_sandbox_usage_totals(
  uuid,
  timestamp with time zone,
  timestamp with time zone,
  timestamp with time zone
) FROM PUBLIC;--> statement-breakpoint

-- Removing an organization member must not strand their private Project runtimes. This narrow
-- metadata-only RPC lets an authorized organization manager request deletion without granting them
-- visibility into any Project row, session, transcript, file, secret pin, or checkpoint identifier.
-- The worker subsequently claims every marked workspace (including stopped/needs-attention ones) and
-- performs provider + object-store cleanup before deleting the database graph.
CREATE FUNCTION companion_request_member_project_deletion(
  p_org_id uuid,
  p_user_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id text := NULLIF(current_setting('app.user_id', true), '');
  tenant_id uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  requested_count integer := 0;
  previous_worker_context text := current_setting('app.project_worker', true);
BEGIN
  IF p_org_id IS NULL OR p_user_id IS NULL OR btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'organization and member are required' USING ERRCODE = '22023';
  END IF;
  IF tenant_id IS DISTINCT FROM p_org_id OR actor_id IS NULL THEN
    RAISE EXCEPTION 'project cleanup tenant context is invalid' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public."memberships" actor_membership
    WHERE actor_membership."org_id" = p_org_id
      AND actor_membership."user_id" = actor_id
      AND actor_membership."org_role" IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'project cleanup requires an organization manager' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public."memberships" target_membership
    WHERE target_membership."org_id" = p_org_id
      AND target_membership."user_id" = p_user_id
  ) THEN
    RAISE EXCEPTION 'member not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('app.project_worker', 'member_cleanup', true);
  UPDATE public."projects" project
  SET "delete_requested_at" = COALESCE(project."delete_requested_at", clock_timestamp()),
      "revision" = project."revision" + 1,
      "updated_at" = clock_timestamp()
  WHERE project."org_id" = p_org_id
    AND project."creator_id" = p_user_id
    AND project."delete_requested_at" IS NULL;
  GET DIAGNOSTICS requested_count = ROW_COUNT;

  UPDATE public."project_workspaces" workspace
  SET "status" = CASE
        WHEN workspace."status" = 'deleted' THEN workspace."status"
        ELSE 'deleting'::public."project_workspace_status"
      END,
      "available_at" = clock_timestamp(),
      "idle_deadline_at" = NULL,
      "updated_at" = clock_timestamp()
  WHERE workspace."org_id" = p_org_id
    AND workspace."creator_id" = p_user_id
    AND EXISTS (
      SELECT 1
      FROM public."projects" project
      WHERE project."org_id" = workspace."org_id"
        AND project."id" = workspace."project_id"
        AND project."creator_id" = workspace."creator_id"
        AND project."delete_requested_at" IS NOT NULL
    );

  PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
  RETURN requested_count;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_request_member_project_deletion(uuid, text) FROM PUBLIC;--> statement-breakpoint

-- Discover only the private Project identities whose current desired skill closure contains a newly
-- published skill. Core re-enters each creator context to rebuild the full closure atomically; this
-- function never exposes Project names, sessions, transcripts, files, credentials, or runtime ids.
CREATE FUNCTION companion_project_skill_refresh_targets(
  p_org_id uuid,
  p_skill_id uuid
)
RETURNS TABLE (
  "project_id" uuid,
  "creator_id" text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id text := NULLIF(current_setting('app.user_id', true), '');
  tenant_id uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  target_scope public."skill_scope";
  target_creator text;
  previous_worker_context text := current_setting('app.project_worker', true);
BEGIN
  IF tenant_id IS DISTINCT FROM p_org_id OR actor_id IS NULL THEN
    RAISE EXCEPTION 'project skill refresh tenant context is invalid' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public."memberships" membership
    WHERE membership."org_id" = p_org_id
      AND membership."user_id" = actor_id
  ) THEN
    RAISE EXCEPTION 'project skill refresh requires membership' USING ERRCODE = '42501';
  END IF;
  SELECT skill."scope", skill."creator_id"
  INTO target_scope, target_creator
  FROM public."skills" skill
  WHERE skill."org_id" = p_org_id AND skill."id" = p_skill_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'skill not found' USING ERRCODE = 'P0002';
  END IF;
  IF target_scope = 'personal' AND target_creator IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'skill not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('app.project_worker', 'skill_refresh', true);
  RETURN QUERY
  SELECT DISTINCT project."id", project."creator_id"
  FROM public."projects" project
  JOIN public."project_workspaces" workspace
    ON workspace."org_id" = project."org_id"
    AND workspace."project_id" = project."id"
    AND workspace."creator_id" = project."creator_id"
  WHERE project."org_id" = p_org_id
    AND project."delete_requested_at" IS NULL
    AND EXISTS (
      SELECT 1
      FROM public."memberships" creator_membership
      WHERE creator_membership."org_id" = project."org_id"
        AND creator_membership."user_id" = project."creator_id"
    )
    AND (
      EXISTS (
        SELECT 1
        FROM public."project_skills" root
        WHERE root."org_id" = project."org_id"
          AND root."project_id" = project."id"
          AND root."creator_id" = project."creator_id"
          AND root."skill_id" = p_skill_id
      )
      OR EXISTS (
        SELECT 1
        FROM public."project_skill_snapshots" snapshot
        WHERE snapshot."org_id" = project."org_id"
          AND snapshot."project_id" = project."id"
          AND snapshot."creator_id" = project."creator_id"
          AND snapshot."generation" = workspace."desired_generation"
          AND snapshot."skill_id" = p_skill_id
      )
    )
  ORDER BY project."id";
  PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_project_skill_refresh_targets(uuid, uuid) FROM PUBLIC;--> statement-breakpoint

-- Keep the database-side Project wake-up classifier aligned with
-- buildProjectAuthorityInputs(). Generic vault rows carrying control-plane credentials are not
-- projected into Cowork at all. OPENCODE_SERVER_* is the one exception: its presence deliberately
-- makes admission invalid because silently dropping it could hide an attempted server-auth
-- override.
CREATE FUNCTION companion_project_control_plane_env_key(p_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT
    upper(btrim(COALESCE(p_key, ''))) = ANY (ARRAY[
      'DATABASE_URL',
      'DIRECT_URL',
      'PGPASSWORD',
      'BETTER_AUTH_SECRET',
      'AUTH_SECRET',
      'SESSION_SECRET',
      'COOKIE_SECRET',
      'VERCEL_TOKEN',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'RESEND_API_KEY'
    ]::text[])
    OR EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        'OPENCODE_SERVER_',
        'COMPANION_',
        'PAT_',
        'BETTER_AUTH_',
        'AUTH_',
        'SESSION_',
        'COOKIE_',
        'VERCEL_',
        'MINIO_',
        'S3_',
        'POSTGRES_',
        'AGENT_AUTH_',
        'OAUTH_',
        'GITHUB_APP_',
        'GITHUB_CLIENT_',
        'STRIPE_',
        'GOOGLE_CLIENT_',
        'RESEND_',
        'EMAIL_'
      ]::text[]) prefix(value)
      WHERE starts_with(upper(btrim(COALESCE(p_key, ''))), prefix.value)
    )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_project_control_plane_env_key(text) FROM PUBLIC;--> statement-breakpoint

-- Recompute the structural Project environment without opening any credential. The optional
-- connection exclusion models a disconnect signal, which must run before the credential row is
-- deleted so already-admitted runtimes can still be fenced.
CREATE FUNCTION companion_project_environment_is_valid(
  p_org_id uuid,
  p_creator_id text,
  p_excluded_connection_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH accessible_secrets AS (
    SELECT secret."id", secret."key"
    FROM public."secrets" secret
    WHERE secret."org_id" = p_org_id
      AND secret."disabled_at" IS NULL
      AND secret."deleted_at" IS NULL
      AND (
        secret."owner_id" = p_creator_id
        OR secret."audience" = 'organization'
        OR (
          secret."audience" = 'restricted'
          AND EXISTS (
            SELECT 1
            FROM public."secret_recipients" recipient
            WHERE recipient."org_id" = secret."org_id"
              AND recipient."secret_id" = secret."id"
              AND recipient."user_id" = p_creator_id
          )
        )
      )
  ),
  projected_secrets AS (
    SELECT secret."id", secret."key"
    FROM accessible_secrets secret
    WHERE NOT companion_project_control_plane_env_key(secret."key")
  ),
  effective_connections AS (
    SELECT DISTINCT ON (connection."provider")
      connection."id",
      connection."provider",
      connection."key_name"
    FROM public."model_provider_connections" connection
    WHERE connection."org_id" = p_org_id
      AND connection."id" IS DISTINCT FROM p_excluded_connection_id
      AND (
        connection."scope" = 'organization'
        OR (
          connection."scope" = 'personal'
          AND connection."user_id" = p_creator_id
        )
      )
    ORDER BY
      connection."provider",
      CASE WHEN connection."scope" = 'personal' THEN 0 ELSE 1 END,
      connection."id"
  ),
  projected_keys AS (
    SELECT secret."key" AS env_key FROM projected_secrets secret
    UNION ALL
    SELECT connection."key_name" AS env_key FROM effective_connections connection
  )
  SELECT NOT (
    EXISTS (
      SELECT 1
      FROM accessible_secrets secret
      WHERE starts_with(upper(btrim(secret."key")), 'OPENCODE_SERVER_')
    )
    OR (SELECT count(*) FROM projected_secrets) > 128
    OR EXISTS (
      SELECT 1
      FROM effective_connections connection
      WHERE companion_project_control_plane_env_key(connection."key_name")
    )
    OR EXISTS (
      SELECT 1
      FROM projected_keys
      GROUP BY env_key
      HAVING count(*) > 1
    )
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_project_environment_is_valid(uuid, text, uuid) FROM PUBLIC;--> statement-breakpoint

-- Wake lease-free warm Projects when a generic secret changes. Immediate mode targets only
-- activations that actually injected a source which is now inaccessible; boundary mode targets
-- Projects that can currently access the secret (create, rotation, key/ACL additions).
CREATE FUNCTION companion_signal_project_secret_change(
  p_org_id uuid,
  p_secret_id uuid,
  p_mode text,
  p_change_kind text DEFAULT 'projection',
  p_previous_key text DEFAULT NULL,
  p_previous_audience public."secret_audience" DEFAULT NULL,
  p_previous_recipients text[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id text := NULLIF(current_setting('app.user_id', true), '');
  tenant_id uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  secret_owner text;
  secret_key text;
  secret_audience public."secret_audience";
  changed_count integer := 0;
  previous_worker_context text := current_setting('app.project_worker', true);
BEGIN
  IF p_mode NOT IN ('boundary', 'immediate') THEN
    RAISE EXCEPTION 'invalid Project secret change mode' USING ERRCODE = '22023';
  END IF;
  IF p_change_kind NOT IN ('projection', 'create', 'rotate', 'key_acl', 'delete', 'disable') THEN
    RAISE EXCEPTION 'invalid Project secret change kind' USING ERRCODE = '22023';
  END IF;
  IF tenant_id IS DISTINCT FROM p_org_id OR actor_id IS NULL THEN
    RAISE EXCEPTION 'Project secret change tenant context is invalid' USING ERRCODE = '42501';
  END IF;
  SELECT secret."owner_id", secret."key", secret."audience"
  INTO secret_owner, secret_key, secret_audience
  FROM public."secrets" secret
  WHERE secret."org_id" = p_org_id AND secret."id" = p_secret_id;
  IF NOT FOUND OR NOT (
    secret_owner = actor_id
    OR (
      secret_owner = NULLIF(current_setting('app.departing_user_id', true), '')
      AND EXISTS (
        SELECT 1 FROM public."memberships" manager
        WHERE manager."org_id" = p_org_id
          AND manager."user_id" = actor_id
          AND manager."org_role" IN ('owner', 'admin')
      )
    )
  ) THEN
    RAISE EXCEPTION 'secret not found' USING ERRCODE = 'P0002';
  END IF;

  -- A generic vault row in a control-plane namespace never enters a Project projection and
  -- therefore cannot change one. OPENCODE_SERVER_* remains relevant because its presence is an
  -- explicit admission error rather than a silently excluded credential.
  IF companion_project_control_plane_env_key(secret_key)
    AND NOT starts_with(upper(btrim(secret_key)), 'OPENCODE_SERVER_')
    AND (
      p_previous_key IS NULL
      OR (
        companion_project_control_plane_env_key(p_previous_key)
        AND NOT starts_with(upper(btrim(p_previous_key)), 'OPENCODE_SERVER_')
      )
    )
  THEN
    RETURN 0;
  END IF;

  PERFORM set_config('app.project_worker', 'secret_signal', true);
  UPDATE public."project_workspaces" workspace
  SET "status" = CASE
        WHEN workspace."status" = 'error'
          AND workspace."last_error_code" = 'project_environment_invalid'
          AND workspace."environment_exposure_attempted_at" IS NULL
        THEN 'queued'::public."project_workspace_status"
        ELSE workspace."status"
      END,
      "recycle_requested_at" = CASE
        WHEN workspace."status" = 'error'
          AND workspace."last_error_code" = 'project_environment_invalid'
          AND workspace."environment_exposure_attempted_at" IS NULL
        THEN NULL
        ELSE COALESCE(workspace."recycle_requested_at", clock_timestamp())
      END,
      "recycle_reason" = CASE
        WHEN workspace."status" = 'error'
          AND workspace."last_error_code" = 'project_environment_invalid'
          AND workspace."environment_exposure_attempted_at" IS NULL
        THEN NULL
        WHEN p_mode = 'immediate' THEN 'immediate:secrets_changed'
        WHEN workspace."recycle_reason" LIKE 'immediate:%' THEN workspace."recycle_reason"
        ELSE 'boundary:secrets_changed'
      END,
      "last_error_code" = CASE
        WHEN workspace."status" = 'error'
          AND workspace."last_error_code" = 'project_environment_invalid'
          AND workspace."environment_exposure_attempted_at" IS NULL
        THEN NULL
        ELSE workspace."last_error_code"
      END,
      "last_error_message" = CASE
        WHEN workspace."status" = 'error'
          AND workspace."last_error_code" = 'project_environment_invalid'
          AND workspace."environment_exposure_attempted_at" IS NULL
        THEN NULL
        ELSE workspace."last_error_message"
      END,
      "available_at" = clock_timestamp(),
      "updated_at" = clock_timestamp()
  WHERE workspace."org_id" = p_org_id
    AND (
      (
        workspace."environment_exposure_attempted_at" IS NOT NULL
        AND workspace."status" NOT IN ('stopped', 'deleted')
      )
      OR (
        workspace."activation_admission_token" IS NOT NULL
        AND workspace."status" <> 'deleted'
      )
      OR (
        workspace."status" = 'provisioning'
        AND workspace."environment_exposure_attempted_at" IS NULL
        AND workspace."activation_revision" > 0
      )
      OR (
        workspace."environment_exposure_attempted_at" IS NULL
        AND workspace."status" <> 'deleted'
        AND EXISTS (
          SELECT 1
          FROM public."project_secret_inputs" admitted_pin
          WHERE admitted_pin."org_id" = workspace."org_id"
            AND admitted_pin."project_id" = workspace."project_id"
            AND admitted_pin."creator_id" = workspace."creator_id"
            AND admitted_pin."activation_revision" = workspace."activation_revision"
            AND admitted_pin."injected_at" IS NULL
        )
      )
      OR (
        workspace."status" = 'error'
        AND workspace."last_error_code" = 'project_environment_invalid'
        AND workspace."environment_exposure_attempted_at" IS NULL
      )
    )
    AND EXISTS (
      SELECT 1
      FROM public."memberships" membership
      WHERE membership."org_id" = workspace."org_id"
        AND membership."user_id" = workspace."creator_id"
    )
    AND EXISTS (
      SELECT 1
      FROM public."projects" project
      WHERE project."org_id" = workspace."org_id"
        AND project."id" = workspace."project_id"
        AND project."creator_id" = workspace."creator_id"
        AND project."delete_requested_at" IS NULL
    )
    AND (
      (
        p_mode = 'immediate'
        AND NOT (
          workspace."status" = 'error'
          AND workspace."last_error_code" = 'project_environment_invalid'
          AND workspace."environment_exposure_attempted_at" IS NULL
        )
        AND (
          (
            EXISTS (
              SELECT 1
              FROM public."project_secret_inputs" pin
              WHERE pin."org_id" = workspace."org_id"
                AND pin."project_id" = workspace."project_id"
                AND pin."creator_id" = workspace."creator_id"
                AND pin."activation_revision" = workspace."activation_revision"
                AND pin."secret_id" = p_secret_id
                AND pin."injected_at" IS NULL
            )
          )
          OR (
            EXISTS (
              SELECT 1
              FROM public."project_secret_inputs" pin
              WHERE pin."org_id" = workspace."org_id"
                AND pin."project_id" = workspace."project_id"
                AND pin."creator_id" = workspace."creator_id"
                AND pin."activation_revision" = workspace."activation_revision"
                AND pin."secret_id" = p_secret_id
                AND pin."injected_at" IS NOT NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public."secrets" secret
              WHERE secret."org_id" = p_org_id
                AND secret."id" = p_secret_id
                AND secret."disabled_at" IS NULL
                AND secret."deleted_at" IS NULL
                AND (
                  secret."owner_id" = workspace."creator_id"
                  OR secret."audience" = 'organization'
                  OR (
                    secret."audience" = 'restricted'
                    AND EXISTS (
                      SELECT 1
                      FROM public."secret_recipients" recipient
                      WHERE recipient."org_id" = secret."org_id"
                        AND recipient."secret_id" = secret."id"
                        AND recipient."user_id" = workspace."creator_id"
                    )
                  )
                )
            )
          )
          OR (
            workspace."activation_admission_token" IS NOT NULL
            AND (
              EXISTS (
                SELECT 1
                FROM public."secrets" secret
                WHERE secret."org_id" = p_org_id
                  AND secret."id" = p_secret_id
                  AND secret."disabled_at" IS NULL
                  AND secret."deleted_at" IS NULL
                  AND (
                    NOT companion_project_control_plane_env_key(secret."key")
                    OR starts_with(upper(btrim(secret."key")), 'OPENCODE_SERVER_')
                  )
                  AND (
                    secret."owner_id" = workspace."creator_id"
                    OR secret."audience" = 'organization'
                    OR (
                      secret."audience" = 'restricted'
                      AND EXISTS (
                        SELECT 1
                        FROM public."secret_recipients" recipient
                        WHERE recipient."org_id" = secret."org_id"
                          AND recipient."secret_id" = secret."id"
                          AND recipient."user_id" = workspace."creator_id"
                      )
                    )
                  )
              )
              OR (
                (
                  NOT companion_project_control_plane_env_key(
                    COALESCE(p_previous_key, secret_key)
                  )
                  OR starts_with(
                    upper(btrim(COALESCE(p_previous_key, secret_key))),
                    'OPENCODE_SERVER_'
                  )
                )
                AND (
                  secret_owner = workspace."creator_id"
                  OR COALESCE(p_previous_audience, secret_audience) = 'organization'
                  OR (
                    COALESCE(p_previous_audience, secret_audience) = 'restricted'
                    AND workspace."creator_id" = ANY (
                      COALESCE(
                        p_previous_recipients,
                        ARRAY(
                          SELECT recipient."user_id"
                          FROM public."secret_recipients" recipient
                          WHERE recipient."org_id" = p_org_id
                            AND recipient."secret_id" = p_secret_id
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
      OR (
        p_mode = 'boundary'
        AND NOT (
          workspace."status" = 'error'
          AND workspace."last_error_code" = 'project_environment_invalid'
          AND workspace."environment_exposure_attempted_at" IS NULL
        )
        AND (
          EXISTS (
            SELECT 1
            FROM public."secrets" secret
            WHERE secret."org_id" = p_org_id
              AND secret."id" = p_secret_id
              AND secret."disabled_at" IS NULL
              AND secret."deleted_at" IS NULL
              AND (
                NOT companion_project_control_plane_env_key(secret."key")
                OR starts_with(upper(btrim(secret."key")), 'OPENCODE_SERVER_')
              )
              AND (
                secret."owner_id" = workspace."creator_id"
                OR secret."audience" = 'organization'
                OR (
                  secret."audience" = 'restricted'
                  AND EXISTS (
                    SELECT 1
                    FROM public."secret_recipients" recipient
                    WHERE recipient."org_id" = secret."org_id"
                      AND recipient."secret_id" = secret."id"
                      AND recipient."user_id" = workspace."creator_id"
                  )
                )
              )
          )
          OR EXISTS (
            SELECT 1
            FROM public."project_secret_inputs" pin
            WHERE pin."org_id" = workspace."org_id"
              AND pin."project_id" = workspace."project_id"
              AND pin."creator_id" = workspace."creator_id"
              AND pin."activation_revision" = workspace."activation_revision"
              AND pin."secret_id" = p_secret_id
          )
        )
      )
      OR (
        workspace."status" = 'error'
        AND workspace."last_error_code" = 'project_environment_invalid'
        AND workspace."environment_exposure_attempted_at" IS NULL
        AND p_change_kind IN ('projection', 'create', 'key_acl', 'delete', 'disable')
        AND companion_project_environment_is_valid(
          workspace."org_id",
          workspace."creator_id",
          NULL
        )
        AND (
          EXISTS (
            SELECT 1
            FROM public."secrets" secret
            WHERE secret."org_id" = p_org_id
              AND secret."id" = p_secret_id
              AND secret."disabled_at" IS NULL
              AND secret."deleted_at" IS NULL
              AND (
                NOT companion_project_control_plane_env_key(secret."key")
                OR starts_with(upper(btrim(secret."key")), 'OPENCODE_SERVER_')
              )
              AND (
                secret."owner_id" = workspace."creator_id"
                OR secret."audience" = 'organization'
                OR (
                  secret."audience" = 'restricted'
                  AND EXISTS (
                    SELECT 1
                    FROM public."secret_recipients" recipient
                    WHERE recipient."org_id" = secret."org_id"
                      AND recipient."secret_id" = secret."id"
                      AND recipient."user_id" = workspace."creator_id"
                  )
                )
              )
          )
          OR (
            (
              NOT companion_project_control_plane_env_key(
                COALESCE(p_previous_key, secret_key)
              )
              OR starts_with(
                upper(btrim(COALESCE(p_previous_key, secret_key))),
                'OPENCODE_SERVER_'
              )
            )
            AND (
              secret_owner = workspace."creator_id"
              OR COALESCE(p_previous_audience, secret_audience) = 'organization'
              OR (
                COALESCE(p_previous_audience, secret_audience) = 'restricted'
                AND workspace."creator_id" = ANY (
                  COALESCE(
                    p_previous_recipients,
                    ARRAY(
                      SELECT recipient."user_id"
                      FROM public."secret_recipients" recipient
                      WHERE recipient."org_id" = p_org_id
                        AND recipient."secret_id" = p_secret_id
                    )
                  )
                )
              )
            )
          )
        )
      )
    );
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
  RETURN changed_count;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_signal_project_secret_change(
  uuid, uuid, text, text, text, public."secret_audience", text[]
) FROM PUBLIC;--> statement-breakpoint

-- Provider additions/rotations are boundary changes to the effective provider slot. Disconnect is
-- immediate only for Projects whose current activation actually injected that exact connection.
CREATE FUNCTION companion_signal_project_provider_change(
  p_org_id uuid,
  p_provider text,
  p_connection_id uuid,
  p_scope public."model_provider_connection_scope",
  p_user_id text,
  p_mode text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id text := NULLIF(current_setting('app.user_id', true), '');
  tenant_id uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  changed_count integer := 0;
  wake_count integer := 0;
  previous_worker_context text := current_setting('app.project_worker', true);
BEGIN
  IF p_mode NOT IN ('boundary', 'immediate') THEN
    RAISE EXCEPTION 'invalid Project provider change mode' USING ERRCODE = '22023';
  END IF;
  IF tenant_id IS DISTINCT FROM p_org_id OR actor_id IS NULL THEN
    RAISE EXCEPTION 'Project provider change tenant context is invalid' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public."model_provider_connections" connection
    WHERE connection."org_id" = p_org_id
      AND connection."id" = p_connection_id
      AND connection."provider" = p_provider
      AND connection."scope" = p_scope
      AND connection."user_id" IS NOT DISTINCT FROM p_user_id
      AND (
        (p_scope = 'personal' AND p_user_id = actor_id)
        OR (
          p_scope = 'organization'
          AND EXISTS (
            SELECT 1 FROM public."memberships" membership
            WHERE membership."org_id" = p_org_id
              AND membership."user_id" = actor_id
              AND membership."org_role" IN ('owner', 'admin')
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'provider connection not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('app.project_worker', 'provider_signal', true);
  UPDATE public."project_workspaces" workspace
  SET "recycle_requested_at" = COALESCE(workspace."recycle_requested_at", clock_timestamp()),
      "recycle_reason" = CASE
        WHEN p_mode = 'immediate' THEN 'immediate:model_connections_changed'
        WHEN workspace."recycle_reason" LIKE 'immediate:%' THEN workspace."recycle_reason"
        ELSE 'boundary:model_connections_changed'
      END,
      "available_at" = clock_timestamp(),
      "updated_at" = clock_timestamp()
  WHERE workspace."org_id" = p_org_id
    AND (
      (
        workspace."environment_exposure_attempted_at" IS NOT NULL
        AND workspace."status" NOT IN ('stopped', 'deleted')
      )
      OR (
        workspace."activation_admission_token" IS NOT NULL
        AND workspace."status" <> 'deleted'
      )
      OR (
        workspace."status" = 'provisioning'
        AND workspace."environment_exposure_attempted_at" IS NULL
        AND workspace."activation_revision" > 0
      )
    )
    AND EXISTS (
      SELECT 1
      FROM public."memberships" membership
      WHERE membership."org_id" = workspace."org_id"
        AND membership."user_id" = workspace."creator_id"
    )
    AND EXISTS (
      SELECT 1
      FROM public."projects" project
      WHERE project."org_id" = workspace."org_id"
        AND project."id" = workspace."project_id"
        AND project."creator_id" = workspace."creator_id"
        AND project."delete_requested_at" IS NULL
    )
    AND (
      (
        p_mode = 'immediate'
        AND (
          EXISTS (
            SELECT 1
            FROM public."project_model_provider_inputs" pin
            WHERE pin."org_id" = workspace."org_id"
              AND pin."project_id" = workspace."project_id"
              AND pin."creator_id" = workspace."creator_id"
              AND pin."activation_revision" = workspace."activation_revision"
              AND pin."connection_id" = p_connection_id
          )
          OR (
            workspace."activation_admission_token" IS NOT NULL
            AND (
              (p_scope = 'personal' AND workspace."creator_id" = p_user_id)
              OR (
                p_scope = 'organization'
                AND NOT EXISTS (
                  SELECT 1
                  FROM public."model_provider_connections" personal
                  WHERE personal."org_id" = p_org_id
                    AND personal."scope" = 'personal'
                    AND personal."user_id" = workspace."creator_id"
                    AND personal."provider" = p_provider
                )
              )
            )
          )
        )
      )
      OR (
        p_mode = 'boundary'
        AND (
          (p_scope = 'personal' AND workspace."creator_id" = p_user_id)
          OR (
            p_scope = 'organization'
            AND NOT EXISTS (
              SELECT 1
              FROM public."model_provider_connections" personal
              WHERE personal."org_id" = p_org_id
                AND personal."scope" = 'personal'
                AND personal."user_id" = workspace."creator_id"
                AND personal."provider" = p_provider
            )
          )
        )
      )
    );
  GET DIAGNOSTICS changed_count = ROW_COUNT;

  -- A pre-send provider block has no exposed runtime to recycle. Only a successful effective
  -- connect/rotation can reopen it; another queued prompt deliberately cannot.
  IF p_mode IN ('boundary', 'immediate') THEN
    UPDATE public."project_workspaces" workspace
    SET "status" = 'queued',
        "recycle_requested_at" = NULL,
        "recycle_reason" = NULL,
        "last_error_code" = NULL,
        "last_error_message" = NULL,
        "attempt" = 0,
        "available_at" = clock_timestamp(),
        "updated_at" = clock_timestamp()
    WHERE workspace."org_id" = p_org_id
      AND workspace."environment_exposure_attempted_at" IS NULL
      AND workspace."status" <> 'deleted'
      AND EXISTS (
        SELECT 1
        FROM public."projects" project
        WHERE project."org_id" = workspace."org_id"
          AND project."id" = workspace."project_id"
          AND project."creator_id" = workspace."creator_id"
          AND project."delete_requested_at" IS NULL
      )
      AND EXISTS (
        SELECT 1
        FROM public."memberships" membership
        WHERE membership."org_id" = workspace."org_id"
          AND membership."user_id" = workspace."creator_id"
      )
      AND workspace."last_error_code" IN (
        'project_provider_unavailable',
        'project_environment_invalid'
      )
      AND (
        (p_scope = 'personal' AND workspace."creator_id" = p_user_id)
        OR (
          p_scope = 'organization'
          AND NOT EXISTS (
            SELECT 1
            FROM public."model_provider_connections" personal
            WHERE personal."org_id" = p_org_id
              AND personal."scope" = 'personal'
              AND personal."user_id" = workspace."creator_id"
              AND personal."provider" = p_provider
          )
        )
      )
      AND (
        (
          workspace."last_error_code" = 'project_environment_invalid'
          AND companion_project_environment_is_valid(
            workspace."org_id",
            workspace."creator_id",
            CASE WHEN p_mode = 'immediate' THEN p_connection_id ELSE NULL END
          )
        )
        OR (
          workspace."last_error_code" = 'project_provider_unavailable'
          AND (
            (
              p_mode = 'boundary'
              AND EXISTS (
                SELECT 1
                FROM public."project_sessions" session
                JOIN public."project_prompts" prompt
                  ON prompt."org_id" = session."org_id"
                 AND prompt."project_id" = session."project_id"
                 AND prompt."session_id" = session."id"
                JOIN public."model_provider_connections" connection
                  ON connection."org_id" = p_org_id
                 AND connection."id" = p_connection_id
                WHERE session."org_id" = workspace."org_id"
                  AND session."project_id" = workspace."project_id"
                  AND session."creator_id" = workspace."creator_id"
                  AND session."model_provider" = p_provider
                  AND connection."key_name" = ANY(session."model_credential_env_keys")
                  AND prompt."status" IN ('queued', 'dispatching', 'running')
              )
            )
            OR (
              p_mode = 'immediate'
              AND p_scope = 'personal'
              AND EXISTS (
                SELECT 1
                FROM public."project_sessions" session
                JOIN public."project_prompts" prompt
                  ON prompt."org_id" = session."org_id"
                 AND prompt."project_id" = session."project_id"
                 AND prompt."session_id" = session."id"
                JOIN public."model_provider_connections" fallback
                  ON fallback."org_id" = p_org_id
                 AND fallback."scope" = 'organization'
                 AND fallback."provider" = p_provider
                WHERE session."org_id" = workspace."org_id"
                  AND session."project_id" = workspace."project_id"
                  AND session."creator_id" = workspace."creator_id"
                  AND session."model_provider" = p_provider
                  AND fallback."key_name" = ANY(session."model_credential_env_keys")
                  AND prompt."status" IN ('queued', 'dispatching', 'running')
              )
            )
          )
        )
      );
    GET DIAGNOSTICS wake_count = ROW_COUNT;
    changed_count := changed_count + wake_count;
  END IF;

  PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
  RETURN changed_count;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_signal_project_provider_change(
  uuid, text, uuid, public."model_provider_connection_scope", text, text
) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_heartbeat_project_worker(
  p_worker_id text,
  p_ttl_seconds integer DEFAULT 15,
  p_protocol_version integer DEFAULT 1
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_worker_id IS NULL OR length(btrim(p_worker_id)) < 1 OR length(p_worker_id) > 512 THEN
    RAISE EXCEPTION 'valid worker id is required' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds < 5 OR p_ttl_seconds > 300 OR p_protocol_version < 1 THEN
    RAISE EXCEPTION 'invalid project worker heartbeat' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public."project_worker_heartbeats"
    ("worker_id", "protocol_version", "expires_at", "updated_at")
  VALUES (
    p_worker_id,
    p_protocol_version,
    clock_timestamp() + make_interval(secs => p_ttl_seconds),
    clock_timestamp()
  )
  ON CONFLICT ("worker_id") DO UPDATE
  SET "protocol_version" = EXCLUDED."protocol_version",
      "expires_at" = EXCLUDED."expires_at",
      "updated_at" = EXCLUDED."updated_at";
  DELETE FROM public."project_worker_heartbeats"
  WHERE "expires_at" <= clock_timestamp() - interval '1 hour';
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_heartbeat_project_worker(text, integer, integer) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_remove_project_worker(p_worker_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_worker_id IS NULL OR length(btrim(p_worker_id)) < 1 OR length(p_worker_id) > 512 THEN
    RAISE EXCEPTION 'valid worker id is required' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public."project_worker_heartbeats" WHERE "worker_id" = p_worker_id;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_remove_project_worker(text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_project_worker_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."project_worker_heartbeats"
    WHERE "expires_at" > clock_timestamp() AND "protocol_version" >= 1
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_project_worker_ready() FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_claim_project_workspaces(
  p_worker_id text,
  p_limit integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 30
)
RETURNS TABLE (
  "org_id" uuid,
  "project_id" uuid,
  "creator_id" text,
  "status" "project_workspace_status",
  "sandbox_name" text,
  "sandbox_id" text,
  "sandbox_domain" text,
  "checkpoint_id" text,
  "checkpoint_generation" integer,
  "desired_generation" integer,
  "applied_generation" integer,
  "last_activity_at" timestamp with time zone,
  "idle_deadline_at" timestamp with time zone,
  "activation_revision" integer,
  "authority_revision" text,
  "activation_admission_token" uuid,
  "activation_admission_revision" integer,
  "activation_admission_authority_revision" text,
  "activation_admitted_at" timestamp with time zone,
  "environment_exposure_attempted_at" timestamp with time zone,
  "recycle_requested_at" timestamp with time zone,
  "recycle_reason" text,
  "skill_sync_error_at" timestamp with time zone,
  "skill_sync_error_code" text,
  "skill_sync_error_message" text,
  "lease_generation" integer,
  "delete_requested_at" timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_worker_context text := current_setting('app.project_worker', true);
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 512 THEN
    RAISE EXCEPTION 'valid worker id is required' USING ERRCODE = '22023';
  END IF;
  IF p_limit < 1 OR p_limit > 32 OR p_lease_seconds < 5 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'invalid project workspace claim limits' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.project_worker', 'claim', true);
  RETURN QUERY
  WITH candidates AS (
    SELECT w."org_id", w."project_id"
    FROM public."project_workspaces" w
    JOIN public."projects" p
      ON p."org_id" = w."org_id" AND p."id" = w."project_id"
    WHERE w."available_at" <= clock_timestamp()
      AND (w."lease_expires_at" IS NULL OR w."lease_expires_at" <= clock_timestamp())
      AND (
        p."delete_requested_at" IS NOT NULL
        OR (
          NOT EXISTS (
            SELECT 1 FROM public."memberships" m
            WHERE m."org_id" = w."org_id" AND m."user_id" = w."creator_id"
          )
          AND (
            (
              w."sandbox_id" IS NOT NULL
              AND w."status" NOT IN ('stopped', 'needs_attention', 'deleted')
            )
            OR EXISTS (
              SELECT 1 FROM public."project_prompts" prompt
              WHERE prompt."org_id" = w."org_id"
                AND prompt."project_id" = w."project_id"
                AND prompt."status" IN ('queued', 'dispatching', 'running')
            )
          )
        )
        OR (
          EXISTS (
            SELECT 1 FROM public."memberships" m
            WHERE m."org_id" = w."org_id" AND m."user_id" = w."creator_id"
          )
          AND (
            -- Credential rotation/revocation is an explicit environment boundary, not a functional
            -- retry. An exposed warm runtime must remain claimable even after an unrelated failure.
            (
              w."recycle_requested_at" IS NOT NULL
              AND w."environment_exposure_attempted_at" IS NOT NULL
              AND w."status" NOT IN ('stopped', 'deleted')
            )
            OR (
              w."status" <> 'needs_attention'
              -- An invalid pre-activation environment is stable until a secret/provider signal
              -- explicitly returns it to queued. A newly queued prompt alone must not churn it.
              AND (
                w."status" <> 'error'
                OR w."last_error_code" IS DISTINCT FROM 'project_environment_invalid'
                OR w."recycle_requested_at" IS NOT NULL
              )
              AND (
                w."recycle_requested_at" IS NOT NULL
                OR w."skill_sync_error_at" IS NOT NULL
                OR w."status" IN ('queued', 'provisioning', 'stopping', 'deleting')
                -- Runtime/provider failures stay retryable. max_attempts caps retry telemetry while
                -- available_at remains the backoff boundary; it is not a terminal lifecycle state.
                OR (
                  w."status" = 'error'
                  AND w."last_error_code" = 'project_runtime_failed'
                )
                OR w."desired_generation" > w."applied_generation"
                OR (w."idle_deadline_at" IS NOT NULL AND w."idle_deadline_at" <= clock_timestamp())
                OR (
                  w."last_error_code" IS DISTINCT FROM 'project_provider_unavailable'
                  AND EXISTS (
                    SELECT 1 FROM public."project_prompts" prompt
                    WHERE prompt."org_id" = w."org_id"
                      AND prompt."project_id" = w."project_id"
                      AND (
                        (prompt."status" = 'queued' AND prompt."available_at" <= clock_timestamp())
                        OR (
                          prompt."status" IN ('dispatching', 'running')
                          AND prompt."lease_expires_at" <= clock_timestamp()
                        )
                      )
                  )
                )
                OR EXISTS (
                  SELECT 1 FROM public."project_sessions" session
                  WHERE session."org_id" = w."org_id"
                    AND session."project_id" = w."project_id"
                    AND (
                      session."status" = 'stopping'
                      OR session."stop_requested_at" IS NOT NULL
                    )
                  )
                )
              )
            )
          )
        )
    ORDER BY w."available_at", w."updated_at", w."project_id"
    FOR UPDATE OF w SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public."project_workspaces" w
    SET "lease_owner" = p_worker_id,
        "lease_expires_at" = clock_timestamp() + make_interval(secs => p_lease_seconds),
        "heartbeat_at" = clock_timestamp(),
        "lease_generation" = w."lease_generation" + 1,
        "attempt" = least(w."attempt" + 1, w."max_attempts"),
        "updated_at" = clock_timestamp()
    FROM candidates c
    WHERE w."org_id" = c."org_id" AND w."project_id" = c."project_id"
    RETURNING w.*
  )
  SELECT c."org_id", c."project_id", c."creator_id", c."status",
         c."sandbox_name", c."sandbox_id", c."sandbox_domain", c."checkpoint_id",
         c."checkpoint_generation",
         c."desired_generation", c."applied_generation",
         c."last_activity_at", c."idle_deadline_at", c."activation_revision",
         c."authority_revision",
         c."activation_admission_token", c."activation_admission_revision",
         c."activation_admission_authority_revision", c."activation_admitted_at",
         c."environment_exposure_attempted_at",
         c."recycle_requested_at", c."recycle_reason",
         c."skill_sync_error_at", c."skill_sync_error_code", c."skill_sync_error_message",
         c."lease_generation", p."delete_requested_at"
  FROM claimed c
  JOIN public."projects" p ON p."org_id" = c."org_id" AND p."id" = c."project_id";
  PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_claim_project_workspaces(text, integer, integer) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_enter_project_worker_lease(
  p_org_id uuid,
  p_project_id uuid,
  p_creator_id text,
  p_worker_id text,
  p_lease_generation integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  valid_lease boolean;
  context_token uuid := gen_random_uuid();
  previous_worker_context text := current_setting('app.project_worker', true);
BEGIN
  PERFORM set_config('app.project_worker', 'enter_lease', true);
  SELECT EXISTS (
    SELECT 1 FROM public."project_workspaces" w
    WHERE w."org_id" = p_org_id
      AND w."project_id" = p_project_id
      AND w."creator_id" = p_creator_id
      AND w."lease_owner" = p_worker_id
      AND w."lease_generation" = p_lease_generation
      AND w."lease_expires_at" > clock_timestamp()
  ) INTO valid_lease;
  IF NOT valid_lease THEN
    PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
    RETURN false;
  END IF;
  DELETE FROM public."project_worker_lease_contexts"
  WHERE "backend_pid" = pg_backend_pid()
    OR "created_at" < clock_timestamp() - interval '1 day';
  INSERT INTO public."project_worker_lease_contexts" (
    "backend_pid",
    "transaction_id",
    "token",
    "org_id",
    "project_id",
    "creator_id",
    "worker_id",
    "lease_generation"
  ) VALUES (
    pg_backend_pid(),
    txid_current()::text,
    context_token,
    p_org_id,
    p_project_id,
    p_creator_id,
    p_worker_id,
    p_lease_generation
  );
  PERFORM set_config('app.project_worker', 'exact_lease', true);
  PERFORM set_config('app.project_worker_id', p_worker_id, true);
  PERFORM set_config('app.project_worker_org_id', p_org_id::text, true);
  PERFORM set_config('app.project_worker_project_id', p_project_id::text, true);
  PERFORM set_config('app.project_worker_creator_id', p_creator_id, true);
  PERFORM set_config('app.project_worker_lease_generation', p_lease_generation::text, true);
  PERFORM set_config('app.project_worker_context_token', context_token::text, true);
  PERFORM set_config('app.org_id', p_org_id::text, true);
  PERFORM set_config('app.user_id', p_creator_id, true);
  RETURN true;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_enter_project_worker_lease(uuid, uuid, text, text, integer) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_notify_project_session_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_notify(
    'project_session_events',
    json_build_object('session_id', NEW."session_id", 'sequence', NEW."sequence")::text
  );
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "project_session_events_notify"
AFTER INSERT ON "project_session_events"
FOR EACH ROW EXECUTE FUNCTION companion_notify_project_session_event();
