-- Runtime v2 is an isolated write model. It is deliberately not backfilled from the legacy
-- request-driven Companion state: a non-empty legacy fleet may cross this boundary only after the
-- durable 0089 purge ledger proves that both provider and database cleanup completed. A genuinely
-- fresh database has no legacy rows and therefore needs no synthetic ledger row.
-- Hold legacy writers out until the migration commits. The protocol fence installed below then
-- rejects every old control-plane mutation after this transaction releases these locks.
LOCK TABLE
  public.companions,
  public.companion_runtime_pools,
  public.companion_workspace_access,
  public.companion_member_state,
  public.companion_threads,
  public.companion_transcript_entries,
  public.companion_reconcile_leases,
  public.api_tokens
IN SHARE MODE;
--> statement-breakpoint

DO $$
BEGIN
  -- A completed ledger is proof about the purge transaction that produced it, not a permanent
  -- exemption. If a legacy API writes anything afterwards, cutover must stop and purge again.
  IF
    EXISTS (SELECT 1 FROM public.companions)
    OR EXISTS (SELECT 1 FROM public.companion_runtime_pools)
    OR EXISTS (SELECT 1 FROM public.companion_workspace_access)
    OR EXISTS (SELECT 1 FROM public.companion_member_state)
    OR EXISTS (SELECT 1 FROM public.companion_threads)
    OR EXISTS (SELECT 1 FROM public.companion_transcript_entries)
    OR EXISTS (SELECT 1 FROM public.companion_reconcile_leases)
    OR EXISTS (SELECT 1 FROM public.api_tokens WHERE source_type = 'companion')
  THEN
    RAISE EXCEPTION 'Runtime v2 requires every legacy Companion row to be purged after the last legacy write'
      USING ERRCODE = '55000';
  END IF;

  -- A fresh installation has no purge run. Once a purge ledger exists, however, only its terminal
  -- phase authorizes the next migration; a partial or blocked external deletion cannot be skipped.
  IF EXISTS (SELECT 1 FROM public.companion_legacy_purge_runs)
     AND NOT EXISTS (
       SELECT 1
       FROM public.companion_legacy_purge_runs
       WHERE id = 'legacy-companion-purge'
         AND phase = 'database_complete'
     ) THEN
    RAISE EXCEPTION 'Runtime v2 requires the 0089 legacy purge ledger at database_complete'
      USING ERRCODE = '55000';
  END IF;
END
$$;
--> statement-breakpoint

CREATE TYPE "companion_box_observed_state" AS ENUM (
  'absent', 'initializing', 'provisioning', 'ready', 'idle', 'running',
  'archiving', 'archived', 'error', 'unknown'
);
--> statement-breakpoint
CREATE TYPE "companion_pi_observed_state" AS ENUM (
  'absent', 'starting', 'idle', 'running', 'stopped', 'error', 'unknown'
);
--> statement-breakpoint
CREATE TYPE "companion_runtime_retirement_state" AS ENUM (
  'active', 'requested', 'pending', 'blocked', 'retired'
);
--> statement-breakpoint
CREATE TYPE "companion_client_surface" AS ENUM ('web', 'mobile_web', 'native_mobile');
--> statement-breakpoint
CREATE TYPE "companion_turn_status" AS ENUM (
  'queued', 'starting', 'dispatching', 'running', 'needs_input',
  'succeeded', 'failed', 'interrupted', 'cancelled'
);
--> statement-breakpoint
CREATE TYPE "companion_attempt_status" AS ENUM (
  'starting', 'dispatching', 'running', 'needs_input',
  'succeeded', 'failed', 'interrupted', 'cancelled'
);
--> statement-breakpoint
CREATE TYPE "companion_dispatch_state" AS ENUM (
  'pending', 'write_intent', 'accepted', 'rejected', 'ambiguous'
);
--> statement-breakpoint
CREATE TYPE "companion_operation_kind" AS ENUM (
  'delete', 'stop', 'restart_pi', 'restart_box', 'start', 'apply_settings'
);
--> statement-breakpoint
CREATE TYPE "companion_operation_status" AS ENUM (
  'pending', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled'
);
--> statement-breakpoint
CREATE TYPE "companion_operation_trigger" AS ENUM (
  'turn', 'user', 'settings', 'recovery', 'kill_switch'
);
--> statement-breakpoint
CREATE TYPE "companion_runtime_error_action" AS ENUM (
  'retry', 'cancel', 'restart_pi', 'restart_box', 'switch_model',
  'reconnect_provider', 'none'
);
--> statement-breakpoint
CREATE TYPE "companion_runtime_work_kind" AS ENUM (
  'operation', 'decision', 'attempt', 'settings', 'health'
);
--> statement-breakpoint
CREATE TYPE "companion_decision_status" AS ENUM (
  'pending', 'allowed', 'denied', 'answered', 'expired', 'cancelled'
);
--> statement-breakpoint
CREATE TYPE "companion_decision_delivery_state" AS ENUM (
  'pending', 'write_intent', 'delivered', 'ambiguous', 'cancelled'
);
--> statement-breakpoint

-- One authoritative deployment gate. Epoch changes fence every in-flight lease; the gate starts
-- disabled so the schema may deploy before any Runtime v2 executor is admitted.
CREATE TABLE "companion_runtime_control" (
  "id" text PRIMARY KEY DEFAULT 'runtime-v2' NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "gate_epoch" bigint DEFAULT 1 NOT NULL,
  "enabled_at" timestamp with time zone,
  "disabled_at" timestamp with time zone DEFAULT now(),
  "changed_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_runtime_control_singleton_check" CHECK ("id" = 'runtime-v2'),
  CONSTRAINT "companion_runtime_control_epoch_check" CHECK ("gate_epoch" >= 1),
  CONSTRAINT "companion_runtime_control_state_check" CHECK (
    ("enabled" AND "enabled_at" IS NOT NULL AND "disabled_at" IS NULL)
    OR (NOT "enabled" AND "disabled_at" IS NOT NULL)
  ),
  CONSTRAINT "companion_runtime_control_actor_check" CHECK (
    "changed_by" IS NULL OR (char_length("changed_by") BETWEEN 1 AND 200 AND "changed_by" !~ E'[\\n\\r]')
  )
);
--> statement-breakpoint
INSERT INTO "companion_runtime_control" ("id") VALUES ('runtime-v2');
--> statement-breakpoint

-- The durable one-Companion/one-Box/one-Pi projection. It stores identifiers and sanitized state,
-- never provider payloads, credential plaintext, signed URLs, or desktop URLs.
CREATE TABLE "companion_runtime_instances" (
  "org_id" uuid NOT NULL,
  "companion_id" uuid PRIMARY KEY NOT NULL,
  "generation" bigint DEFAULT 1 NOT NULL,
  "box_id" text,
  "box_state" "companion_box_observed_state" DEFAULT 'absent' NOT NULL,
  "pi_state" "companion_pi_observed_state" DEFAULT 'absent' NOT NULL,
  "pi_invocation_id" text,
  "disk_layout_version" integer DEFAULT 0 NOT NULL,
  "desired_settings_revision" bigint DEFAULT 1 NOT NULL,
  "applied_settings_revision" bigint DEFAULT 0 NOT NULL,
  "applied_skills_revision" integer DEFAULT 0 NOT NULL,
  "applied_client_surface" "companion_client_surface",
  "settings_actor_id" text,
  "settings_checkpoint" text DEFAULT 'pending' NOT NULL,
  "settings_checkpoint_sequence" bigint DEFAULT 0 NOT NULL,
  "settings_claim_epoch" bigint,
  "settings_claim_actor_id" text,
  "settings_claim_client_surface" "companion_client_surface",
  "settings_claim_turn_id" uuid,
  "settings_claim_cold_start_deadline_at" timestamp with time zone,
  "settings_claim_revision" bigint,
  "settings_claim_skills_revision" integer,
  "settings_claim_model_id" text,
  "settings_claim_persona" text,
  "settings_claim_can_write_skills" boolean,
  "settings_claim_provider_ids" jsonb,
  "settings_claim_selected_skill_ids" jsonb,
  "settings_claim_skill_refs" jsonb,
  "settings_claim_selected_mcp_account_ids" jsonb,
  "settings_available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settings_attempt_count" integer DEFAULT 0 NOT NULL,
  "health_checkpoint" text DEFAULT 'pending' NOT NULL,
  "health_checkpoint_sequence" bigint DEFAULT 0 NOT NULL,
  "health_claim_epoch" bigint,
  "health_due_at" timestamp with time zone DEFAULT now() NOT NULL,
  "next_turn_sequence" bigint DEFAULT 1 NOT NULL,
  "next_operation_sequence" bigint DEFAULT 1 NOT NULL,
  "last_heartbeat_at" timestamp with time zone,
  "box_observed_at" timestamp with time zone,
  "pi_observed_at" timestamp with time zone,
  "last_observed_at" timestamp with time zone,
  "retirement_state" "companion_runtime_retirement_state" DEFAULT 'active' NOT NULL,
  "retirement_requested_at" timestamp with time zone,
  "retired_at" timestamp with time zone,
  "last_write_epoch" bigint DEFAULT 0 NOT NULL,
  "last_error_code" text,
  "last_error_message" text,
  "last_error_action" "companion_runtime_error_action",
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_runtime_instances_org_companion_uq" UNIQUE ("org_id", "companion_id"),
  CONSTRAINT "companion_runtime_instances_generation_check" CHECK ("generation" >= 1),
  CONSTRAINT "companion_runtime_instances_box_id_check" CHECK (
    "box_id" IS NULL OR "box_id" ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'
  ),
  CONSTRAINT "companion_runtime_instances_pi_invocation_check" CHECK (
    "pi_invocation_id" IS NULL OR (char_length("pi_invocation_id") BETWEEN 1 AND 200 AND "pi_invocation_id" !~ E'[\\n\\r]')
  ),
  CONSTRAINT "companion_runtime_instances_revision_check" CHECK (
    "disk_layout_version" >= 0
    AND "desired_settings_revision" >= 1
    AND "applied_settings_revision" >= 0
    AND "applied_settings_revision" <= "desired_settings_revision"
    AND "applied_skills_revision" >= 0
    AND (("applied_settings_revision" = 0) = ("applied_client_surface" IS NULL))
    AND "next_turn_sequence" >= 1
    AND "next_operation_sequence" >= 1
    AND "last_write_epoch" >= 0
  ),
  CONSTRAINT "companion_runtime_instances_settings_actor_check" CHECK (
    ("settings_actor_id" IS NULL OR (char_length("settings_actor_id") BETWEEN 1 AND 200 AND "settings_actor_id" !~ E'[\\n\\r]'))
    AND ("settings_claim_actor_id" IS NULL OR (char_length("settings_claim_actor_id") BETWEEN 1 AND 200 AND "settings_claim_actor_id" !~ E'[\\n\\r]'))
    AND (("settings_claim_epoch" IS NULL) = ("settings_claim_actor_id" IS NULL))
    AND (("settings_claim_epoch" IS NULL) = ("settings_claim_client_surface" IS NULL))
    AND ("settings_claim_epoch" IS NOT NULL OR "settings_claim_turn_id" IS NULL)
    AND ("settings_claim_turn_id" IS NOT NULL OR "settings_claim_cold_start_deadline_at" IS NULL)
    AND (("settings_claim_epoch" IS NULL) = ("settings_claim_revision" IS NULL))
    AND (("settings_claim_epoch" IS NULL) = ("settings_claim_skills_revision" IS NULL))
    AND (("settings_claim_epoch" IS NULL) = ("settings_claim_can_write_skills" IS NULL))
    AND (("settings_claim_epoch" IS NULL) = ("settings_claim_provider_ids" IS NULL))
    AND (("settings_claim_epoch" IS NULL) = ("settings_claim_selected_skill_ids" IS NULL))
    AND (("settings_claim_epoch" IS NULL) = ("settings_claim_skill_refs" IS NULL))
    AND (("settings_claim_epoch" IS NULL) = ("settings_claim_selected_mcp_account_ids" IS NULL))
    AND ("settings_claim_revision" IS NULL OR "settings_claim_revision" >= 1)
    AND ("settings_claim_skills_revision" IS NULL OR "settings_claim_skills_revision" >= 0)
    AND ("settings_claim_model_id" IS NULL OR (
      "settings_claim_epoch" IS NOT NULL
      AND char_length("settings_claim_model_id") BETWEEN 1 AND 200
      AND "settings_claim_model_id" !~ E'[\\n\\r]'
    ))
    AND ("settings_claim_persona" IS NULL OR (
      "settings_claim_epoch" IS NOT NULL AND char_length("settings_claim_persona") <= 280
    ))
    AND ("settings_claim_provider_ids" IS NULL OR jsonb_typeof("settings_claim_provider_ids") = 'array')
    AND ("settings_claim_selected_skill_ids" IS NULL OR jsonb_typeof("settings_claim_selected_skill_ids") = 'array')
    AND ("settings_claim_skill_refs" IS NULL OR jsonb_typeof("settings_claim_skill_refs") = 'array')
    AND ("settings_claim_selected_mcp_account_ids" IS NULL OR jsonb_typeof("settings_claim_selected_mcp_account_ids") = 'array')
  ),
  CONSTRAINT "companion_runtime_instances_settings_checkpoint_check" CHECK (
    "settings_checkpoint" IN ('pending', 'applying', 'applied')
    AND "settings_checkpoint_sequence" >= 0
    AND "settings_attempt_count" >= 0
  ),
  CONSTRAINT "companion_runtime_instances_health_checkpoint_check" CHECK (
    "health_checkpoint" IN ('pending', 'observing', 'observed')
    AND "health_checkpoint_sequence" >= 0
  ),
  CONSTRAINT "companion_runtime_instances_retirement_check" CHECK (
    ("retirement_state" = 'active' AND "retirement_requested_at" IS NULL AND "retired_at" IS NULL)
    OR ("retirement_state" IN ('requested', 'pending', 'blocked') AND "retirement_requested_at" IS NOT NULL AND "retired_at" IS NULL)
    OR ("retirement_state" = 'retired' AND "retirement_requested_at" IS NOT NULL AND "retired_at" IS NOT NULL)
  ),
  CONSTRAINT "companion_runtime_instances_error_check" CHECK (
    (("last_error_code" IS NULL) = ("last_error_message" IS NULL))
    AND (("last_error_code" IS NULL) = ("last_error_action" IS NULL))
    AND ("last_error_code" IS NULL OR "last_error_code" ~ '^[a-z][a-z0-9_]{0,63}$')
    AND ("last_error_message" IS NULL OR (char_length("last_error_message") <= 500 AND "last_error_message" !~ E'[\\n\\r]'))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "companion_runtime_instances_box_id_uq"
  ON "companion_runtime_instances" ("box_id") WHERE "box_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "companion_runtime_instances_health_due_idx"
  ON "companion_runtime_instances" ("health_due_at", "companion_id")
  WHERE "retirement_state" <> 'retired';
--> statement-breakpoint

-- One client message is one durable turn. Queue sequence is allocated monotonically from the
-- runtime instance and is never reused; only the oldest queued turn may be promoted by claim_work.
CREATE TABLE "companion_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "companion_id" uuid NOT NULL,
  "client_message_id" uuid NOT NULL,
  "message_event_id" text NOT NULL,
  "queue_sequence" bigint NOT NULL,
  "actor_id" text NOT NULL,
  "client_surface" "companion_client_surface" NOT NULL,
  "status" "companion_turn_status" DEFAULT 'queued' NOT NULL,
  "cold_start_deadline_at" timestamp with time zone,
  "inactivity_deadline_at" timestamp with time zone,
  "absolute_deadline_at" timestamp with time zone,
  "state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  "last_error_code" text,
  "last_error_message" text,
  "last_error_action" "companion_runtime_error_action",
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_turns_org_companion_id_uq" UNIQUE ("org_id", "companion_id", "id"),
  CONSTRAINT "companion_turns_client_message_uq" UNIQUE ("companion_id", "client_message_id"),
  CONSTRAINT "companion_turns_queue_sequence_uq" UNIQUE ("companion_id", "queue_sequence"),
  CONSTRAINT "companion_turns_queue_sequence_check" CHECK ("queue_sequence" >= 1),
  CONSTRAINT "companion_turns_message_event_check" CHECK (
    "message_event_id" = 'msg:' || "client_message_id"::text
  ),
  CONSTRAINT "companion_turns_actor_check" CHECK (
    char_length("actor_id") BETWEEN 1 AND 200 AND "actor_id" !~ E'[\\n\\r]'
  ),
  CONSTRAINT "companion_turns_deadline_check" CHECK (
    ("cold_start_deadline_at" IS NULL OR "cold_start_deadline_at" >= "created_at")
    AND
    ("status" IN ('queued', 'cancelled') AND "inactivity_deadline_at" IS NULL AND "absolute_deadline_at" IS NULL)
    OR (
      "status" <> 'queued'
      AND "absolute_deadline_at" IS NOT NULL
      AND ("inactivity_deadline_at" IS NULL OR "absolute_deadline_at" >= "inactivity_deadline_at")
    )
  ),
  CONSTRAINT "companion_turns_terminal_check" CHECK (
    ("status" IN ('succeeded', 'failed', 'interrupted', 'cancelled')) = ("settled_at" IS NOT NULL)
  ),
  CONSTRAINT "companion_turns_error_check" CHECK (
    (("last_error_code" IS NULL) = ("last_error_message" IS NULL))
    AND (("last_error_code" IS NULL) = ("last_error_action" IS NULL))
    AND ("last_error_code" IS NULL OR "last_error_code" ~ '^[a-z][a-z0-9_]{0,63}$')
    AND ("last_error_message" IS NULL OR (char_length("last_error_message") <= 500 AND "last_error_message" !~ E'[\\n\\r]'))
    AND ("status" NOT IN ('failed', 'interrupted') OR "last_error_code" IS NOT NULL)
    AND ("status" NOT IN ('succeeded', 'cancelled') OR "last_error_code" IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "companion_turns_one_active_uq"
  ON "companion_turns" ("companion_id")
  WHERE "status" IN ('starting', 'dispatching', 'running', 'needs_input');
--> statement-breakpoint
CREATE INDEX "companion_turns_queue_idx"
  ON "companion_turns" ("companion_id", "queue_sequence") WHERE "status" = 'queued';
--> statement-breakpoint
CREATE INDEX "companion_turns_deadline_idx"
  ON "companion_turns" ("cold_start_deadline_at", "inactivity_deadline_at", "absolute_deadline_at")
  WHERE "status" IN ('starting', 'dispatching', 'running', 'needs_input');
--> statement-breakpoint

-- An attempt is the resumable execution of a turn. A dispatch command id is persisted before a
-- FIFO write and the dispatch state records accepted versus ambiguous transport outcomes.
CREATE TABLE "companion_turn_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "companion_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL,
  "retry_id" uuid,
  "actor_id" text NOT NULL,
  "runtime_generation" bigint NOT NULL,
  "settings_revision" bigint NOT NULL,
  "skills_revision" integer NOT NULL,
  "model_id" text,
  "persona" text,
  "can_write_skills" boolean DEFAULT false NOT NULL,
  "provider_ids" jsonb NOT NULL,
  "selected_skill_ids" jsonb NOT NULL,
  "skill_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "selected_mcp_account_ids" jsonb NOT NULL,
  "claim_epoch" bigint,
  "status" "companion_attempt_status" DEFAULT 'starting' NOT NULL,
  "checkpoint" text DEFAULT 'starting' NOT NULL,
  "checkpoint_sequence" bigint DEFAULT 0 NOT NULL,
  "dispatch_state" "companion_dispatch_state" DEFAULT 'pending' NOT NULL,
  "dispatch_count" integer DEFAULT 0 NOT NULL,
  "command_id" uuid,
  "dispatch_started_at" timestamp with time zone,
  "dispatch_accepted_at" timestamp with time zone,
  "pi_invocation_id" text,
  "event_cursor" bigint DEFAULT 0 NOT NULL,
  "last_activity_at" timestamp with time zone,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  "unknown_event_count" integer DEFAULT 0 NOT NULL,
  "malformed_event_count" integer DEFAULT 0 NOT NULL,
  "oversized_event_count" integer DEFAULT 0 NOT NULL,
  "last_error_code" text,
  "last_error_message" text,
  "last_error_action" "companion_runtime_error_action",
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_turn_attempts_org_companion_id_uq" UNIQUE ("org_id", "companion_id", "id"),
  CONSTRAINT "companion_turn_attempts_org_companion_turn_id_uq" UNIQUE ("org_id", "companion_id", "turn_id", "id"),
  CONSTRAINT "companion_turn_attempts_number_uq" UNIQUE ("turn_id", "attempt_number"),
  CONSTRAINT "companion_turn_attempts_number_check" CHECK ("attempt_number" >= 1),
  CONSTRAINT "companion_turn_attempts_actor_check" CHECK (
    char_length("actor_id") BETWEEN 1 AND 200 AND "actor_id" !~ E'[\\n\\r]'
  ),
  CONSTRAINT "companion_turn_attempts_runtime_check" CHECK (
    "runtime_generation" >= 1 AND "settings_revision" >= 1 AND "skills_revision" >= 1
    AND ("claim_epoch" IS NULL OR "claim_epoch" >= 1)
  ),
  CONSTRAINT "companion_turn_attempts_resource_snapshot_check" CHECK (
    ("model_id" IS NULL OR (char_length("model_id") BETWEEN 1 AND 200 AND "model_id" !~ E'[\\n\\r]'))
    AND ("persona" IS NULL OR char_length("persona") <= 280)
    AND jsonb_typeof("provider_ids") = 'array'
    AND jsonb_typeof("selected_skill_ids") = 'array'
    AND jsonb_typeof("skill_refs") = 'array'
    AND jsonb_typeof("selected_mcp_account_ids") = 'array'
  ),
  CONSTRAINT "companion_turn_attempts_checkpoint_check" CHECK (
    "checkpoint" IN (
      'starting', 'dispatch_write_intent', 'dispatch_accepted', 'dispatch_ambiguous',
      'dispatch_rejected', 'running', 'needs_input', 'event_projected', 'agent_settled'
    )
    AND "checkpoint_sequence" >= 0
  ),
  CONSTRAINT "companion_turn_attempts_dispatch_check" CHECK (
    "dispatch_count" >= 0
    AND (("dispatch_state" = 'pending' AND "command_id" IS NULL)
      OR ("dispatch_state" <> 'pending' AND "command_id" IS NOT NULL))
    AND ("dispatch_accepted_at" IS NULL OR "dispatch_state" = 'accepted')
  ),
  CONSTRAINT "companion_turn_attempts_pi_invocation_check" CHECK (
    "pi_invocation_id" IS NULL OR (char_length("pi_invocation_id") BETWEEN 1 AND 200 AND "pi_invocation_id" !~ E'[\\n\\r]')
  ),
  CONSTRAINT "companion_turn_attempts_progress_check" CHECK (
    "event_cursor" >= 0
    AND "unknown_event_count" >= 0
    AND "malformed_event_count" >= 0
    AND "oversized_event_count" >= 0
  ),
  CONSTRAINT "companion_turn_attempts_terminal_check" CHECK (
    ("status" IN ('succeeded', 'failed', 'interrupted', 'cancelled')) = ("settled_at" IS NOT NULL)
  ),
  CONSTRAINT "companion_turn_attempts_terminal_proof_check" CHECK (
    ("status" <> 'succeeded' OR (
      "checkpoint" = 'agent_settled'
      AND "dispatch_state" = 'accepted'
      AND "pi_invocation_id" IS NOT NULL
    ))
    AND ("dispatch_state" <> 'ambiguous' OR "status" NOT IN ('succeeded', 'failed', 'cancelled'))
    AND ("dispatch_state" <> 'rejected' OR "status" NOT IN ('succeeded', 'cancelled'))
  ),
  CONSTRAINT "companion_turn_attempts_error_check" CHECK (
    (("last_error_code" IS NULL) = ("last_error_message" IS NULL))
    AND (("last_error_code" IS NULL) = ("last_error_action" IS NULL))
    AND ("last_error_code" IS NULL OR "last_error_code" ~ '^[a-z][a-z0-9_]{0,63}$')
    AND ("last_error_message" IS NULL OR (char_length("last_error_message") <= 500 AND "last_error_message" !~ E'[\\n\\r]'))
    AND ("status" NOT IN ('failed', 'interrupted') OR "last_error_code" IS NOT NULL)
    AND ("status" NOT IN ('succeeded', 'cancelled') OR "last_error_code" IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "companion_turn_attempts_retry_uq"
  ON "companion_turn_attempts" ("companion_id", "retry_id") WHERE "retry_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "companion_turn_attempts_one_active_uq"
  ON "companion_turn_attempts" ("companion_id")
  WHERE "status" IN ('starting', 'dispatching', 'running', 'needs_input');
--> statement-breakpoint
CREATE INDEX "companion_turn_attempts_invocation_idx"
  ON "companion_turn_attempts" ("companion_id", "pi_invocation_id")
  WHERE "pi_invocation_id" IS NOT NULL;
--> statement-breakpoint

-- Pending operations are a real queue: several may wait, but a partial unique index permits only
-- one running operation per Companion. Actor provenance is retained without a user FK so member
-- deletion can never rewrite or cascade runtime authority history.
CREATE TABLE "companion_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "companion_id" uuid NOT NULL,
  "request_id" uuid,
  "kind" "companion_operation_kind" NOT NULL,
  "trigger" "companion_operation_trigger" NOT NULL,
  "status" "companion_operation_status" DEFAULT 'pending' NOT NULL,
  "actor_id" text NOT NULL,
  "source_turn_id" uuid,
  "queue_sequence" bigint NOT NULL,
  "turn_queue_cutoff" bigint NOT NULL,
  "runtime_generation" bigint NOT NULL,
  "client_surface" "companion_client_surface",
  "claim_epoch" bigint,
  "checkpoint" text DEFAULT 'pending' NOT NULL,
  "checkpoint_sequence" bigint DEFAULT 0 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "target_settings_revision" bigint,
  "target_skills_revision" integer,
  "model_id" text,
  "persona" text,
  "can_write_skills" boolean,
  "provider_ids" jsonb,
  "selected_skill_ids" jsonb,
  "skill_refs" jsonb,
  "selected_mcp_account_ids" jsonb,
  "provider_operation_id" text,
  "started_at" timestamp with time zone,
  "settled_at" timestamp with time zone,
  "last_error_code" text,
  "last_error_message" text,
  "last_error_action" "companion_runtime_error_action",
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_operations_org_companion_id_uq" UNIQUE ("org_id", "companion_id", "id"),
  CONSTRAINT "companion_operations_request_uq" UNIQUE ("companion_id", "request_id"),
  CONSTRAINT "companion_operations_queue_sequence_uq" UNIQUE ("companion_id", "queue_sequence"),
  CONSTRAINT "companion_operations_queue_sequence_check" CHECK (
    "queue_sequence" >= 1 AND "turn_queue_cutoff" >= 0
  ),
  CONSTRAINT "companion_operations_actor_check" CHECK (
    char_length("actor_id") BETWEEN 1 AND 200 AND "actor_id" !~ E'[\\n\\r]'
  ),
  CONSTRAINT "companion_operations_runtime_check" CHECK (
    "runtime_generation" >= 1 AND ("claim_epoch" IS NULL OR "claim_epoch" >= 1)
  ),
  CONSTRAINT "companion_operations_checkpoint_check" CHECK (
    "checkpoint" IN (
      'pending', 'resolving_box', 'box_resolved', 'box_absence_observed', 'creating_box',
      'box_created', 'waiting_ready', 'box_ready_observed', 'installing_layout',
      'starting_pi', 'pi_observed', 'pi_ready', 'stopping_pi', 'provider_stop_requested',
      'waiting_archived', 'box_archived', 'restarting_pi', 'restarting_box', 'applying_settings',
      'settings_applied', 'provider_delete_requested', 'waiting_deleted', 'provider_deleted',
      'box_absent', 'completed'
    )
    AND "checkpoint_sequence" >= 0
    AND "attempt_count" >= 0
  ),
  CONSTRAINT "companion_operations_target_revision_check" CHECK (
    ("target_settings_revision" IS NULL OR "target_settings_revision" >= 1)
    AND ("target_skills_revision" IS NULL OR "target_skills_revision" >= 1)
    AND (
      ("kind" IN ('start', 'restart_pi', 'restart_box', 'apply_settings')
        AND "target_settings_revision" IS NOT NULL
        AND "target_skills_revision" IS NOT NULL)
      OR ("kind" NOT IN ('start', 'restart_pi', 'restart_box', 'apply_settings')
        AND "target_settings_revision" IS NULL
        AND "target_skills_revision" IS NULL)
    )
  ),
  CONSTRAINT "companion_operations_resource_snapshot_check" CHECK (
    (
      "kind" IN ('start', 'restart_pi', 'restart_box', 'apply_settings')
      AND "client_surface" IS NOT NULL
      AND ("model_id" IS NULL OR (
        char_length("model_id") BETWEEN 1 AND 200 AND "model_id" !~ E'[\\n\\r]'
      ))
      AND ("persona" IS NULL OR char_length("persona") <= 280)
      AND "can_write_skills" IS NOT NULL
      AND jsonb_typeof("provider_ids") = 'array'
      AND jsonb_typeof("selected_skill_ids") = 'array'
      AND jsonb_typeof("skill_refs") = 'array'
      AND jsonb_typeof("selected_mcp_account_ids") = 'array'
    ) OR (
      "kind" NOT IN ('start', 'restart_pi', 'restart_box', 'apply_settings')
      AND "client_surface" IS NULL
      AND "model_id" IS NULL
      AND "persona" IS NULL
      AND "can_write_skills" IS NULL
      AND "provider_ids" IS NULL
      AND "selected_skill_ids" IS NULL
      AND "skill_refs" IS NULL
      AND "selected_mcp_account_ids" IS NULL
    )
  ),
  CONSTRAINT "companion_operations_provider_operation_check" CHECK (
    "provider_operation_id" IS NULL
    OR (char_length("provider_operation_id") BETWEEN 1 AND 200 AND "provider_operation_id" !~ E'[\\n\\r]')
  ),
  CONSTRAINT "companion_operations_terminal_check" CHECK (
    ("status" IN ('succeeded', 'failed', 'interrupted', 'cancelled')) = ("settled_at" IS NOT NULL)
  ),
  CONSTRAINT "companion_operations_terminal_proof_check" CHECK (
    "status" <> 'succeeded' OR (
      ("kind" IN ('start', 'restart_pi', 'restart_box') AND "checkpoint" = 'pi_ready')
      OR ("kind" = 'stop' AND "checkpoint" = 'box_archived')
      OR ("kind" = 'apply_settings' AND "checkpoint" = 'settings_applied')
      OR ("kind" = 'delete' AND "checkpoint" IN ('provider_deleted', 'box_absent'))
    )
  ),
  CONSTRAINT "companion_operations_explicit_destructive_trigger_check" CHECK (
    "kind" NOT IN ('restart_box', 'delete') OR "trigger" = 'user'
  ),
  CONSTRAINT "companion_operations_error_check" CHECK (
    (("last_error_code" IS NULL) = ("last_error_message" IS NULL))
    AND (("last_error_code" IS NULL) = ("last_error_action" IS NULL))
    AND ("last_error_code" IS NULL OR "last_error_code" ~ '^[a-z][a-z0-9_]{0,63}$')
    AND ("last_error_message" IS NULL OR (char_length("last_error_message") <= 500 AND "last_error_message" !~ E'[\\n\\r]'))
    AND ("status" NOT IN ('failed', 'interrupted') OR "last_error_code" IS NOT NULL)
    AND ("status" NOT IN ('succeeded', 'cancelled') OR "last_error_code" IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "companion_operations_one_running_uq"
  ON "companion_operations" ("companion_id") WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX "companion_operations_pending_idx"
  ON "companion_operations" ("available_at", "queue_sequence", "companion_id")
  WHERE "status" IN ('pending', 'running');
--> statement-breakpoint
CREATE UNIQUE INDEX "companion_operations_provider_operation_uq"
  ON "companion_operations" ("provider_operation_id") WHERE "provider_operation_id" IS NOT NULL;
--> statement-breakpoint

-- A row is both the stable identity of one Pi decision and the durable response-delivery outbox.
-- Multiple decisions may coexist for an attempt. Only the bounded human answer is retained; raw
-- provider requests/responses, credentials, and transport payloads are never stored here.
CREATE TABLE "companion_decision_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "companion_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "request_key" text NOT NULL,
  "decision_status" "companion_decision_status" DEFAULT 'pending' NOT NULL,
  "actor_id" text,
  "response_text" text,
  "responded_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "delivery_state" "companion_decision_delivery_state" DEFAULT 'pending' NOT NULL,
  "delivery_checkpoint" text DEFAULT 'pending' NOT NULL,
  "delivery_checkpoint_sequence" bigint DEFAULT 0 NOT NULL,
  "delivery_attempt_count" integer DEFAULT 0 NOT NULL,
  "claim_epoch" bigint,
  "command_id" uuid,
  "delivery_started_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "last_error_code" text,
  "last_error_message" text,
  "last_error_action" "companion_runtime_error_action",
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_decision_deliveries_org_companion_id_uq" UNIQUE ("org_id", "companion_id", "id"),
  CONSTRAINT "companion_decision_deliveries_request_uq" UNIQUE ("attempt_id", "request_key"),
  CONSTRAINT "companion_decision_deliveries_request_key_check" CHECK (
    char_length("request_key") BETWEEN 1 AND 200 AND "request_key" !~ E'[\\n\\r]'
  ),
  CONSTRAINT "companion_decision_deliveries_actor_check" CHECK (
    "actor_id" IS NULL OR (char_length("actor_id") BETWEEN 1 AND 200 AND "actor_id" !~ E'[\\n\\r]')
  ),
  CONSTRAINT "companion_decision_deliveries_response_check" CHECK (
    ("response_text" IS NULL OR octet_length("response_text") <= 16384)
    AND (
      ("decision_status" = 'pending' AND "actor_id" IS NULL AND "response_text" IS NULL AND "responded_at" IS NULL)
      OR ("decision_status" IN ('allowed', 'denied') AND "actor_id" IS NOT NULL AND "response_text" IS NULL AND "responded_at" IS NOT NULL)
      OR ("decision_status" = 'answered' AND "actor_id" IS NOT NULL AND "response_text" IS NOT NULL AND "responded_at" IS NOT NULL)
      OR ("decision_status" IN ('expired', 'cancelled') AND "response_text" IS NULL AND "responded_at" IS NOT NULL)
    )
  ),
  CONSTRAINT "companion_decision_deliveries_delivery_check" CHECK (
    "delivery_checkpoint" IN ('pending', 'write_intent', 'delivered', 'ambiguous', 'cancelled')
    AND "delivery_checkpoint_sequence" >= 0
    AND "delivery_attempt_count" >= 0
    AND ("claim_epoch" IS NULL OR "claim_epoch" >= 1)
    AND (("delivery_state" IN ('pending', 'cancelled') AND "command_id" IS NULL)
      OR ("delivery_state" IN ('write_intent', 'delivered', 'ambiguous') AND "command_id" IS NOT NULL))
    AND (("delivery_state" = 'delivered') = ("delivered_at" IS NOT NULL))
  ),
  CONSTRAINT "companion_decision_deliveries_error_check" CHECK (
    (("last_error_code" IS NULL) = ("last_error_message" IS NULL))
    AND (("last_error_code" IS NULL) = ("last_error_action" IS NULL))
    AND ("last_error_code" IS NULL OR "last_error_code" ~ '^[a-z][a-z0-9_]{0,63}$')
    AND ("last_error_message" IS NULL OR (char_length("last_error_message") <= 500 AND "last_error_message" !~ E'[\\n\\r]'))
  )
);
--> statement-breakpoint
CREATE INDEX "companion_decision_deliveries_pending_idx"
  ON "companion_decision_deliveries" ("created_at", "companion_id")
  WHERE "decision_status" <> 'pending' AND "delivery_state" NOT IN ('delivered', 'cancelled');
--> statement-breakpoint
CREATE INDEX "companion_decision_deliveries_expiry_idx"
  ON "companion_decision_deliveries" ("expires_at", "companion_id")
  WHERE "decision_status" = 'pending';
--> statement-breakpoint

-- Lease rows are retained when free so the epoch cannot return to zero. Every claim/takeover writes
-- a new UUID token and increments epoch; token+epoch+gate_epoch+work identity fence all mutations.
CREATE TABLE "companion_runtime_leases" (
  "org_id" uuid NOT NULL,
  "companion_id" uuid PRIMARY KEY NOT NULL,
  "claim_token" uuid,
  "claim_epoch" bigint DEFAULT 0 NOT NULL,
  "gate_epoch" bigint,
  "executor_id" text,
  "work_kind" "companion_runtime_work_kind",
  "work_id" uuid,
  "claimed_at" timestamp with time zone,
  "renewed_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "companion_runtime_leases_org_companion_uq" UNIQUE ("org_id", "companion_id"),
  CONSTRAINT "companion_runtime_leases_epoch_check" CHECK (
    "claim_epoch" >= 0 AND ("gate_epoch" IS NULL OR "gate_epoch" >= 1)
  ),
  CONSTRAINT "companion_runtime_leases_executor_check" CHECK (
    "executor_id" IS NULL OR (char_length("executor_id") BETWEEN 1 AND 200 AND "executor_id" !~ E'[\\n\\r]')
  ),
  CONSTRAINT "companion_runtime_leases_claim_check" CHECK (
    (
      "claim_token" IS NULL AND "gate_epoch" IS NULL AND "executor_id" IS NULL
      AND "work_kind" IS NULL AND "work_id" IS NULL AND "claimed_at" IS NULL
      AND "renewed_at" IS NULL AND "expires_at" IS NULL
    ) OR (
      "claim_token" IS NOT NULL AND "claim_epoch" >= 1 AND "gate_epoch" IS NOT NULL
      AND "executor_id" IS NOT NULL AND "work_kind" IS NOT NULL AND "work_id" IS NOT NULL
      AND "claimed_at" IS NOT NULL AND "renewed_at" IS NOT NULL AND "expires_at" IS NOT NULL
      AND "expires_at" > "renewed_at"
    )
  )
);
--> statement-breakpoint
CREATE INDEX "companion_runtime_leases_expiry_idx"
  ON "companion_runtime_leases" ("expires_at") WHERE "claim_token" IS NOT NULL;
--> statement-breakpoint

-- Aggregate ownership cascades from Companion -> instance -> work rows, so permanent deletion is
-- one atomic database action after provider proof. Every tenant edge retains org_id; nullable
-- reverse turn pointers remain restrictive and are explicitly cleared by proven delete settlement
-- before cascading the root. No actor column references the mutable member lifecycle; provenance
-- survives departure and is revalidated at each external-effect boundary.
ALTER TABLE "companion_runtime_instances"
  ADD CONSTRAINT "companion_runtime_instances_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "companion_runtime_instances"
  ADD CONSTRAINT "companion_runtime_instances_companion_fk"
  FOREIGN KEY ("org_id", "companion_id") REFERENCES "public"."companions"("org_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_turns"
  ADD CONSTRAINT "companion_turns_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "companion_turns"
  ADD CONSTRAINT "companion_turns_runtime_instance_fk"
  FOREIGN KEY ("org_id", "companion_id") REFERENCES "public"."companion_runtime_instances"("org_id", "companion_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_runtime_instances"
  ADD CONSTRAINT "companion_runtime_instances_settings_claim_turn_fk"
  FOREIGN KEY ("org_id", "companion_id", "settings_claim_turn_id")
  REFERENCES "public"."companion_turns"("org_id", "companion_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "companion_turn_attempts"
  ADD CONSTRAINT "companion_turn_attempts_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "companion_turn_attempts"
  ADD CONSTRAINT "companion_turn_attempts_runtime_instance_fk"
  FOREIGN KEY ("org_id", "companion_id") REFERENCES "public"."companion_runtime_instances"("org_id", "companion_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_turn_attempts"
  ADD CONSTRAINT "companion_turn_attempts_turn_fk"
  FOREIGN KEY ("org_id", "companion_id", "turn_id") REFERENCES "public"."companion_turns"("org_id", "companion_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_operations"
  ADD CONSTRAINT "companion_operations_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "companion_operations"
  ADD CONSTRAINT "companion_operations_runtime_instance_fk"
  FOREIGN KEY ("org_id", "companion_id") REFERENCES "public"."companion_runtime_instances"("org_id", "companion_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_operations"
  ADD CONSTRAINT "companion_operations_source_turn_fk"
  FOREIGN KEY ("org_id", "companion_id", "source_turn_id") REFERENCES "public"."companion_turns"("org_id", "companion_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "companion_decision_deliveries"
  ADD CONSTRAINT "companion_decision_deliveries_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "companion_decision_deliveries"
  ADD CONSTRAINT "companion_decision_deliveries_runtime_instance_fk"
  FOREIGN KEY ("org_id", "companion_id") REFERENCES "public"."companion_runtime_instances"("org_id", "companion_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_decision_deliveries"
  ADD CONSTRAINT "companion_decision_deliveries_turn_fk"
  FOREIGN KEY ("org_id", "companion_id", "turn_id") REFERENCES "public"."companion_turns"("org_id", "companion_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_decision_deliveries"
  ADD CONSTRAINT "companion_decision_deliveries_attempt_fk"
  FOREIGN KEY ("org_id", "companion_id", "turn_id", "attempt_id")
  REFERENCES "public"."companion_turn_attempts"("org_id", "companion_id", "turn_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "companion_runtime_leases"
  ADD CONSTRAINT "companion_runtime_leases_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "companion_runtime_leases"
  ADD CONSTRAINT "companion_runtime_leases_runtime_instance_fk"
  FOREIGN KEY ("org_id", "companion_id") REFERENCES "public"."companion_runtime_instances"("org_id", "companion_id") ON DELETE CASCADE;
--> statement-breakpoint

-- A permanent empty lease row is the first mutex for every Companion. Materializing it with the
-- instance lets claimers use FOR UPDATE SKIP LOCKED before touching the instance or any work row.
-- The control SHARE lock closes the lease set while disable holds control exclusively: an instance
-- created concurrently with disable cannot add an unscanned lease row until the new gate is visible.
CREATE FUNCTION public.companion_runtime_create_lease_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
  FROM public.companion_runtime_control c
  WHERE c.id = 'runtime-v2'
  FOR SHARE;

  INSERT INTO public.companion_runtime_leases (org_id, companion_id)
  VALUES (NEW.org_id, NEW.companion_id)
  ON CONFLICT ON CONSTRAINT companion_runtime_leases_pkey DO NOTHING;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "companion_runtime_instances_create_lease_row"
  AFTER INSERT ON "companion_runtime_instances"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_create_lease_row();
--> statement-breakpoint
INSERT INTO public.companion_runtime_leases (org_id, companion_id)
SELECT i.org_id, i.companion_id
FROM public.companion_runtime_instances i
ON CONFLICT ON CONSTRAINT companion_runtime_leases_pkey DO NOTHING;
--> statement-breakpoint

-- Runtime v2 is a one-way cutover. Old API/worker binaries may still hold explicit grants or call
-- legacy SECURITY DEFINER functions during a rolling deploy. The grant hook below removes those
-- capabilities; these triggers add a protocol assertion inside the aggregate. Every post-0090
-- Companion mutation must run inside a narrow v2 function, which pins this diagnostic GUC. The
-- table/function owner retains an operator escape hatch only when it is the real login and has not
-- SET ROLE to an application login. The GUC is not itself an authorization boundary.
CREATE FUNCTION public.companion_runtime_assert_v2_mutation()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_set_role text := current_setting('role', true);
BEGIN
  IF current_setting('app.companion_runtime_protocol', true) = '2'
     OR (
       session_user = current_user
       AND COALESCE(NULLIF(v_set_role, 'none'), '') = ''
     ) THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'legacy Companion mutation is fenced after Runtime v2 cutover'
    USING ERRCODE = '55000';
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_require_v2_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.companion_runtime_assert_v2_mutation();
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint

CREATE TRIGGER "companions_runtime_v2_mutation_fence"
  BEFORE INSERT OR UPDATE OR DELETE ON "companions"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_require_v2_mutation();
--> statement-breakpoint
CREATE TRIGGER "companion_runtime_pools_runtime_v2_mutation_fence"
  BEFORE INSERT OR UPDATE OR DELETE ON "companion_runtime_pools"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_require_v2_mutation();
--> statement-breakpoint
CREATE TRIGGER "companion_workspace_access_runtime_v2_mutation_fence"
  BEFORE INSERT OR UPDATE OR DELETE ON "companion_workspace_access"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_require_v2_mutation();
--> statement-breakpoint
CREATE TRIGGER "companion_member_state_runtime_v2_mutation_fence"
  BEFORE INSERT OR UPDATE OR DELETE ON "companion_member_state"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_require_v2_mutation();
--> statement-breakpoint
CREATE TRIGGER "companion_threads_runtime_v2_mutation_fence"
  BEFORE INSERT OR UPDATE OR DELETE ON "companion_threads"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_require_v2_mutation();
--> statement-breakpoint
CREATE TRIGGER "companion_transcript_entries_runtime_v2_mutation_fence"
  BEFORE INSERT OR UPDATE OR DELETE ON "companion_transcript_entries"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_require_v2_mutation();
--> statement-breakpoint
CREATE TRIGGER "companion_reconcile_leases_runtime_v2_mutation_fence"
  BEFORE INSERT OR UPDATE OR DELETE ON "companion_reconcile_leases"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_require_v2_mutation();
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_fence_legacy_token()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_set_role text := current_setting('role', true);
BEGIN
  IF (TG_OP <> 'INSERT' AND OLD.source_type = 'companion')
     OR (TG_OP <> 'DELETE' AND NEW.source_type = 'companion') THEN
    -- Runtime v2 never issues a Pi bearer token. Unlike the aggregate fence, there is therefore no
    -- protocol escape hatch: only a real owner/operator session may clean up legacy token rows.
    IF session_user <> current_user
       OR COALESCE(NULLIF(v_set_role, 'none'), '') <> '' THEN
      RAISE EXCEPTION 'legacy Companion token mutation is fenced after Runtime v2 cutover'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "api_tokens_companion_runtime_v2_mutation_fence"
  BEFORE INSERT OR UPDATE OF "source_type" OR DELETE ON "api_tokens"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_fence_legacy_token();
--> statement-breakpoint

-- A v2 Companion and its runtime projection are one atomic aggregate. This deferred direction is
-- required because the runtime_instance FK points to companions: the API inserts the parent first,
-- then the projection, and commit proves both exist. A legacy INSERT cannot satisfy this by itself.
CREATE FUNCTION public.companion_runtime_require_instance_at_commit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_set_role text := current_setting('role', true);
BEGIN
  IF session_user = current_user
     AND COALESCE(NULLIF(v_set_role, 'none'), '') = '' THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.companion_runtime_instances i
    WHERE i.org_id = NEW.org_id AND i.companion_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Runtime v2 Companion insert requires an atomic runtime instance'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "companions_require_runtime_v2_instance"
  AFTER INSERT ON "companions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_require_instance_at_commit();
--> statement-breakpoint

-- Allocation is database-owned: future narrow enqueue functions may pass any placeholder, but no
-- caller can reuse or reorder a sequence. The locked instance counter advances in the same commit
-- as the turn insert, so rollback returns both changes together.
CREATE FUNCTION public.companion_runtime_assign_turn_sequence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.companion_runtime_instances i
  SET next_turn_sequence = i.next_turn_sequence + 1,
      updated_at = statement_timestamp()
  WHERE i.org_id = NEW.org_id AND i.companion_id = NEW.companion_id
  RETURNING i.next_turn_sequence - 1 INTO NEW.queue_sequence;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'turn runtime instance does not exist' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "companion_turns_assign_queue_sequence"
  BEFORE INSERT ON "companion_turns"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_assign_turn_sequence();
--> statement-breakpoint

-- Operation ordering shares the same instance-row mutex as turn allocation. The operation's
-- monotonic sequence orders lifecycle intents, while turn_queue_cutoff is the exact accepted-turn
-- boundary at that serialization point. Stop/Restart can therefore fence older sends without
-- consuming a Send accepted after the lifecycle request.
CREATE FUNCTION public.companion_runtime_assign_operation_intent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.companion_runtime_instances i
  SET next_operation_sequence = i.next_operation_sequence + 1,
      updated_at = statement_timestamp()
  WHERE i.org_id = NEW.org_id AND i.companion_id = NEW.companion_id
  RETURNING i.next_operation_sequence - 1, i.next_turn_sequence - 1
  INTO NEW.queue_sequence, NEW.turn_queue_cutoff;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation runtime instance does not exist' USING ERRCODE = '23503';
  END IF;

  IF NEW.kind IN ('start', 'restart_pi', 'restart_box', 'apply_settings') THEN
    -- A turn-triggered lifecycle operation inherits the immutable send surface. Explicit user
    -- lifecycle intent has no source turn, so preserve the surface authorized by the API instead
    -- of silently widening native-mobile work to the web Skills/MCP profile.
    SELECT COALESCE(
      t.client_surface,
      NEW.client_surface,
      'web'::public.companion_client_surface
    )
    INTO NEW.client_surface
    FROM (SELECT 1) singleton
    LEFT JOIN public.companion_turns t
      ON t.org_id = NEW.org_id
     AND t.companion_id = NEW.companion_id
     AND t.id = NEW.source_turn_id;

    SELECT i.desired_settings_revision, c.skills_revision,
           c.model_id, c.persona, c.can_write_skills,
           c.provider_ids, c.selected_skill_ids, c.selected_mcp_account_ids
    INTO NEW.target_settings_revision, NEW.target_skills_revision,
         NEW.model_id, NEW.persona, NEW.can_write_skills,
         NEW.provider_ids, NEW.selected_skill_ids, NEW.selected_mcp_account_ids
    FROM public.companion_runtime_instances i
    JOIN public.companions c
      ON c.org_id = i.org_id AND c.id = i.companion_id
    WHERE i.org_id = NEW.org_id AND i.companion_id = NEW.companion_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'operation Companion does not exist' USING ERRCODE = '23503';
    END IF;

    IF NEW.client_surface = 'native_mobile' THEN
      NEW.can_write_skills := false;
      NEW.selected_skill_ids := '[]'::jsonb;
      NEW.selected_mcp_account_ids := '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'skill_id', s.id,
             'current_version_id', s.current_version_id
           ) ORDER BY s.id), '[]'::jsonb)
    INTO NEW.skill_refs
    FROM public.skills s
    WHERE s.org_id = NEW.org_id
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(NEW.selected_skill_ids) selected(skill_id)
        WHERE selected.skill_id = s.id::text
      );
  ELSE
    NEW.client_surface := NULL;
    NEW.target_settings_revision := NULL;
    NEW.target_skills_revision := NULL;
    NEW.model_id := NULL;
    NEW.persona := NULL;
    NEW.can_write_skills := NULL;
    NEW.provider_ids := NULL;
    NEW.selected_skill_ids := NULL;
    NEW.skill_refs := NULL;
    NEW.selected_mcp_account_ids := NULL;
  END IF;

  IF NEW.kind = 'start' AND NEW.source_turn_id IS NOT NULL THEN
    UPDATE public.companion_turns t
    SET cold_start_deadline_at = COALESCE(
          t.cold_start_deadline_at,
          t.created_at + interval '3 minutes'
        ),
        updated_at = statement_timestamp()
    WHERE t.org_id = NEW.org_id
      AND t.companion_id = NEW.companion_id
      AND t.id = NEW.source_turn_id
      AND t.status = 'queued';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cold-start source turn must be queued' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "companion_operations_assign_queue_sequence"
  BEFORE INSERT ON "companion_operations"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_assign_operation_intent();
--> statement-breakpoint

-- Pin immutable instructions, policy, and Skill version ids when an attempt is created. Renewals
-- still re-check that every selected Skill exists, is unarchived, and is visible to the actor, but
-- a settings edit or publication committed during the turn cannot change that attempt's inputs.
CREATE FUNCTION public.companion_runtime_assign_attempt_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_client_surface public.companion_client_surface;
BEGIN
  SELECT c.persona, t.client_surface
  INTO NEW.persona, v_client_surface
  FROM public.companions c
  JOIN public.companion_turns t
    ON t.org_id = c.org_id AND t.companion_id = c.id AND t.id = NEW.turn_id
  WHERE c.org_id = NEW.org_id AND c.id = NEW.companion_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt Companion turn does not exist' USING ERRCODE = '23503';
  END IF;

  IF v_client_surface = 'native_mobile' THEN
    NEW.can_write_skills := false;
    NEW.selected_skill_ids := '[]'::jsonb;
    NEW.selected_mcp_account_ids := '[]'::jsonb;
  ELSE
    SELECT c.can_write_skills INTO NEW.can_write_skills
    FROM public.companions c
    WHERE c.org_id = NEW.org_id AND c.id = NEW.companion_id;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'skill_id', s.id,
           'current_version_id', s.current_version_id
         ) ORDER BY s.id), '[]'::jsonb)
  INTO NEW.skill_refs
  FROM public.skills s
  WHERE s.org_id = NEW.org_id
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(NEW.selected_skill_ids) selected(skill_id)
      WHERE selected.skill_id = s.id::text
    );
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "companion_turn_attempts_assign_skill_refs"
  BEFORE INSERT ON "companion_turn_attempts"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_assign_attempt_snapshot();
--> statement-breakpoint

-- Runtime authority is historical evidence, not a mutable relation to the current user table.
-- These triggers prevent a row from being reassigned after creation while still allowing a
-- pending decision to record its first responder exactly once.
CREATE FUNCTION public.companion_runtime_reject_actor_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.actor_id IS DISTINCT FROM NEW.actor_id THEN
    RAISE EXCEPTION 'runtime actor_id is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "companion_turns_actor_immutable"
  BEFORE UPDATE OF "actor_id" ON "companion_turns"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_reject_actor_change();
--> statement-breakpoint
CREATE FUNCTION public.companion_runtime_reject_turn_surface_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.client_surface IS DISTINCT FROM NEW.client_surface THEN
    RAISE EXCEPTION 'runtime client_surface is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "companion_turns_surface_immutable"
  BEFORE UPDATE OF "client_surface" ON "companion_turns"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_reject_turn_surface_change();
--> statement-breakpoint
CREATE TRIGGER "companion_turn_attempts_actor_immutable"
  BEFORE UPDATE OF "actor_id" ON "companion_turn_attempts"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_reject_actor_change();
--> statement-breakpoint
CREATE FUNCTION public.companion_runtime_reject_attempt_snapshot_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.runtime_generation IS DISTINCT FROM NEW.runtime_generation
     OR OLD.settings_revision IS DISTINCT FROM NEW.settings_revision
     OR OLD.skills_revision IS DISTINCT FROM NEW.skills_revision
     OR OLD.model_id IS DISTINCT FROM NEW.model_id
     OR OLD.persona IS DISTINCT FROM NEW.persona
     OR OLD.can_write_skills IS DISTINCT FROM NEW.can_write_skills
     OR OLD.provider_ids IS DISTINCT FROM NEW.provider_ids
     OR OLD.selected_skill_ids IS DISTINCT FROM NEW.selected_skill_ids
     OR OLD.skill_refs IS DISTINCT FROM NEW.skill_refs
     OR OLD.selected_mcp_account_ids IS DISTINCT FROM NEW.selected_mcp_account_ids THEN
    RAISE EXCEPTION 'attempt resource snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "companion_turn_attempts_snapshot_immutable"
  BEFORE UPDATE OF "runtime_generation", "settings_revision", "skills_revision", "model_id",
    "persona", "can_write_skills", "provider_ids", "selected_skill_ids", "skill_refs",
    "selected_mcp_account_ids"
  ON "companion_turn_attempts"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_reject_attempt_snapshot_change();
--> statement-breakpoint
CREATE FUNCTION public.companion_runtime_reject_operation_snapshot_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.runtime_generation IS DISTINCT FROM NEW.runtime_generation
     OR OLD.target_settings_revision IS DISTINCT FROM NEW.target_settings_revision
     OR OLD.target_skills_revision IS DISTINCT FROM NEW.target_skills_revision
     OR OLD.client_surface IS DISTINCT FROM NEW.client_surface
     OR OLD.model_id IS DISTINCT FROM NEW.model_id
     OR OLD.persona IS DISTINCT FROM NEW.persona
     OR OLD.can_write_skills IS DISTINCT FROM NEW.can_write_skills
     OR OLD.provider_ids IS DISTINCT FROM NEW.provider_ids
     OR OLD.selected_skill_ids IS DISTINCT FROM NEW.selected_skill_ids
     OR OLD.skill_refs IS DISTINCT FROM NEW.skill_refs
     OR OLD.selected_mcp_account_ids IS DISTINCT FROM NEW.selected_mcp_account_ids THEN
    RAISE EXCEPTION 'operation resource snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "companion_operations_snapshot_immutable"
  BEFORE UPDATE OF "runtime_generation", "target_settings_revision", "target_skills_revision",
    "client_surface", "model_id", "persona", "can_write_skills", "provider_ids", "selected_skill_ids",
    "skill_refs", "selected_mcp_account_ids"
  ON "companion_operations"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_reject_operation_snapshot_change();
--> statement-breakpoint
CREATE TRIGGER "companion_operations_actor_immutable"
  BEFORE UPDATE OF "actor_id" ON "companion_operations"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_reject_actor_change();
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_reject_responder_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.actor_id IS NOT NULL AND OLD.actor_id IS DISTINCT FROM NEW.actor_id THEN
    RAISE EXCEPTION 'decision actor_id is immutable once recorded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "companion_decision_deliveries_actor_immutable"
  BEFORE UPDATE OF "actor_id" ON "companion_decision_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_reject_responder_change();
--> statement-breakpoint

-- Close every still-open decision when its parent attempt becomes terminal. A response with no
-- write intent is safely cancelled; a persisted write intent remains ambiguous evidence and is
-- never replayed. Delivered decisions remain untouched.
CREATE FUNCTION public.companion_runtime_close_attempt_decisions(
  p_org_id uuid,
  p_companion_id uuid,
  p_attempt_id uuid,
  p_error_code text,
  p_error_message text,
  p_error_action public.companion_runtime_error_action,
  p_excluded_delivery_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  UPDATE public.companion_decision_deliveries d
  SET decision_status = CASE
        WHEN d.decision_status = 'pending' THEN 'cancelled'::public.companion_decision_status
        ELSE d.decision_status
      END,
      responded_at = CASE
        WHEN d.decision_status = 'pending' THEN v_now
        ELSE d.responded_at
      END,
      delivery_state = CASE
        WHEN d.command_id IS NULL THEN 'cancelled'::public.companion_decision_delivery_state
        ELSE 'ambiguous'::public.companion_decision_delivery_state
      END,
      delivery_checkpoint = CASE WHEN d.command_id IS NULL THEN 'cancelled' ELSE 'ambiguous' END,
      delivery_checkpoint_sequence = d.delivery_checkpoint_sequence + 1,
      last_error_code = p_error_code,
      last_error_message = p_error_message,
      last_error_action = p_error_action,
      updated_at = v_now
  WHERE d.org_id = p_org_id
    AND d.companion_id = p_companion_id
    AND d.attempt_id = p_attempt_id
    AND (p_excluded_delivery_id IS NULL OR d.id <> p_excluded_delivery_id)
    AND d.delivery_state NOT IN ('delivered', 'cancelled');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_gate_status()
RETURNS TABLE (
  enabled boolean,
  gate_epoch bigint,
  updated_at timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.enabled, c.gate_epoch, c.updated_at
  FROM public.companion_runtime_control c
  WHERE c.id = 'runtime-v2'
$$;
--> statement-breakpoint

-- Disable is deliberately callable by the isolated runtime role. It atomically increments the
-- global epoch, interrupts active database work, and clears every token. A provider request that
-- was already on the wire may finish, but its executor can no longer checkpoint or settle it.
CREATE FUNCTION public.companion_runtime_disable(
  p_expected_gate_epoch bigint,
  p_actor_id text
)
RETURNS TABLE (
  enabled boolean,
  gate_epoch bigint,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_control public.companion_runtime_control%ROWTYPE;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_expected_gate_epoch IS NULL OR p_expected_gate_epoch < 1 THEN
    RAISE EXCEPTION 'invalid runtime gate epoch' USING ERRCODE = '22023';
  END IF;
  IF p_actor_id IS NULL
     OR char_length(p_actor_id) NOT BETWEEN 1 AND 200
     OR p_actor_id ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid runtime gate actor' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_control
  FROM public.companion_runtime_control c
  WHERE c.id = 'runtime-v2'
  FOR UPDATE;

  IF v_control.gate_epoch <> p_expected_gate_epoch THEN
    RAISE EXCEPTION 'runtime gate epoch is stale' USING ERRCODE = '40001';
  END IF;

  IF NOT v_control.enabled THEN
    RETURN QUERY SELECT false, v_control.gate_epoch, v_control.updated_at;
    RETURN;
  END IF;

  UPDATE public.companion_runtime_control c
  SET enabled = false,
      gate_epoch = c.gate_epoch + 1,
      enabled_at = NULL,
      disabled_at = v_now,
      changed_by = p_actor_id,
      updated_at = v_now
  WHERE c.id = 'runtime-v2'
  RETURNING c.* INTO v_control;

  -- Claims never lock control: disable instead closes the already-materialized lease set before
  -- touching work. Lock free rows too, otherwise a concurrent claimer could activate one after an
  -- active-only scan. The instance trigger cannot add another row while control is held here.
  PERFORM 1
  FROM public.companion_runtime_leases l
  ORDER BY l.org_id, l.companion_id
  FOR UPDATE;

  UPDATE public.companion_runtime_leases l
  SET claim_token = NULL,
      claim_epoch = l.claim_epoch + 1,
      gate_epoch = NULL,
      executor_id = NULL,
      work_kind = NULL,
      work_id = NULL,
      claimed_at = NULL,
      renewed_at = NULL,
      expires_at = NULL,
      updated_at = v_now
  WHERE l.claim_token IS NOT NULL;

  UPDATE public.companion_turn_attempts a
  SET status = 'interrupted',
      settled_at = v_now,
      last_error_code = 'runtime_gate_disabled',
      last_error_message = 'Runtime execution was disabled.',
      last_error_action = 'retry',
      updated_at = v_now
  WHERE a.status IN ('starting', 'dispatching', 'running', 'needs_input');

  UPDATE public.companion_turns t
  SET status = 'interrupted',
      settled_at = v_now,
      state_changed_at = v_now,
      absolute_deadline_at = COALESCE(t.absolute_deadline_at, v_now),
      last_error_code = 'runtime_gate_disabled',
      last_error_message = 'Runtime execution was disabled.',
      last_error_action = 'retry',
      updated_at = v_now
  WHERE t.status IN ('starting', 'dispatching', 'running', 'needs_input')
     OR (
       t.status = 'queued'
       AND EXISTS (
         SELECT 1
         FROM public.companion_operations source_start
         WHERE source_start.org_id = t.org_id
           AND source_start.companion_id = t.companion_id
           AND source_start.source_turn_id = t.id
           AND source_start.kind = 'start'
           AND source_start.status = 'running'
       )
     );

  UPDATE public.companion_operations o
  SET status = 'interrupted',
      settled_at = v_now,
      last_error_code = 'runtime_gate_disabled',
      last_error_message = 'Runtime execution was disabled.',
      last_error_action = 'retry',
      updated_at = v_now
  WHERE o.status = 'running';

  UPDATE public.companion_decision_deliveries d
  SET decision_status = CASE
        WHEN d.decision_status = 'pending' THEN 'cancelled'::public.companion_decision_status
        ELSE d.decision_status
      END,
      responded_at = CASE
        WHEN d.decision_status = 'pending' THEN v_now
        ELSE d.responded_at
      END,
      delivery_state = CASE
        WHEN d.command_id IS NULL THEN 'cancelled'::public.companion_decision_delivery_state
        ELSE 'ambiguous'::public.companion_decision_delivery_state
      END,
      delivery_checkpoint = CASE WHEN d.command_id IS NULL THEN 'cancelled' ELSE 'ambiguous' END,
      delivery_checkpoint_sequence = d.delivery_checkpoint_sequence + 1,
      last_error_code = 'runtime_gate_disabled',
      last_error_message = 'Runtime execution was disabled before response delivery completed.',
      last_error_action = 'retry',
      updated_at = v_now
  WHERE d.delivery_state NOT IN ('delivered', 'cancelled');

  RETURN QUERY SELECT v_control.enabled, v_control.gate_epoch, v_control.updated_at;
END
$$;
--> statement-breakpoint

-- Re-enabling is intentionally not a runtime capability. SECURITY INVOKER plus the explicit owner
-- check and absence of role grants mean only the migration/database owner may cross this boundary.
CREATE FUNCTION public.companion_runtime_enable(
  p_expected_gate_epoch bigint,
  p_actor_id text
)
RETURNS TABLE (
  enabled boolean,
  gate_epoch bigint,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_owner name;
  v_control public.companion_runtime_control%ROWTYPE;
  v_now timestamp with time zone := statement_timestamp();
BEGIN
  SELECT pg_get_userbyid(p.proowner) INTO v_owner
  FROM pg_proc p
  WHERE p.oid = 'public.companion_runtime_enable(bigint,text)'::regprocedure;

  IF current_user <> v_owner THEN
    RAISE EXCEPTION 'only the Runtime v2 function owner may enable execution'
      USING ERRCODE = '42501';
  END IF;
  IF p_expected_gate_epoch IS NULL OR p_expected_gate_epoch < 1 THEN
    RAISE EXCEPTION 'invalid runtime gate epoch' USING ERRCODE = '22023';
  END IF;
  IF p_actor_id IS NULL
     OR char_length(p_actor_id) NOT BETWEEN 1 AND 200
     OR p_actor_id ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid runtime gate actor' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_control
  FROM public.companion_runtime_control c
  WHERE c.id = 'runtime-v2'
  FOR UPDATE;

  IF v_control.gate_epoch <> p_expected_gate_epoch THEN
    RAISE EXCEPTION 'runtime gate epoch is stale' USING ERRCODE = '40001';
  END IF;
  IF v_control.enabled THEN
    RETURN QUERY SELECT true, v_control.gate_epoch, v_control.updated_at;
    RETURN;
  END IF;

  UPDATE public.companion_runtime_control c
  SET enabled = true,
      gate_epoch = c.gate_epoch + 1,
      enabled_at = v_now,
      disabled_at = NULL,
      changed_by = p_actor_id,
      updated_at = v_now
  WHERE c.id = 'runtime-v2'
  RETURNING c.* INTO v_control;

  RETURN QUERY SELECT v_control.enabled, v_control.gate_epoch, v_control.updated_at;
END
$$;
--> statement-breakpoint

-- Claim exactly one serial work item per Companion. Priority is global and explicit:
-- delete -> explicit lifecycle -> decision response/expiration -> active attempt -> settings ->
-- oldest queued turn -> health. Every isolated runtime replica calls this same function.
CREATE FUNCTION public.companion_runtime_claim_work(
  p_executor_id text,
  p_limit integer,
  p_lease_seconds integer,
  p_gate_epoch bigint
)
RETURNS TABLE (
  org_id uuid,
  companion_id uuid,
  claim_token uuid,
  claim_epoch bigint,
  gate_epoch bigint,
  work_kind public.companion_runtime_work_kind,
  work_id uuid,
  actor_id text,
  client_surface public.companion_client_surface,
  runtime_generation bigint,
  checkpoint text,
  checkpoint_sequence bigint,
  turn_id uuid,
  turn_status public.companion_turn_status,
  attempt_status public.companion_attempt_status,
  dispatch_state public.companion_dispatch_state,
  event_cursor bigint,
  unknown_event_count integer,
  malformed_event_count integer,
  oversized_event_count integer,
  cold_start_deadline_at timestamp with time zone,
  inactivity_deadline_at timestamp with time zone,
  absolute_deadline_at timestamp with time zone,
  operation_kind public.companion_operation_kind,
  operation_started_at timestamp with time zone,
  operation_attempt_count integer,
  provider_operation_id text,
  target_settings_revision bigint,
  target_skills_revision integer,
  decision_status public.companion_decision_status,
  decision_delivery_state public.companion_decision_delivery_state
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_enabled boolean;
  v_actual_gate_epoch bigint;
  v_org_id uuid;
  v_companion_id uuid;
  v_generation bigint;
  v_work_kind public.companion_runtime_work_kind;
  v_work_id uuid;
  v_actor_id text;
  v_client_surface public.companion_client_surface;
  v_checkpoint text;
  v_checkpoint_sequence bigint;
  v_claim_token uuid;
  v_claim_epoch bigint;
  v_turn_id uuid;
  v_decision_attempt_id uuid;
  v_attempt_number integer;
  v_operation_kind public.companion_operation_kind;
  v_operation_started_at timestamp with time zone;
  v_operation_attempt_count integer;
  v_operation_queue_sequence bigint;
  v_operation_turn_queue_cutoff bigint;
  v_companion_owner_id text;
  v_operation_actor_authorized boolean;
  v_provider_operation_id text;
  v_target_settings_revision bigint;
  v_target_skills_revision integer;
  v_model_id text;
  v_provider_ids jsonb;
  v_selected_skill_ids jsonb;
  v_selected_mcp_account_ids jsonb;
  v_skills_revision integer;
  v_turn_status public.companion_turn_status;
  v_attempt_status public.companion_attempt_status;
  v_dispatch_state public.companion_dispatch_state;
  v_event_cursor bigint;
  v_unknown_event_count integer;
  v_malformed_event_count integer;
  v_oversized_event_count integer;
  v_cold_start_deadline_at timestamp with time zone;
  v_inactivity_deadline_at timestamp with time zone;
  v_absolute_deadline_at timestamp with time zone;
  v_decision_status public.companion_decision_status;
  v_decision_delivery_state public.companion_decision_delivery_state;
  v_now timestamp with time zone;
  v_claimed integer := 0;
  v_examined_companion_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_gate_epoch IS NULL
     OR p_gate_epoch < 1
     OR p_executor_id IS NULL
     OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
     OR p_executor_id ~ E'[\n\r]'
     OR p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds IS NULL
     OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v2 claim arguments' USING ERRCODE = '22023';
  END IF;

  SELECT c.enabled, c.gate_epoch
  INTO v_enabled, v_actual_gate_epoch
  FROM public.companion_runtime_control c
  WHERE c.id = 'runtime-v2';

  IF NOT COALESCE(v_enabled, false) OR v_actual_gate_epoch <> p_gate_epoch THEN
    RETURN;
  END IF;

  WHILE v_claimed < p_limit LOOP
    v_now := clock_timestamp();
    v_org_id := NULL;
    v_companion_id := NULL;
    v_generation := NULL;
    v_client_surface := NULL;

    -- The durable lease row is the first mutex. SKIP LOCKED keeps bulk/multi-replica claims from
    -- ever waiting on another lease while already holding earlier leases in this transaction.
    SELECT i.org_id, i.companion_id
    INTO v_org_id, v_companion_id
    FROM public.companion_runtime_instances i
    JOIN public.companion_runtime_leases l
      ON l.org_id = i.org_id AND l.companion_id = i.companion_id
    WHERE i.retirement_state <> 'retired'
      AND (l.claim_token IS NULL OR l.expires_at <= v_now)
      AND NOT (i.companion_id = ANY(v_examined_companion_ids))
      AND (
        EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.status IN ('pending', 'running') AND o.available_at <= v_now
            AND (
              o.kind <> 'apply_settings'
              OR i.box_state IN ('ready', 'idle', 'running')
              OR EXISTS (
                SELECT 1 FROM public.companion_turns settings_turn
                WHERE settings_turn.org_id = i.org_id
                  AND settings_turn.companion_id = i.companion_id
                  AND settings_turn.status = 'queued'
              )
            )
        )
        OR EXISTS (
          SELECT 1 FROM public.companion_decision_deliveries d
          WHERE d.org_id = i.org_id AND d.companion_id = i.companion_id
            AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
            AND (d.decision_status <> 'pending' OR d.expires_at <= v_now)
            AND EXISTS (
              SELECT 1 FROM public.companion_turn_attempts decision_attempt
              WHERE decision_attempt.org_id = d.org_id
                AND decision_attempt.companion_id = d.companion_id
                AND decision_attempt.turn_id = d.turn_id
                AND decision_attempt.id = d.attempt_id
                AND decision_attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
            )
        )
        OR EXISTS (
          SELECT 1 FROM public.companion_turn_attempts a
          WHERE a.org_id = i.org_id AND a.companion_id = i.companion_id
            AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
        )
        OR (
          (
            i.desired_settings_revision > i.applied_settings_revision
            OR EXISTS (
              SELECT 1 FROM public.companion_turns profile_turn
              WHERE profile_turn.org_id = i.org_id
                AND profile_turn.companion_id = i.companion_id
                AND profile_turn.status = 'queued'
                AND NOT EXISTS (
                  SELECT 1 FROM public.companion_turns earlier_turn
                  WHERE earlier_turn.org_id = profile_turn.org_id
                    AND earlier_turn.companion_id = profile_turn.companion_id
                    AND earlier_turn.status = 'queued'
                    AND earlier_turn.queue_sequence < profile_turn.queue_sequence
                )
                AND (
                  (profile_turn.client_surface = 'native_mobile'
                    AND i.applied_client_surface IS DISTINCT FROM 'native_mobile')
                  OR (profile_turn.client_surface <> 'native_mobile'
                    AND (i.applied_client_surface IS NULL
                      OR i.applied_client_surface = 'native_mobile'))
                )
            )
            OR (
              EXISTS (
                SELECT 1 FROM public.companions settings_companion
                WHERE settings_companion.org_id = i.org_id
                  AND settings_companion.id = i.companion_id
                  AND settings_companion.skills_revision > i.applied_skills_revision
              )
              AND EXISTS (
                SELECT 1 FROM public.companion_turns settings_turn
                WHERE settings_turn.org_id = i.org_id
                  AND settings_turn.companion_id = i.companion_id
                  AND settings_turn.status = 'queued'
                  AND settings_turn.client_surface <> 'native_mobile'
                  AND NOT EXISTS (
                    SELECT 1 FROM public.companion_turns earlier_turn
                    WHERE earlier_turn.org_id = settings_turn.org_id
                      AND earlier_turn.companion_id = settings_turn.companion_id
                      AND earlier_turn.status = 'queued'
                      AND earlier_turn.queue_sequence < settings_turn.queue_sequence
                  )
              )
            )
          )
          AND i.settings_actor_id IS NOT NULL
          AND i.settings_available_at <= v_now
          AND (
            i.box_state IN ('ready', 'idle', 'running')
            OR EXISTS (
              SELECT 1 FROM public.companion_turns settings_turn
              WHERE settings_turn.org_id = i.org_id
                AND settings_turn.companion_id = i.companion_id
                AND settings_turn.status = 'queued'
            )
          )
        )
        OR (
          EXISTS (
            SELECT 1 FROM public.companion_turns t
            WHERE t.org_id = i.org_id AND t.companion_id = i.companion_id
              AND t.status = 'queued'
              AND (
                (t.client_surface = 'native_mobile'
                  AND i.applied_client_surface = 'native_mobile')
                OR (t.client_surface <> 'native_mobile'
                  AND i.applied_client_surface IS NOT NULL
                  AND i.applied_client_surface <> 'native_mobile'
                  AND EXISTS (
                  SELECT 1 FROM public.companions queued_companion
                  WHERE queued_companion.org_id = i.org_id
                    AND queued_companion.id = i.companion_id
                    AND queued_companion.skills_revision = i.applied_skills_revision
                  ))
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.companion_turns earlier_turn
                WHERE earlier_turn.org_id = t.org_id
                  AND earlier_turn.companion_id = t.companion_id
                  AND earlier_turn.status = 'queued'
                  AND earlier_turn.queue_sequence < t.queue_sequence
              )
          )
          AND i.desired_settings_revision = i.applied_settings_revision
          AND NOT EXISTS (
            SELECT 1 FROM public.companion_turns active_turn
            WHERE active_turn.org_id = i.org_id
              AND active_turn.companion_id = i.companion_id
              AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
          )
        )
        OR (i.health_due_at <= v_now AND i.retirement_state <> 'retired')
      )
    ORDER BY
      CASE
        WHEN EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.kind = 'delete' AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        ) THEN 10
        WHEN EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.kind IN ('stop', 'restart_pi', 'restart_box')
            AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        ) THEN 20
        WHEN EXISTS (
          SELECT 1 FROM public.companion_decision_deliveries d
          WHERE d.org_id = i.org_id AND d.companion_id = i.companion_id
            AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
            AND (d.decision_status <> 'pending' OR d.expires_at <= v_now)
            AND EXISTS (
              SELECT 1 FROM public.companion_turn_attempts decision_attempt
              WHERE decision_attempt.org_id = d.org_id
                AND decision_attempt.companion_id = d.companion_id
                AND decision_attempt.turn_id = d.turn_id
                AND decision_attempt.id = d.attempt_id
                AND decision_attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
            )
        ) THEN 30
        WHEN EXISTS (
          SELECT 1 FROM public.companion_turn_attempts a
          WHERE a.org_id = i.org_id AND a.companion_id = i.companion_id
            AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
        ) THEN 40
        WHEN EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.kind = 'start' AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        ) THEN 45
        WHEN EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.kind = 'apply_settings' AND o.status IN ('pending', 'running') AND o.available_at <= v_now
            AND (
              i.box_state IN ('ready', 'idle', 'running')
              OR EXISTS (
                SELECT 1 FROM public.companion_turns settings_turn
                WHERE settings_turn.org_id = i.org_id
                  AND settings_turn.companion_id = i.companion_id
                  AND settings_turn.status = 'queued'
              )
            )
        ) OR (
          (
            i.desired_settings_revision > i.applied_settings_revision
            OR EXISTS (
              SELECT 1 FROM public.companion_turns profile_turn
              WHERE profile_turn.org_id = i.org_id
                AND profile_turn.companion_id = i.companion_id
                AND profile_turn.status = 'queued'
                AND NOT EXISTS (
                  SELECT 1 FROM public.companion_turns earlier_turn
                  WHERE earlier_turn.org_id = profile_turn.org_id
                    AND earlier_turn.companion_id = profile_turn.companion_id
                    AND earlier_turn.status = 'queued'
                    AND earlier_turn.queue_sequence < profile_turn.queue_sequence
                )
                AND (
                  (profile_turn.client_surface = 'native_mobile'
                    AND i.applied_client_surface IS DISTINCT FROM 'native_mobile')
                  OR (profile_turn.client_surface <> 'native_mobile'
                    AND (i.applied_client_surface IS NULL
                      OR i.applied_client_surface = 'native_mobile'))
                )
            )
            OR (
              EXISTS (
                SELECT 1 FROM public.companions settings_companion
                WHERE settings_companion.org_id = i.org_id
                  AND settings_companion.id = i.companion_id
                  AND settings_companion.skills_revision > i.applied_skills_revision
              )
              AND EXISTS (
                SELECT 1 FROM public.companion_turns settings_turn
                WHERE settings_turn.org_id = i.org_id
                  AND settings_turn.companion_id = i.companion_id
                  AND settings_turn.status = 'queued'
                  AND settings_turn.client_surface <> 'native_mobile'
                  AND NOT EXISTS (
                    SELECT 1 FROM public.companion_turns earlier_turn
                    WHERE earlier_turn.org_id = settings_turn.org_id
                      AND earlier_turn.companion_id = settings_turn.companion_id
                      AND earlier_turn.status = 'queued'
                      AND earlier_turn.queue_sequence < settings_turn.queue_sequence
                  )
              )
            )
          )
          AND i.settings_actor_id IS NOT NULL
          AND i.settings_available_at <= v_now
          AND (
            i.box_state IN ('ready', 'idle', 'running')
            OR EXISTS (
              SELECT 1 FROM public.companion_turns settings_turn
              WHERE settings_turn.org_id = i.org_id
                AND settings_turn.companion_id = i.companion_id
                AND settings_turn.status = 'queued'
            )
          )
        ) THEN 50
        WHEN EXISTS (
          SELECT 1 FROM public.companion_turns t
          WHERE t.org_id = i.org_id AND t.companion_id = i.companion_id AND t.status = 'queued'
            AND (
              (t.client_surface = 'native_mobile'
                AND i.applied_client_surface = 'native_mobile')
              OR (t.client_surface <> 'native_mobile'
                AND i.applied_client_surface IS NOT NULL
                AND i.applied_client_surface <> 'native_mobile'
                AND EXISTS (
                SELECT 1 FROM public.companions queued_companion
                WHERE queued_companion.org_id = i.org_id
                  AND queued_companion.id = i.companion_id
                  AND queued_companion.skills_revision = i.applied_skills_revision
                ))
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.companion_turns earlier_turn
              WHERE earlier_turn.org_id = t.org_id
                AND earlier_turn.companion_id = t.companion_id
                AND earlier_turn.status = 'queued'
                AND earlier_turn.queue_sequence < t.queue_sequence
            )
        ) AND i.desired_settings_revision = i.applied_settings_revision
          AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns blocking_turn
          WHERE blocking_turn.org_id = i.org_id
            AND blocking_turn.companion_id = i.companion_id
            AND blocking_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
        ) THEN 60
        ELSE 70
      END,
      i.health_due_at,
      i.companion_id
    FOR UPDATE OF l SKIP LOCKED
    LIMIT 1;

    EXIT WHEN v_companion_id IS NULL;
    v_examined_companion_ids := array_append(v_examined_companion_ids, v_companion_id);

    -- Revalidate after winning the lease mutex. If disable committed between the optimistic read
    -- above and this lock, no old-epoch claim is materialized. If disable is still in flight, it
    -- waits on this lease and clears the completed claim before publishing the disabled gate.
    SELECT c.enabled, c.gate_epoch
    INTO v_enabled, v_actual_gate_epoch
    FROM public.companion_runtime_control c
    WHERE c.id = 'runtime-v2';
    IF NOT COALESCE(v_enabled, false) OR v_actual_gate_epoch <> p_gate_epoch THEN
      RETURN;
    END IF;

    -- Instance and work locks always follow the lease mutex. Recheck retirement after waiting for
    -- an API-side instance update; no work is selected from the optimistic candidate snapshot.
    SELECT i.generation
    INTO v_generation
    FROM public.companion_runtime_instances i
    WHERE i.org_id = v_org_id
      AND i.companion_id = v_companion_id
      AND i.retirement_state <> 'retired'
    FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_work_kind := NULL;
    v_work_id := NULL;
    v_actor_id := NULL;
    v_checkpoint := NULL;
    v_checkpoint_sequence := 0;
    v_turn_id := NULL;
    v_decision_attempt_id := NULL;
    v_operation_kind := NULL;
    v_operation_started_at := NULL;
    v_operation_attempt_count := NULL;
    v_operation_queue_sequence := NULL;
    v_operation_turn_queue_cutoff := NULL;
    v_provider_operation_id := NULL;
    v_target_settings_revision := NULL;
    v_target_skills_revision := NULL;

    SELECT o.id, o.actor_id, o.checkpoint, o.checkpoint_sequence, o.kind,
           o.queue_sequence, o.turn_queue_cutoff
    INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence, v_operation_kind,
         v_operation_queue_sequence, v_operation_turn_queue_cutoff
    FROM public.companion_operations o
    WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
      AND o.kind = 'delete' AND o.status IN ('pending', 'running') AND o.available_at <= v_now
    ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
    LIMIT 1
    FOR UPDATE;
    IF FOUND THEN
      v_work_kind := 'operation';
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT o.id, o.actor_id, o.checkpoint, o.checkpoint_sequence, o.kind,
             o.queue_sequence, o.turn_queue_cutoff
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence, v_operation_kind,
           v_operation_queue_sequence, v_operation_turn_queue_cutoff
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.kind IN ('stop', 'restart_pi', 'restart_box')
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now
      ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'operation'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT d.id, d.actor_id, d.delivery_checkpoint, d.delivery_checkpoint_sequence,
             d.attempt_id
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence,
           v_decision_attempt_id
      FROM public.companion_decision_deliveries d
      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id
        AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
        AND (d.decision_status <> 'pending' OR d.expires_at <= v_now)
        AND EXISTS (
          SELECT 1 FROM public.companion_turn_attempts decision_attempt
          WHERE decision_attempt.org_id = d.org_id
            AND decision_attempt.companion_id = d.companion_id
            AND decision_attempt.turn_id = d.turn_id
            AND decision_attempt.id = d.attempt_id
            AND decision_attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
        )
      ORDER BY d.created_at, d.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'decision'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT a.id, a.actor_id, a.checkpoint, a.checkpoint_sequence
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence
      FROM public.companion_turn_attempts a
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
        AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
      ORDER BY a.created_at, a.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'attempt'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT o.id, o.actor_id, o.checkpoint, o.checkpoint_sequence, o.kind,
             o.queue_sequence, o.turn_queue_cutoff
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence, v_operation_kind,
           v_operation_queue_sequence, v_operation_turn_queue_cutoff
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.kind = 'start'
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now
      ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'operation'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT o.id, o.actor_id, o.checkpoint, o.checkpoint_sequence, o.kind,
             o.queue_sequence, o.turn_queue_cutoff
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence, v_operation_kind,
           v_operation_queue_sequence, v_operation_turn_queue_cutoff
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.kind = 'apply_settings'
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        AND (
          EXISTS (
            SELECT 1 FROM public.companion_runtime_instances warm_instance
            WHERE warm_instance.org_id = o.org_id
              AND warm_instance.companion_id = o.companion_id
              AND warm_instance.box_state IN ('ready', 'idle', 'running')
          )
          OR EXISTS (
            SELECT 1 FROM public.companion_turns settings_turn
            WHERE settings_turn.org_id = o.org_id
              AND settings_turn.companion_id = o.companion_id
              AND settings_turn.status = 'queued'
          )
        )
      ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'operation'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT i.settings_actor_id, i.settings_checkpoint, i.settings_checkpoint_sequence
      INTO v_actor_id, v_checkpoint, v_checkpoint_sequence
      FROM public.companion_runtime_instances i
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND (
          i.desired_settings_revision > i.applied_settings_revision
          OR EXISTS (
            SELECT 1 FROM public.companion_turns profile_turn
            WHERE profile_turn.org_id = i.org_id
              AND profile_turn.companion_id = i.companion_id
              AND profile_turn.status = 'queued'
              AND NOT EXISTS (
                SELECT 1 FROM public.companion_turns earlier_turn
                WHERE earlier_turn.org_id = profile_turn.org_id
                  AND earlier_turn.companion_id = profile_turn.companion_id
                  AND earlier_turn.status = 'queued'
                  AND earlier_turn.queue_sequence < profile_turn.queue_sequence
              )
              AND (
                (profile_turn.client_surface = 'native_mobile'
                  AND i.applied_client_surface IS DISTINCT FROM 'native_mobile')
                OR (profile_turn.client_surface <> 'native_mobile'
                  AND (i.applied_client_surface IS NULL
                    OR i.applied_client_surface = 'native_mobile'))
              )
          )
          OR (
            EXISTS (
              SELECT 1 FROM public.companions settings_companion
              WHERE settings_companion.org_id = i.org_id
                AND settings_companion.id = i.companion_id
                AND settings_companion.skills_revision > i.applied_skills_revision
            )
            AND EXISTS (
              SELECT 1 FROM public.companion_turns settings_turn
              WHERE settings_turn.org_id = i.org_id
                AND settings_turn.companion_id = i.companion_id
                AND settings_turn.status = 'queued'
                AND settings_turn.client_surface <> 'native_mobile'
                AND NOT EXISTS (
                  SELECT 1 FROM public.companion_turns earlier_turn
                  WHERE earlier_turn.org_id = settings_turn.org_id
                    AND earlier_turn.companion_id = settings_turn.companion_id
                    AND earlier_turn.status = 'queued'
                    AND earlier_turn.queue_sequence < settings_turn.queue_sequence
                )
            )
          )
        )
        AND i.settings_actor_id IS NOT NULL AND i.settings_available_at <= v_now
        AND (
          i.box_state IN ('ready', 'idle', 'running')
          OR EXISTS (
            SELECT 1 FROM public.companion_turns settings_turn
            WHERE settings_turn.org_id = i.org_id
              AND settings_turn.companion_id = i.companion_id
              AND settings_turn.status = 'queued'
          )
        );
      IF FOUND THEN
        v_work_kind := 'settings';
        v_work_id := v_companion_id;
      END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT t.id, t.actor_id
      INTO v_turn_id, v_actor_id
      FROM public.companion_turns t
      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id AND t.status = 'queued'
        AND EXISTS (
          SELECT 1
          FROM public.companion_runtime_instances queue_instance
          JOIN public.companions queue_companion
            ON queue_companion.org_id = queue_instance.org_id
           AND queue_companion.id = queue_instance.companion_id
          WHERE queue_instance.org_id = t.org_id
            AND queue_instance.companion_id = t.companion_id
            AND queue_instance.desired_settings_revision = queue_instance.applied_settings_revision
            AND (
              (t.client_surface = 'native_mobile'
                AND queue_instance.applied_client_surface = 'native_mobile')
              OR (t.client_surface <> 'native_mobile'
                AND queue_instance.applied_client_surface IS NOT NULL
                AND queue_instance.applied_client_surface <> 'native_mobile'
                AND queue_companion.skills_revision = queue_instance.applied_skills_revision)
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns earlier_turn
          WHERE earlier_turn.org_id = t.org_id
            AND earlier_turn.companion_id = t.companion_id
            AND earlier_turn.status = 'queued'
            AND earlier_turn.queue_sequence < t.queue_sequence
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns active_turn
          WHERE active_turn.org_id = v_org_id
            AND active_turn.companion_id = v_companion_id
            AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
        )
      ORDER BY t.queue_sequence, t.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN
        v_work_kind := 'attempt';
        v_work_id := gen_random_uuid();
        v_checkpoint := 'starting';
        v_checkpoint_sequence := 0;
        SELECT COALESCE(MAX(a.attempt_number), 0) + 1
        INTO v_attempt_number
        FROM public.companion_turn_attempts a
        WHERE a.turn_id = v_turn_id;
        SELECT c.model_id, c.provider_ids, c.selected_skill_ids,
               c.selected_mcp_account_ids, c.skills_revision
        INTO v_model_id, v_provider_ids, v_selected_skill_ids,
             v_selected_mcp_account_ids, v_skills_revision
        FROM public.companions c
        WHERE c.org_id = v_org_id AND c.id = v_companion_id;
      END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT 'health'::public.companion_runtime_work_kind, i.companion_id,
             i.health_checkpoint, i.health_checkpoint_sequence
      INTO v_work_kind, v_work_id, v_checkpoint, v_checkpoint_sequence
      FROM public.companion_runtime_instances i
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND i.health_due_at <= v_now AND i.retirement_state <> 'retired';
    END IF;

    -- A concurrent insert can make the selected instance no longer eligible. Continue rather than
    -- inventing work; the next sweep will see the new authoritative priority.
    IF v_work_kind IS NULL OR v_work_id IS NULL THEN
      CONTINUE;
    END IF;

    -- Pi prompt and decision write intents below are ambiguous after lease loss because they have
    -- no provider-side lookup identity. Box create is intentionally different: `creating_box`
    -- carries a deterministic generation-qualified name, so takeover reclaims this same operation,
    -- lists that exact name, and adopts the canonical Box without replaying the create POST.
    IF v_work_kind = 'attempt'
       AND v_turn_id IS NULL
       AND v_checkpoint IN ('dispatch_write_intent', 'dispatch_ambiguous') THEN
      SELECT a.turn_id INTO v_turn_id
      FROM public.companion_turn_attempts a
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id AND a.id = v_work_id;

      PERFORM public.companion_runtime_close_attempt_decisions(
        v_org_id, v_companion_id, v_work_id,
        'dispatch_ack_unknown',
        'Pi prompt acceptance is unknown after the dispatch lease was lost.',
        'retry'::public.companion_runtime_error_action,
        NULL
      );
      UPDATE public.companion_turn_attempts a
      SET status = 'interrupted', dispatch_state = 'ambiguous',
          checkpoint = 'dispatch_ambiguous',
          checkpoint_sequence = a.checkpoint_sequence
            + CASE WHEN a.checkpoint = 'dispatch_ambiguous' THEN 0 ELSE 1 END,
          settled_at = v_now,
          last_error_code = 'dispatch_ack_unknown',
          last_error_message = 'Pi prompt acceptance is unknown after the dispatch lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
        AND a.id = v_work_id
        AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
        AND a.dispatch_state IN ('write_intent', 'ambiguous');
      UPDATE public.companion_turns t
      SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
          last_error_code = 'dispatch_ack_unknown',
          last_error_message = 'Pi prompt acceptance is unknown after the dispatch lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
        AND t.id = v_turn_id
        AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');

      UPDATE public.companion_runtime_leases l
      SET claim_token = NULL, claim_epoch = l.claim_epoch + 1, gate_epoch = NULL,
          executor_id = NULL, work_kind = NULL, work_id = NULL,
          claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
      WHERE l.org_id = v_org_id AND l.companion_id = v_companion_id
      RETURNING l.claim_epoch INTO v_claim_epoch;
      UPDATE public.companion_runtime_instances i
      SET last_write_epoch = GREATEST(i.last_write_epoch, v_claim_epoch), updated_at = v_now
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id;
      CONTINUE;
    END IF;

    IF v_work_kind = 'decision'
       AND v_checkpoint IN ('write_intent', 'ambiguous') THEN
      SELECT d.turn_id, d.attempt_id INTO v_turn_id, v_decision_attempt_id
      FROM public.companion_decision_deliveries d
      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id AND d.id = v_work_id;

      PERFORM public.companion_runtime_close_attempt_decisions(
        v_org_id, v_companion_id, v_decision_attempt_id,
        'decision_ack_unknown',
        'Pi decision acceptance is unknown after the delivery lease was lost.',
        'retry'::public.companion_runtime_error_action,
        NULL
      );
      UPDATE public.companion_turn_attempts a
      SET status = 'interrupted', settled_at = v_now,
          last_error_code = 'decision_ack_unknown',
          last_error_message = 'Pi decision acceptance is unknown after the delivery lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
        AND a.id = v_decision_attempt_id
        AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
      UPDATE public.companion_turns t
      SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
          last_error_code = 'decision_ack_unknown',
          last_error_message = 'Pi decision acceptance is unknown after the delivery lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
        AND t.id = v_turn_id
        AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');

      UPDATE public.companion_runtime_leases l
      SET claim_token = NULL, claim_epoch = l.claim_epoch + 1, gate_epoch = NULL,
          executor_id = NULL, work_kind = NULL, work_id = NULL,
          claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
      WHERE l.org_id = v_org_id AND l.companion_id = v_companion_id
      RETURNING l.claim_epoch INTO v_claim_epoch;
      UPDATE public.companion_runtime_instances i
      SET last_write_epoch = GREATEST(i.last_write_epoch, v_claim_epoch), updated_at = v_now
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id;
      CONTINUE;
    END IF;

    -- Basic lifecycle authority is locked and revalidated before claim performs any destructive
    -- precedence mutation. Full resource authorization is repeated by renew immediately before
    -- Box/Pi contact, but a revoked actor can never use an old operation row to interrupt work.
    IF v_work_kind = 'operation' THEN
      v_companion_owner_id := NULL;
      v_operation_actor_authorized := false;
      SELECT c.owner_id
      INTO v_companion_owner_id
      FROM public.companions c
      JOIN public.memberships m
        ON m.org_id = c.org_id AND m.user_id = v_actor_id
      WHERE c.org_id = v_org_id AND c.id = v_companion_id
      FOR NO KEY UPDATE OF c, m;

      IF FOUND AND v_companion_owner_id = v_actor_id THEN
        v_operation_actor_authorized := true;
      ELSIF FOUND AND v_operation_kind <> 'delete' THEN
        PERFORM 1
        FROM public.companion_workspace_access a
        WHERE a.org_id = v_org_id
          AND a.companion_id = v_companion_id
          AND a.role = 'editor'
        FOR NO KEY UPDATE;
        v_operation_actor_authorized := FOUND;
      END IF;

      IF NOT v_operation_actor_authorized THEN
        UPDATE public.companion_operations o
        SET status = 'failed', settled_at = v_now,
            last_error_code = 'actor_access_revoked',
            last_error_message = 'Runtime access was revoked before this operation began.',
            last_error_action = 'none', updated_at = v_now
        WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
          AND o.id = v_work_id AND o.status IN ('pending', 'running');

        IF v_operation_kind = 'start' THEN
          UPDATE public.companion_turns t
          SET status = 'failed', settled_at = v_now, state_changed_at = v_now,
              absolute_deadline_at = COALESCE(t.absolute_deadline_at, v_now),
              last_error_code = 'actor_access_revoked',
              last_error_message = 'Runtime access was revoked before this turn began.',
              last_error_action = 'none', updated_at = v_now
          WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
            AND t.id = (
              SELECT source.source_turn_id
              FROM public.companion_operations source
              WHERE source.org_id = v_org_id
                AND source.companion_id = v_companion_id
                AND source.id = v_work_id
            )
            AND t.status = 'queued';
        END IF;
        CONTINUE;
      END IF;

      IF v_operation_kind = 'apply_settings' THEN
        -- Only an operation whose actor was just revalidated may become a prerequisite for a
        -- queued Send. A stale pending binding is replaced; a running operation keeps its active
        -- binding so takeover observes the same deadline and source.
        UPDATE public.companion_operations selected_operation
        SET source_turn_id = (
          SELECT queued_turn.id
          FROM public.companion_turns queued_turn
          WHERE queued_turn.org_id = v_org_id
            AND queued_turn.companion_id = v_companion_id
            AND queued_turn.status = 'queued'
          ORDER BY queued_turn.queue_sequence, queued_turn.id
          LIMIT 1
        ),
            updated_at = v_now
        WHERE selected_operation.org_id = v_org_id
          AND selected_operation.companion_id = v_companion_id
          AND selected_operation.id = v_work_id
          AND (
            selected_operation.source_turn_id IS NULL
            OR (
              selected_operation.status = 'pending'
              AND NOT EXISTS (
                SELECT 1
                FROM public.companion_turns bound_turn
                WHERE bound_turn.org_id = selected_operation.org_id
                  AND bound_turn.companion_id = selected_operation.companion_id
                  AND bound_turn.id = selected_operation.source_turn_id
                  AND bound_turn.status = 'queued'
              )
            )
          )
          AND EXISTS (
            SELECT 1
            FROM public.companion_turns queued_turn
            WHERE queued_turn.org_id = v_org_id
              AND queued_turn.companion_id = v_companion_id
              AND queued_turn.status = 'queued'
          );
      END IF;
    END IF;

    -- Work selection and ACL locks may have waited. Lease lifetime starts from the actual claim
    -- publication time, never from the beginning of the SQL statement.
    v_now := clock_timestamp();
    v_claim_token := gen_random_uuid();
    v_claim_epoch := NULL;
    UPDATE public.companion_runtime_leases l
    SET claim_token = v_claim_token,
        claim_epoch = l.claim_epoch + 1,
        gate_epoch = p_gate_epoch,
        executor_id = p_executor_id,
        work_kind = v_work_kind,
        work_id = v_work_id,
        claimed_at = v_now,
        renewed_at = v_now,
        expires_at = v_now + make_interval(secs => p_lease_seconds),
        updated_at = v_now
    WHERE l.org_id = v_org_id
      AND l.companion_id = v_companion_id
      AND (l.claim_token IS NULL OR l.expires_at <= v_now)
    RETURNING l.claim_epoch INTO v_claim_epoch;

    IF v_claim_epoch IS NULL THEN
      CONTINUE;
    END IF;

    IF v_work_kind = 'operation' THEN
      -- A newly selected higher-priority operation atomically terminalizes a lower running one
      -- before acquiring the one-running slot. Explicit lifecycle is also an ordering barrier:
      -- pending Starts serialized before it are superseded, while Starts from later Sends survive.
      WITH superseded AS (
        UPDATE public.companion_operations o
        SET status = 'interrupted', settled_at = v_now,
            last_error_code = 'superseded_by_higher_priority',
            last_error_message = 'A higher-priority runtime operation superseded this operation.',
            last_error_action = 'none', updated_at = v_now
        WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
          AND o.id <> v_work_id
          AND (
            (
              o.status = 'running'
              AND CASE
                WHEN o.kind = 'delete' THEN 10
                WHEN o.kind IN ('stop', 'restart_pi', 'restart_box') THEN 20
                WHEN o.kind = 'start' THEN 45
                ELSE 50
              END > CASE
                WHEN v_operation_kind = 'delete' THEN 10
                WHEN v_operation_kind IN ('stop', 'restart_pi', 'restart_box') THEN 20
                WHEN v_operation_kind = 'start' THEN 45
                ELSE 50
              END
            )
            OR (
              v_operation_kind IN ('stop', 'restart_pi', 'restart_box')
              AND o.status = 'pending'
              AND o.kind = 'start'
              AND o.queue_sequence < v_operation_queue_sequence
            )
          )
        RETURNING o.kind, o.source_turn_id
      )
      UPDATE public.companion_turns t
      SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
          absolute_deadline_at = COALESCE(t.absolute_deadline_at, v_now),
          last_error_code = 'runtime_lifecycle_preempted',
          last_error_message = CASE
            WHEN v_operation_kind = 'stop' THEN 'The Companion was stopped before this turn completed.'
            ELSE 'The Companion runtime restarted before this turn completed.'
          END,
          last_error_action = 'retry', updated_at = v_now
      WHERE v_operation_kind IN ('stop', 'restart_pi', 'restart_box')
        AND t.org_id = v_org_id AND t.companion_id = v_companion_id
        AND t.status = 'queued'
        AND t.queue_sequence <= v_operation_turn_queue_cutoff
        -- Referencing the DML CTE makes the operation/turn barrier visibly one SQL statement.
        AND (SELECT count(*) FROM superseded) >= 0;

      IF v_operation_kind IN ('delete', 'stop', 'restart_pi', 'restart_box') THEN
        -- Close decision outboxes before making their attempts terminal. A start never enters this
        -- branch: turn-triggered wake remains below an already-active attempt and cannot kill it.
        PERFORM public.companion_runtime_close_attempt_decisions(
          a.org_id, a.companion_id, a.id,
          'runtime_lifecycle_preempted',
          CASE
            WHEN v_operation_kind = 'delete' THEN 'The Companion was deleted before this turn completed.'
            WHEN v_operation_kind = 'stop' THEN 'The Companion was stopped before this turn completed.'
            ELSE 'The Companion runtime restarted before this turn completed.'
          END,
          CASE WHEN v_operation_kind = 'delete'
            THEN 'none'::public.companion_runtime_error_action
            ELSE 'retry'::public.companion_runtime_error_action
          END,
          NULL
        )
        FROM public.companion_turn_attempts a
        WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
          AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');

        UPDATE public.companion_turn_attempts a
        SET status = 'interrupted', settled_at = v_now,
            last_error_code = 'runtime_lifecycle_preempted',
            last_error_message = CASE
              WHEN v_operation_kind = 'delete' THEN 'The Companion was deleted before this turn completed.'
              WHEN v_operation_kind = 'stop' THEN 'The Companion was stopped before this turn completed.'
              ELSE 'The Companion runtime restarted before this turn completed.'
            END,
            last_error_action = CASE WHEN v_operation_kind = 'delete'
              THEN 'none'::public.companion_runtime_error_action
              ELSE 'retry'::public.companion_runtime_error_action
            END,
            updated_at = v_now
        WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
          AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');

        UPDATE public.companion_turns t
        SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
            last_error_code = 'runtime_lifecycle_preempted',
            last_error_message = CASE
              WHEN v_operation_kind = 'delete' THEN 'The Companion was deleted before this turn completed.'
              WHEN v_operation_kind = 'stop' THEN 'The Companion was stopped before this turn completed.'
              ELSE 'The Companion runtime restarted before this turn completed.'
            END,
            last_error_action = CASE WHEN v_operation_kind = 'delete'
              THEN 'none'::public.companion_runtime_error_action
              ELSE 'retry'::public.companion_runtime_error_action
            END,
            updated_at = v_now
        WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
          AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');

        IF v_operation_kind = 'delete' THEN
          UPDATE public.companion_turns t
          SET status = 'cancelled', settled_at = v_now, state_changed_at = v_now,
              last_error_code = NULL, last_error_message = NULL, last_error_action = NULL,
              updated_at = v_now
          WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
            AND t.status = 'queued';

          -- Delete is terminal for this generation. Cancel every queued operation while the
          -- instance mutex is held, so no start/settings/lifecycle intent can recreate a Box after
          -- provider deletion succeeds and the instance becomes retired.
          UPDATE public.companion_operations o
          SET status = 'cancelled',
              settled_at = v_now,
              last_error_code = NULL,
              last_error_message = NULL,
              last_error_action = NULL,
              updated_at = v_now
          WHERE o.org_id = v_org_id
            AND o.companion_id = v_companion_id
            AND o.id <> v_work_id
            AND o.status = 'pending';
        END IF;
      END IF;
      UPDATE public.companion_operations o
      SET status = 'running', claim_epoch = v_claim_epoch,
          attempt_count = o.attempt_count + 1,
          started_at = COALESCE(o.started_at, v_now), updated_at = v_now
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id AND o.id = v_work_id;
    ELSIF v_work_kind = 'decision' THEN
      UPDATE public.companion_decision_deliveries d
      SET decision_status = CASE
            WHEN d.decision_status = 'pending' AND d.expires_at <= v_now
              THEN 'expired'::public.companion_decision_status
            ELSE d.decision_status
          END,
          responded_at = CASE
            WHEN d.decision_status = 'pending' AND d.expires_at <= v_now THEN v_now
            ELSE d.responded_at
          END,
          claim_epoch = v_claim_epoch,
          delivery_attempt_count = d.delivery_attempt_count + 1,
          updated_at = v_now
      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id AND d.id = v_work_id;
    ELSIF v_work_kind = 'attempt' AND v_turn_id IS NOT NULL THEN
      INSERT INTO public.companion_turn_attempts (
        id, org_id, companion_id, turn_id, attempt_number, actor_id,
        runtime_generation, settings_revision, skills_revision, model_id,
        provider_ids, selected_skill_ids, selected_mcp_account_ids,
        claim_epoch, status, checkpoint, checkpoint_sequence,
        dispatch_state, started_at, updated_at
      ) VALUES (
        v_work_id, v_org_id, v_companion_id, v_turn_id, v_attempt_number, v_actor_id,
        v_generation,
        (SELECT i.applied_settings_revision FROM public.companion_runtime_instances i
         WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id),
        v_skills_revision, v_model_id, v_provider_ids, v_selected_skill_ids,
        v_selected_mcp_account_ids, v_claim_epoch, 'starting', 'starting', 0,
        'pending', v_now, v_now
      );
      UPDATE public.companion_turns t
      SET status = 'starting', inactivity_deadline_at = NULL,
          absolute_deadline_at = v_now + interval '2 hours',
          state_changed_at = v_now, updated_at = v_now
      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id AND t.id = v_turn_id;
    ELSIF v_work_kind = 'attempt' THEN
      UPDATE public.companion_turn_attempts a
      SET claim_epoch = v_claim_epoch, updated_at = v_now
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id AND a.id = v_work_id;
    ELSIF v_work_kind = 'settings' THEN
      v_turn_id := NULL;
      v_cold_start_deadline_at := NULL;
      SELECT t.id, t.client_surface, t.cold_start_deadline_at
      INTO v_turn_id, v_client_surface, v_cold_start_deadline_at
      FROM public.companion_turns t
      WHERE t.org_id = v_org_id
        AND t.companion_id = v_companion_id
        AND t.status = 'queued'
      ORDER BY t.queue_sequence, t.id
      LIMIT 1
      FOR UPDATE;
      IF NOT FOUND THEN
        v_client_surface := 'web';
      END IF;

      UPDATE public.companion_runtime_instances i
      SET settings_claim_epoch = v_claim_epoch,
          settings_claim_actor_id = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN i.settings_actor_id ELSE i.settings_claim_actor_id END,
          settings_claim_client_surface = v_client_surface,
          settings_claim_turn_id = v_turn_id,
          settings_claim_cold_start_deadline_at = v_cold_start_deadline_at,
          settings_claim_revision = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN i.desired_settings_revision ELSE i.settings_claim_revision END,
          settings_claim_skills_revision = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN CASE WHEN v_client_surface = 'native_mobile'
              THEN i.applied_skills_revision ELSE c.skills_revision END
            ELSE i.settings_claim_skills_revision END,
          settings_claim_model_id = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN c.model_id ELSE i.settings_claim_model_id END,
          settings_claim_persona = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN c.persona ELSE i.settings_claim_persona END,
          settings_claim_can_write_skills = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN CASE WHEN v_client_surface = 'native_mobile' THEN false ELSE c.can_write_skills END
            ELSE i.settings_claim_can_write_skills END,
          settings_claim_provider_ids = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN c.provider_ids ELSE i.settings_claim_provider_ids END,
          settings_claim_selected_skill_ids = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN CASE WHEN v_client_surface = 'native_mobile' THEN '[]'::jsonb ELSE c.selected_skill_ids END
            ELSE i.settings_claim_selected_skill_ids END,
          settings_claim_skill_refs = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision) THEN
            CASE WHEN v_client_surface = 'native_mobile' THEN '[]'::jsonb ELSE (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'skill_id', s.id,
              'current_version_id', s.current_version_id
            ) ORDER BY s.id), '[]'::jsonb)
            FROM public.skills s
            WHERE s.org_id = i.org_id
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(c.selected_skill_ids) selected(skill_id)
                WHERE selected.skill_id = s.id::text
              )
          ) END ELSE i.settings_claim_skill_refs END,
          settings_claim_selected_mcp_account_ids = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR (v_client_surface <> 'native_mobile'
                  AND i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision)
            THEN CASE WHEN v_client_surface = 'native_mobile' THEN '[]'::jsonb
              ELSE c.selected_mcp_account_ids END
            ELSE i.settings_claim_selected_mcp_account_ids END,
          settings_checkpoint = 'applying',
          settings_checkpoint_sequence = i.settings_checkpoint_sequence + 1,
          settings_attempt_count = i.settings_attempt_count + 1,
          updated_at = v_now
      FROM public.companions c
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND c.org_id = i.org_id AND c.id = i.companion_id;
      v_checkpoint := 'applying';
      v_checkpoint_sequence := v_checkpoint_sequence + 1;
    ELSIF v_work_kind = 'health' THEN
      UPDATE public.companion_runtime_instances i
      SET health_claim_epoch = v_claim_epoch,
          health_checkpoint = 'observing',
          health_checkpoint_sequence = i.health_checkpoint_sequence + 1,
          updated_at = v_now
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id;
      v_checkpoint := 'observing';
      v_checkpoint_sequence := v_checkpoint_sequence + 1;
    END IF;

    IF v_work_kind = 'operation' THEN
      SELECT o.started_at, o.attempt_count, o.provider_operation_id, o.source_turn_id,
             o.client_surface,
             o.target_settings_revision, o.target_skills_revision
      INTO v_operation_started_at, v_operation_attempt_count, v_provider_operation_id, v_turn_id,
           v_client_surface,
           v_target_settings_revision, v_target_skills_revision
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id AND o.id = v_work_id;
    END IF;

    v_claimed := v_claimed + 1;
    v_turn_status := NULL;
    v_attempt_status := NULL;
    v_dispatch_state := NULL;
    v_event_cursor := NULL;
    v_unknown_event_count := NULL;
    v_malformed_event_count := NULL;
    v_oversized_event_count := NULL;
    v_cold_start_deadline_at := NULL;
    v_inactivity_deadline_at := NULL;
    v_absolute_deadline_at := NULL;
    v_decision_status := NULL;
    v_decision_delivery_state := NULL;
    IF v_work_kind = 'operation' AND v_turn_id IS NOT NULL THEN
      SELECT t.status, t.cold_start_deadline_at,
             t.inactivity_deadline_at, t.absolute_deadline_at
      INTO v_turn_status, v_cold_start_deadline_at,
           v_inactivity_deadline_at, v_absolute_deadline_at
      FROM public.companion_turns t
      WHERE t.org_id = v_org_id
        AND t.companion_id = v_companion_id
        AND t.id = v_turn_id;
    ELSIF v_work_kind = 'attempt' THEN
      SELECT a.turn_id, t.client_surface, t.status, a.status, a.dispatch_state, a.event_cursor,
             a.unknown_event_count, a.malformed_event_count, a.oversized_event_count,
             t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at
      INTO v_turn_id, v_client_surface, v_turn_status, v_attempt_status, v_dispatch_state, v_event_cursor,
           v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
           v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at
      FROM public.companion_turn_attempts a
      JOIN public.companion_turns t
        ON t.org_id = a.org_id AND t.companion_id = a.companion_id AND t.id = a.turn_id
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id AND a.id = v_work_id;
    ELSIF v_work_kind = 'decision' THEN
      SELECT d.turn_id, t.client_surface, t.status, a.status, a.dispatch_state, a.event_cursor,
             a.unknown_event_count, a.malformed_event_count, a.oversized_event_count,
             t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at,
             d.decision_status, d.delivery_state
      INTO v_turn_id, v_client_surface, v_turn_status, v_attempt_status, v_dispatch_state, v_event_cursor,
           v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
           v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
           v_decision_status, v_decision_delivery_state
      FROM public.companion_decision_deliveries d
      JOIN public.companion_turn_attempts a
        ON a.org_id = d.org_id AND a.companion_id = d.companion_id
       AND a.turn_id = d.turn_id AND a.id = d.attempt_id
      JOIN public.companion_turns t
        ON t.org_id = d.org_id AND t.companion_id = d.companion_id AND t.id = d.turn_id
      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id AND d.id = v_work_id;
    ELSIF v_work_kind = 'settings' THEN
      SELECT i.settings_claim_turn_id, i.settings_claim_cold_start_deadline_at
      INTO v_turn_id, v_cold_start_deadline_at
      FROM public.companion_runtime_instances i
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND i.settings_claim_epoch = v_claim_epoch;
    END IF;
    RETURN QUERY SELECT
      v_org_id, v_companion_id, v_claim_token, v_claim_epoch, p_gate_epoch,
      v_work_kind, v_work_id, v_actor_id, v_client_surface, v_generation,
      v_checkpoint, v_checkpoint_sequence,
      v_turn_id, v_turn_status, v_attempt_status, v_dispatch_state, v_event_cursor,
      v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
      v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
      v_operation_kind, v_operation_started_at, v_operation_attempt_count,
      v_provider_operation_id,
      v_target_settings_revision, v_target_skills_revision,
      v_decision_status, v_decision_delivery_state;
  END LOOP;
END
$$;
--> statement-breakpoint

-- Renew immediately before every external effect. The work row, not the caller, supplies actor
-- identity. Both the original attempt actor and a decision responder are revalidated. Resource
-- selection is fail-closed: an Editor may use resources owned by the immutable Companion owner,
-- while the owner never inherits access to an Editor's private resources.
CREATE FUNCTION public.companion_runtime_renew_and_authorize(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  authorized boolean,
  denial_code text,
  lease_expires_at timestamp with time zone,
  authorization_actor_id text,
  decision_actor_id text,
  client_surface public.companion_client_surface,
  runtime_generation bigint,
  box_id text,
  box_state public.companion_box_observed_state,
  pi_state public.companion_pi_observed_state,
  pi_invocation_id text,
  disk_layout_version integer,
  applied_settings_revision bigint,
  applied_skills_revision integer,
  model_id text,
  persona text,
  can_write_skills boolean,
  provider_refs jsonb,
  skill_refs jsonb,
  mcp_refs jsonb,
  desired_settings_revision bigint,
  skills_revision integer,
  work_checkpoint text,
  work_checkpoint_sequence bigint,
  turn_id uuid,
  turn_status public.companion_turn_status,
  attempt_status public.companion_attempt_status,
  dispatch_state public.companion_dispatch_state,
  event_cursor bigint,
  unknown_event_count integer,
  malformed_event_count integer,
  oversized_event_count integer,
  cold_start_deadline_at timestamp with time zone,
  inactivity_deadline_at timestamp with time zone,
  absolute_deadline_at timestamp with time zone,
  operation_kind public.companion_operation_kind,
  operation_started_at timestamp with time zone,
  operation_attempt_count integer,
  provider_operation_id text,
  target_settings_revision bigint,
  target_skills_revision integer,
  decision_status public.companion_decision_status,
  decision_delivery_state public.companion_decision_delivery_state,
  decision_request_key text,
  decision_response_text text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_lease_expires_at timestamp with time zone;
  v_authorization_actor_id text;
  v_decision_actor_id text;
  v_operation_kind public.companion_operation_kind;
  v_operation_started_at timestamp with time zone;
  v_operation_attempt_count integer;
  v_operation_provider_operation_id text;
  v_decision_status public.companion_decision_status;
  v_decision_request_key text;
  v_decision_response_text text;
  v_attempt_id uuid;
  v_generation bigint;
  v_box_id text;
  v_box_state public.companion_box_observed_state;
  v_pi_state public.companion_pi_observed_state;
  v_pi_invocation_id text;
  v_disk_layout_version integer;
  v_applied_settings_revision bigint;
  v_applied_skills_revision integer;
  v_model_id text;
  v_persona text;
  v_can_write_skills boolean;
  v_provider_ids jsonb;
  v_skill_ids jsonb;
  v_mcp_ids jsonb;
  v_desired_settings_revision bigint;
  v_skills_revision integer;
  v_live_desired_settings_revision bigint;
  v_live_skills_revision integer;
  v_operation_target_settings_revision bigint;
  v_operation_target_skills_revision integer;
  v_operation_model_id text;
  v_operation_persona text;
  v_operation_can_write_skills boolean;
  v_operation_provider_ids jsonb;
  v_operation_skill_ids jsonb;
  v_operation_skill_refs jsonb;
  v_operation_mcp_ids jsonb;
  v_settings_claim_revision bigint;
  v_settings_claim_skills_revision integer;
  v_settings_model_id text;
  v_settings_persona text;
  v_settings_can_write_skills boolean;
  v_settings_provider_ids jsonb;
  v_settings_skill_ids jsonb;
  v_settings_skill_refs jsonb;
  v_settings_mcp_ids jsonb;
  v_provider_refs jsonb := '[]'::jsonb;
  v_skill_refs jsonb := '[]'::jsonb;
  v_attempt_skill_refs jsonb := '[]'::jsonb;
  v_has_pinned_resources boolean := false;
  v_mcp_refs jsonb := '[]'::jsonb;
  v_companion_owner_id text;
  v_denial_code text;
  v_requires_resources boolean := false;
  v_requires_skills_mcp boolean := false;
  v_client_surface public.companion_client_surface := 'web';
  v_actor_authorized boolean := false;
  v_responder_authorized boolean := true;
  v_work_priority integer;
  v_higher_priority_pending boolean := false;
  v_work_checkpoint text;
  v_work_checkpoint_sequence bigint;
  v_turn_id uuid;
  v_turn_status public.companion_turn_status;
  v_attempt_status public.companion_attempt_status;
  v_dispatch_state public.companion_dispatch_state;
  v_event_cursor bigint;
  v_unknown_event_count integer;
  v_malformed_event_count integer;
  v_oversized_event_count integer;
  v_cold_start_deadline_at timestamp with time zone;
  v_inactivity_deadline_at timestamp with time zone;
  v_absolute_deadline_at timestamp with time zone;
  v_decision_delivery_state public.companion_decision_delivery_state;
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 300
     OR p_executor_id IS NULL
     OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
     OR p_executor_id ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid Runtime v2 renewal arguments' USING ERRCODE = '22023';
  END IF;

  -- There is intentionally no diagnostic row for a stale lease. Its token/epoch learns nothing and
  -- can perform no mutation, including after expiry but before another executor takes over.
  SELECT l.expires_at INTO v_lease_expires_at
  FROM public.companion_runtime_leases l
  JOIN public.companion_runtime_control c ON c.id = 'runtime-v2'
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp()
    AND c.enabled
    AND c.gate_epoch = p_gate_epoch
  FOR UPDATE OF l;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM 1
  FROM public.companion_runtime_instances i
  WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_work_kind = 'operation' THEN
    SELECT o.actor_id, o.kind, o.client_surface,
           o.checkpoint, o.checkpoint_sequence, o.source_turn_id,
           o.started_at, o.attempt_count, o.provider_operation_id,
           o.target_settings_revision, o.target_skills_revision,
           o.model_id, o.persona, o.can_write_skills,
           o.provider_ids, o.selected_skill_ids, o.skill_refs,
           o.selected_mcp_account_ids,
           t.status, t.cold_start_deadline_at,
           t.inactivity_deadline_at, t.absolute_deadline_at
    INTO v_authorization_actor_id, v_operation_kind, v_client_surface,
         v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id,
         v_operation_started_at, v_operation_attempt_count, v_operation_provider_operation_id,
         v_operation_target_settings_revision, v_operation_target_skills_revision,
         v_operation_model_id, v_operation_persona, v_operation_can_write_skills,
         v_operation_provider_ids, v_operation_skill_ids, v_operation_skill_refs,
         v_operation_mcp_ids,
         v_turn_status, v_cold_start_deadline_at,
         v_inactivity_deadline_at, v_absolute_deadline_at
    FROM public.companion_operations o
    LEFT JOIN public.companion_turns t
      ON t.org_id = o.org_id AND t.companion_id = o.companion_id AND t.id = o.source_turn_id
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.id = p_work_id AND o.status = 'running' AND o.claim_epoch = p_claim_epoch;
    IF NOT FOUND THEN RETURN; END IF;
    v_requires_resources := v_operation_kind IN ('start', 'restart_pi', 'restart_box', 'apply_settings');
  ELSIF p_work_kind = 'attempt' THEN
    SELECT a.actor_id, t.client_surface, a.checkpoint, a.checkpoint_sequence,
           a.turn_id, t.status, a.status, a.dispatch_state, a.event_cursor,
           a.unknown_event_count, a.malformed_event_count, a.oversized_event_count,
           t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at
    INTO v_authorization_actor_id, v_client_surface, v_work_checkpoint,
         v_work_checkpoint_sequence, v_turn_id, v_turn_status, v_attempt_status,
         v_dispatch_state, v_event_cursor,
         v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
         v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at
    FROM public.companion_turn_attempts a
    JOIN public.companion_turns t
      ON t.org_id = a.org_id AND t.companion_id = a.companion_id AND t.id = a.turn_id
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.id = p_work_id AND a.claim_epoch = p_claim_epoch
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
    IF NOT FOUND THEN RETURN; END IF;
    v_attempt_id := p_work_id;
    v_requires_resources := true;
  ELSIF p_work_kind = 'decision' THEN
    SELECT a.actor_id, d.actor_id, d.decision_status, d.request_key, d.response_text,
           t.client_surface,
           d.delivery_checkpoint, d.delivery_checkpoint_sequence, d.turn_id,
           t.status, a.status, a.dispatch_state, a.event_cursor,
           a.unknown_event_count, a.malformed_event_count, a.oversized_event_count,
           t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at,
           d.delivery_state
    INTO v_authorization_actor_id, v_decision_actor_id, v_decision_status,
         v_decision_request_key, v_decision_response_text, v_client_surface,
         v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id,
         v_turn_status, v_attempt_status, v_dispatch_state, v_event_cursor,
         v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
         v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
         v_decision_delivery_state
    FROM public.companion_decision_deliveries d
    JOIN public.companion_turn_attempts a
      ON a.org_id = d.org_id AND a.companion_id = d.companion_id
     AND a.turn_id = d.turn_id AND a.id = d.attempt_id
    JOIN public.companion_turns t
      ON t.org_id = d.org_id AND t.companion_id = d.companion_id AND t.id = d.turn_id
    WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
      AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
      AND d.decision_status <> 'pending'
      AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
    IF NOT FOUND THEN RETURN; END IF;
    SELECT d.attempt_id INTO v_attempt_id
    FROM public.companion_decision_deliveries d
    WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id AND d.id = p_work_id;
    v_requires_resources := true;
  ELSIF p_work_kind = 'settings' THEN
    SELECT i.settings_claim_actor_id, i.settings_claim_client_surface,
           i.settings_checkpoint, i.settings_checkpoint_sequence,
           i.settings_claim_turn_id, i.settings_claim_cold_start_deadline_at,
           i.settings_claim_revision, i.settings_claim_skills_revision,
           i.settings_claim_model_id, i.settings_claim_persona,
           i.settings_claim_can_write_skills, i.settings_claim_provider_ids,
           i.settings_claim_selected_skill_ids, i.settings_claim_skill_refs,
           i.settings_claim_selected_mcp_account_ids
    INTO v_authorization_actor_id, v_client_surface,
         v_work_checkpoint, v_work_checkpoint_sequence,
         v_turn_id, v_cold_start_deadline_at,
         v_settings_claim_revision, v_settings_claim_skills_revision,
         v_settings_model_id, v_settings_persona, v_settings_can_write_skills,
         v_settings_provider_ids, v_settings_skill_ids, v_settings_skill_refs,
         v_settings_mcp_ids
    FROM public.companion_runtime_instances i
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id AND i.settings_claim_epoch = p_claim_epoch
      AND i.settings_claim_actor_id IS NOT NULL AND i.settings_claim_revision IS NOT NULL;
    IF NOT FOUND THEN RETURN; END IF;
    v_requires_resources := true;
  ELSIF p_work_kind = 'health' THEN
    IF p_work_id <> p_companion_id OR NOT EXISTS (
      SELECT 1 FROM public.companion_runtime_instances i
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
        AND i.health_claim_epoch = p_claim_epoch
    ) THEN
      RETURN;
    END IF;
    -- Health may observe identifiers already in the runtime projection. It never receives an actor,
    -- model/resource selection, credential reference, or authority to wake/decrypt.
    v_actor_authorized := true;
    v_client_surface := NULL;
    SELECT i.health_checkpoint, i.health_checkpoint_sequence
    INTO v_work_checkpoint, v_work_checkpoint_sequence
    FROM public.companion_runtime_instances i
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
  ELSE
    RETURN;
  END IF;
  v_work_priority := CASE
    WHEN p_work_kind = 'operation' AND v_operation_kind = 'delete' THEN 10
    WHEN p_work_kind = 'operation' AND v_operation_kind IN ('stop', 'restart_pi', 'restart_box') THEN 20
    WHEN p_work_kind = 'operation' AND v_operation_kind = 'start' THEN 45
    WHEN p_work_kind = 'decision' THEN 30
    WHEN p_work_kind = 'attempt' THEN 40
    WHEN p_work_kind IN ('settings', 'operation') THEN 50
    ELSE 70
  END;

  -- Precedence remains live while a lease is held. Renewal reports a higher-priority durable intent
  -- instead of extending the lease; the executor can interrupt/release at its next safe checkpoint.
  SELECT EXISTS (
    SELECT 1 FROM public.companion_operations o
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.status IN ('pending', 'running') AND o.available_at <= v_now
      AND (p_work_kind <> 'operation' OR o.id <> p_work_id)
      -- A stale lifecycle intent must not preempt authorized work after its actor loses access.
      -- Claim will terminalize that row on the next sweep; until then it is invisible to live
      -- precedence. Delete remains owner-only, matching both claim and the final renew gate.
      AND EXISTS (
        SELECT 1
        FROM public.memberships candidate_membership
        JOIN public.companions candidate_companion
          ON candidate_companion.org_id = candidate_membership.org_id
         AND candidate_companion.id = o.companion_id
        WHERE candidate_membership.org_id = o.org_id
          AND candidate_membership.user_id = o.actor_id
          AND (
            candidate_companion.owner_id = o.actor_id
            OR (
              o.kind <> 'delete'
              AND EXISTS (
                SELECT 1
                FROM public.companion_workspace_access candidate_access
                WHERE candidate_access.org_id = o.org_id
                  AND candidate_access.companion_id = o.companion_id
                  AND candidate_access.role = 'editor'
                FOR NO KEY UPDATE
              )
            )
          )
        FOR NO KEY UPDATE OF candidate_membership, candidate_companion
      )
      AND (
        o.kind <> 'apply_settings'
        OR EXISTS (
          SELECT 1 FROM public.companion_runtime_instances warm_instance
          WHERE warm_instance.org_id = o.org_id
            AND warm_instance.companion_id = o.companion_id
            AND warm_instance.box_state IN ('ready', 'idle', 'running')
        )
        OR EXISTS (
          SELECT 1 FROM public.companion_turns settings_turn
          WHERE settings_turn.org_id = o.org_id
            AND settings_turn.companion_id = o.companion_id
            AND settings_turn.status = 'queued'
        )
      )
      AND CASE
        WHEN o.kind = 'delete' THEN 10
        WHEN o.kind IN ('stop', 'restart_pi', 'restart_box') THEN 20
        WHEN o.kind = 'start' THEN 45
        ELSE 50
      END < v_work_priority
    UNION ALL
    SELECT 1 FROM public.companion_decision_deliveries d
    WHERE v_work_priority > 30
      AND d.org_id = p_org_id AND d.companion_id = p_companion_id
      AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
      AND (d.decision_status <> 'pending' OR d.expires_at <= v_now)
      AND EXISTS (
        SELECT 1 FROM public.companion_turn_attempts decision_attempt
        WHERE decision_attempt.org_id = d.org_id
          AND decision_attempt.companion_id = d.companion_id
          AND decision_attempt.turn_id = d.turn_id
          AND decision_attempt.id = d.attempt_id
          AND decision_attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
      )
    UNION ALL
    SELECT 1 FROM public.companion_turn_attempts a
    WHERE v_work_priority > 40
      AND a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
    UNION ALL
    SELECT 1 FROM public.companion_runtime_instances settings_instance
    JOIN public.companions settings_companion
      ON settings_companion.org_id = settings_instance.org_id
     AND settings_companion.id = settings_instance.companion_id
    WHERE v_work_priority > 50
      AND settings_instance.org_id = p_org_id
      AND settings_instance.companion_id = p_companion_id
      AND settings_instance.settings_actor_id IS NOT NULL
      AND settings_instance.settings_available_at <= v_now
      AND (
        settings_instance.desired_settings_revision > settings_instance.applied_settings_revision
        OR EXISTS (
          SELECT 1 FROM public.companion_turns profile_turn
          WHERE profile_turn.org_id = settings_instance.org_id
            AND profile_turn.companion_id = settings_instance.companion_id
            AND profile_turn.status = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM public.companion_turns earlier_turn
              WHERE earlier_turn.org_id = profile_turn.org_id
                AND earlier_turn.companion_id = profile_turn.companion_id
                AND earlier_turn.status = 'queued'
                AND earlier_turn.queue_sequence < profile_turn.queue_sequence
            )
            AND (
              (profile_turn.client_surface = 'native_mobile'
                AND settings_instance.applied_client_surface IS DISTINCT FROM 'native_mobile')
              OR (profile_turn.client_surface <> 'native_mobile'
                AND (settings_instance.applied_client_surface IS NULL
                  OR settings_instance.applied_client_surface = 'native_mobile'))
            )
        )
        OR (
          settings_companion.skills_revision > settings_instance.applied_skills_revision
          AND EXISTS (
            SELECT 1 FROM public.companion_turns settings_turn
            WHERE settings_turn.org_id = settings_instance.org_id
              AND settings_turn.companion_id = settings_instance.companion_id
              AND settings_turn.status = 'queued'
              AND settings_turn.client_surface <> 'native_mobile'
              AND NOT EXISTS (
                SELECT 1 FROM public.companion_turns earlier_turn
                WHERE earlier_turn.org_id = settings_turn.org_id
                  AND earlier_turn.companion_id = settings_turn.companion_id
                  AND earlier_turn.status = 'queued'
                  AND earlier_turn.queue_sequence < settings_turn.queue_sequence
              )
          )
        )
      )
      AND (
        settings_instance.box_state IN ('ready', 'idle', 'running')
        OR EXISTS (
          SELECT 1 FROM public.companion_turns settings_turn
          WHERE settings_turn.org_id = settings_instance.org_id
            AND settings_turn.companion_id = settings_instance.companion_id
            AND settings_turn.status = 'queued'
        )
      )
    UNION ALL
    SELECT 1 FROM public.companion_turns t
    JOIN public.companion_runtime_instances queue_instance
      ON queue_instance.org_id = t.org_id AND queue_instance.companion_id = t.companion_id
    JOIN public.companions queue_companion
      ON queue_companion.org_id = t.org_id AND queue_companion.id = t.companion_id
    WHERE v_work_priority > 60
      AND t.org_id = p_org_id AND t.companion_id = p_companion_id AND t.status = 'queued'
      AND queue_instance.desired_settings_revision = queue_instance.applied_settings_revision
      AND (
        (t.client_surface = 'native_mobile'
          AND queue_instance.applied_client_surface = 'native_mobile')
        OR (t.client_surface <> 'native_mobile'
          AND queue_instance.applied_client_surface IS NOT NULL
          AND queue_instance.applied_client_surface <> 'native_mobile'
          AND queue_companion.skills_revision = queue_instance.applied_skills_revision)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.companion_turns earlier_turn
        WHERE earlier_turn.org_id = t.org_id
          AND earlier_turn.companion_id = t.companion_id
          AND earlier_turn.status = 'queued'
          AND earlier_turn.queue_sequence < t.queue_sequence
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.companion_turns blocking_turn
        WHERE blocking_turn.org_id = t.org_id AND blocking_turn.companion_id = t.companion_id
          AND blocking_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
      )
  ) INTO v_higher_priority_pending;
  IF v_higher_priority_pending THEN
    v_denial_code := 'higher_priority_work_pending';
  END IF;
  v_requires_skills_mcp := v_requires_resources AND v_client_surface <> 'native_mobile';

  SELECT i.generation, i.box_id, i.box_state, i.pi_state, i.pi_invocation_id,
         i.disk_layout_version, i.applied_settings_revision, i.applied_skills_revision,
         c.model_id, c.persona, c.can_write_skills, c.provider_ids,
         c.selected_skill_ids, c.selected_mcp_account_ids,
         i.desired_settings_revision, c.skills_revision, c.owner_id
  INTO v_generation, v_box_id, v_box_state, v_pi_state, v_pi_invocation_id,
       v_disk_layout_version, v_applied_settings_revision, v_applied_skills_revision,
       v_model_id, v_persona, v_can_write_skills, v_provider_ids,
       v_skill_ids, v_mcp_ids, v_live_desired_settings_revision, v_live_skills_revision,
       v_companion_owner_id
  FROM public.companion_runtime_instances i
  JOIN public.companions c
    ON c.org_id = i.org_id AND c.id = i.companion_id
  WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_desired_settings_revision := v_live_desired_settings_revision;
  v_skills_revision := v_live_skills_revision;

  -- Implicit settings work must apply the latest revision before every Box interaction. If the
  -- control plane changes either revision while this lease is held, deny renewal; release (or an
  -- expired-lease takeover) invalidates the stale snapshot and the next claim captures the latest.
  IF v_denial_code IS NULL
     AND p_work_kind = 'settings'
     AND (
       v_live_desired_settings_revision IS DISTINCT FROM v_settings_claim_revision
       OR (
         v_client_surface <> 'native_mobile'
         AND v_live_skills_revision IS DISTINCT FROM v_settings_claim_skills_revision
       )
     ) THEN
    v_denial_code := 'settings_changed_since_claim';
  END IF;

  -- Active turns use the snapshot captured at promotion. Resource-bearing lifecycle operations use
  -- the snapshot captured with their durable intent. A concurrent edit therefore produces later
  -- settings work instead of changing what a takeover stages or launches midway through a claim.
  IF v_attempt_id IS NOT NULL THEN
    SELECT a.model_id, a.persona, a.can_write_skills,
           a.provider_ids, a.selected_skill_ids, a.skill_refs,
           a.selected_mcp_account_ids, a.settings_revision, a.skills_revision
    INTO v_model_id, v_persona, v_can_write_skills,
         v_provider_ids, v_skill_ids, v_attempt_skill_refs,
         v_mcp_ids, v_desired_settings_revision, v_skills_revision
    FROM public.companion_turn_attempts a
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id AND a.id = v_attempt_id;
    IF NOT FOUND THEN RETURN; END IF;
    v_has_pinned_resources := true;
  ELSIF p_work_kind = 'operation' AND v_requires_resources THEN
    v_model_id := v_operation_model_id;
    v_persona := v_operation_persona;
    v_can_write_skills := v_operation_can_write_skills;
    v_provider_ids := v_operation_provider_ids;
    v_skill_ids := v_operation_skill_ids;
    v_attempt_skill_refs := v_operation_skill_refs;
    v_mcp_ids := v_operation_mcp_ids;
    v_desired_settings_revision := v_operation_target_settings_revision;
    v_skills_revision := v_operation_target_skills_revision;
    v_has_pinned_resources := true;
  ELSIF p_work_kind = 'settings' THEN
    v_model_id := v_settings_model_id;
    v_persona := v_settings_persona;
    v_can_write_skills := v_settings_can_write_skills;
    v_provider_ids := v_settings_provider_ids;
    v_skill_ids := v_settings_skill_ids;
    v_attempt_skill_refs := v_settings_skill_refs;
    v_mcp_ids := v_settings_mcp_ids;
    v_desired_settings_revision := v_settings_claim_revision;
    v_skills_revision := v_settings_claim_skills_revision;
    v_has_pinned_resources := true;
  END IF;

  IF v_client_surface = 'native_mobile' THEN
    v_can_write_skills := false;
  END IF;

  IF v_denial_code IS NULL AND p_work_kind <> 'health' THEN
    -- These locks are part of the authorization result. They conflict with membership removal,
    -- ownership/share changes, and are held through the final lease CAS/transaction commit, so a
    -- concurrent revocation cannot slip between the decision and authorized=true.
    v_actor_authorized := false;
    SELECT c.owner_id
    INTO v_companion_owner_id
    FROM public.memberships m
    JOIN public.companions c ON c.org_id = m.org_id AND c.id = p_companion_id
    WHERE m.org_id = p_org_id AND m.user_id = v_authorization_actor_id
    FOR NO KEY UPDATE OF m, c;
    IF FOUND AND v_companion_owner_id = v_authorization_actor_id THEN
      v_actor_authorized := true;
    ELSIF FOUND AND v_operation_kind IS DISTINCT FROM 'delete' THEN
      PERFORM 1
      FROM public.companion_workspace_access a
      WHERE a.org_id = p_org_id
        AND a.companion_id = p_companion_id
        AND a.role = 'editor'
      FOR NO KEY UPDATE;
      v_actor_authorized := FOUND;
    END IF;

    IF NOT v_actor_authorized THEN
      v_denial_code := 'actor_access_revoked';
    END IF;

    IF v_denial_code IS NULL AND p_work_kind = 'decision' AND v_decision_actor_id IS NOT NULL THEN
      v_responder_authorized := false;
      PERFORM 1
      FROM public.memberships responder_membership
      WHERE responder_membership.org_id = p_org_id
        AND responder_membership.user_id = v_decision_actor_id
      FOR NO KEY UPDATE;
      IF FOUND AND v_companion_owner_id = v_decision_actor_id THEN
        v_responder_authorized := true;
      ELSIF FOUND THEN
        PERFORM 1
        FROM public.companion_workspace_access responder_access
        WHERE responder_access.org_id = p_org_id
          AND responder_access.companion_id = p_companion_id
          AND responder_access.role = 'editor'
        FOR NO KEY UPDATE;
        v_responder_authorized := FOUND;
      END IF;
      IF NOT v_responder_authorized THEN
        v_denial_code := 'decision_actor_access_revoked';
      END IF;
    ELSIF v_denial_code IS NULL AND p_work_kind = 'decision'
          AND v_decision_actor_id IS NULL AND v_decision_status <> 'expired' THEN
      v_denial_code := 'decision_actor_missing';
    END IF;
  END IF;

  IF v_denial_code IS NULL AND v_requires_resources THEN
    IF jsonb_typeof(v_provider_ids) <> 'array'
       OR (v_requires_skills_mcp AND jsonb_typeof(v_skill_ids) <> 'array')
       OR (v_requires_skills_mcp AND v_has_pinned_resources
           AND jsonb_typeof(v_attempt_skill_refs) <> 'array')
       OR (v_requires_skills_mcp AND jsonb_typeof(v_mcp_ids) <> 'array') THEN
      v_denial_code := 'invalid_resource_selection';
    ELSIF jsonb_array_length(v_provider_ids) <> 1
       OR v_model_id IS NULL
       OR char_length(v_model_id) NOT BETWEEN 1 AND 200
       OR v_model_id ~ E'[\n\r]' THEN
      v_denial_code := 'invalid_model_selection';
    ELSIF EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_provider_ids) selected(provider_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.companion_provider_connections p
        WHERE p.org_id = p_org_id AND p.provider_id = selected.provider_id
        FOR NO KEY UPDATE
      )
    ) THEN
      v_denial_code := 'provider_access_revoked';
    ELSIF v_requires_skills_mcp AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_skill_ids) selected(skill_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.skills s
        WHERE s.org_id = p_org_id
          AND s.id::text = selected.skill_id
          AND s.archived_at IS NULL
          AND (
            s.scope = 'org'
            OR (
              s.creator_id = v_authorization_actor_id
              AND (v_decision_actor_id IS NULL OR s.creator_id = v_decision_actor_id)
            )
          )
        FOR NO KEY UPDATE
      )
    ) THEN
      v_denial_code := 'skill_access_revoked';
    ELSIF v_requires_skills_mcp AND v_has_pinned_resources AND (
      EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_attempt_skill_refs) pinned(ref)
        WHERE jsonb_typeof(pinned.ref) <> 'object'
           OR COALESCE(jsonb_typeof(pinned.ref -> 'skill_id'), 'missing') <> 'string'
           OR COALESCE(jsonb_typeof(pinned.ref -> 'current_version_id'), 'missing')
                NOT IN ('string', 'null')
           OR NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements_text(v_skill_ids) selected(skill_id)
             WHERE selected.skill_id = pinned.ref ->> 'skill_id'
           )
           OR (
             pinned.ref ->> 'current_version_id' IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
               FROM public.skill_versions pinned_version
               WHERE pinned_version.org_id = p_org_id
                 AND pinned_version.skill_id::text = pinned.ref ->> 'skill_id'
                 AND pinned_version.id::text = pinned.ref ->> 'current_version_id'
               FOR KEY SHARE
             )
           )
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(v_skill_ids) selected(skill_id)
        WHERE NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_attempt_skill_refs) pinned(ref)
          WHERE pinned.ref ->> 'skill_id' = selected.skill_id
        )
      )
    ) THEN
      v_denial_code := 'invalid_resource_selection';
    ELSIF v_requires_skills_mcp AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_mcp_ids) selected(account_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.companion_mcp_accounts a
        WHERE a.org_id = p_org_id
          AND a.id::text = selected.account_id
          AND a.owner_id = v_authorization_actor_id
          AND (v_decision_actor_id IS NULL OR a.owner_id = v_decision_actor_id)
        FOR NO KEY UPDATE
      )
    ) THEN
      v_denial_code := 'mcp_access_revoked';
    END IF;
  END IF;

  -- Re-sample after authorization/resource reads: those reads can wait behind concurrent ACL or
  -- configuration writes. Deadlines are authority boundaries, not informational timestamps.
  v_now := clock_timestamp();
  IF p_work_kind IN ('attempt', 'decision')
     AND v_absolute_deadline_at IS NOT NULL
     AND v_now >= v_absolute_deadline_at THEN
    v_denial_code := 'absolute_deadline_exceeded';
  ELSIF p_work_kind IN ('attempt', 'decision')
        AND v_inactivity_deadline_at IS NOT NULL
        AND v_now >= v_inactivity_deadline_at THEN
    v_denial_code := 'inactivity_deadline_exceeded';
  -- The three-minute cold-send budget follows the source turn across Start settlement and the
  -- attempt boundary. Once Pi has acknowledged the prompt, normal attempt deadlines take over.
  ELSIF v_cold_start_deadline_at IS NOT NULL
        AND v_now >= v_cold_start_deadline_at
        AND (
          (p_work_kind = 'operation' AND v_operation_kind IN ('start', 'apply_settings'))
          OR p_work_kind = 'settings'
          OR (p_work_kind = 'attempt' AND v_dispatch_state <> 'accepted')
        ) THEN
    v_denial_code := 'cold_start_deadline_exceeded';
  END IF;

  IF v_denial_code IS NOT NULL THEN
    RETURN QUERY SELECT
      false, v_denial_code, v_lease_expires_at,
      NULL::text, NULL::text, v_client_surface, NULL::bigint, NULL::text,
      NULL::public.companion_box_observed_state,
      NULL::public.companion_pi_observed_state,
      NULL::text, NULL::integer, NULL::bigint, NULL::integer, NULL::text,
      NULL::text, NULL::boolean,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NULL::bigint, NULL::integer,
      v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id, v_turn_status,
      v_attempt_status, v_dispatch_state, v_event_cursor,
      v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
      v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
      v_operation_kind, v_operation_started_at, v_operation_attempt_count,
      v_operation_provider_operation_id,
      v_operation_target_settings_revision, v_operation_target_skills_revision,
      v_decision_status, v_decision_delivery_state,
      NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_requires_resources THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'provider_id', p.provider_id,
      'credential_generation', p.credential_generation,
      'credential_version', p.credential_version
    ) ORDER BY p.provider_id), '[]'::jsonb)
    INTO v_provider_refs
    FROM public.companion_provider_connections p
    WHERE p.org_id = p_org_id
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(v_provider_ids) selected(provider_id)
        WHERE selected.provider_id = p.provider_id
      );

    IF v_requires_skills_mcp THEN
      IF v_has_pinned_resources THEN
        v_skill_refs := v_attempt_skill_refs;
      ELSE
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'skill_id', s.id,
          'current_version_id', s.current_version_id
        ) ORDER BY s.id), '[]'::jsonb)
        INTO v_skill_refs
        FROM public.skills s
        WHERE s.org_id = p_org_id
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(v_skill_ids) selected(skill_id)
            WHERE selected.skill_id = s.id::text
          );
      END IF;

      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'account_id', a.id,
        'credential_generation', a.credential_generation
      ) ORDER BY a.id), '[]'::jsonb)
      INTO v_mcp_refs
      FROM public.companion_mcp_accounts a
      WHERE a.org_id = p_org_id
        AND a.owner_id = v_authorization_actor_id
        AND (v_decision_actor_id IS NULL OR a.owner_id = v_decision_actor_id)
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(v_mcp_ids) selected(account_id)
          WHERE selected.account_id = a.id::text
        );
    END IF;
  END IF;

  -- Authorization may have waited on instance or ACL row locks. Re-sample wall time at the final
  -- fence so a call that began before expiry can never return authority after expiry or publish an
  -- already-dead renewal. Holding the lease-row lock prevents takeover between this CAS and return.
  v_now := clock_timestamp();
  UPDATE public.companion_runtime_leases l
  SET renewed_at = v_now,
      expires_at = v_now + make_interval(secs => p_lease_seconds),
      updated_at = v_now
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp()
    AND NOT (
      p_work_kind IN ('attempt', 'decision')
      AND (
        (v_absolute_deadline_at IS NOT NULL AND v_now >= v_absolute_deadline_at)
        OR (v_inactivity_deadline_at IS NOT NULL AND v_now >= v_inactivity_deadline_at)
      )
    )
    AND NOT (
      v_cold_start_deadline_at IS NOT NULL
      AND v_now >= v_cold_start_deadline_at
      AND (
        (p_work_kind = 'operation' AND v_operation_kind IN ('start', 'apply_settings'))
        OR p_work_kind = 'settings'
        OR (p_work_kind = 'attempt' AND v_dispatch_state <> 'accepted')
      )
    )
    AND EXISTS (
      SELECT 1
      FROM public.companion_runtime_control current_gate
      WHERE current_gate.id = 'runtime-v2'
        AND current_gate.enabled
        AND current_gate.gate_epoch = p_gate_epoch
    )
  RETURNING l.expires_at INTO v_lease_expires_at;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY SELECT
    true, NULL::text, v_lease_expires_at,
    v_authorization_actor_id, v_decision_actor_id, v_client_surface,
    v_generation, v_box_id,
    v_box_state, v_pi_state, v_pi_invocation_id, v_disk_layout_version,
    v_applied_settings_revision, v_applied_skills_revision,
    CASE WHEN v_requires_resources THEN v_model_id ELSE NULL END,
    CASE WHEN v_requires_resources THEN v_persona ELSE NULL END,
    CASE WHEN v_requires_resources THEN v_can_write_skills ELSE NULL END,
    v_provider_refs, v_skill_refs, v_mcp_refs,
    v_desired_settings_revision, v_skills_revision,
    v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id, v_turn_status,
    v_attempt_status, v_dispatch_state, v_event_cursor,
    v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
    v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
    v_operation_kind, v_operation_started_at, v_operation_attempt_count,
    v_operation_provider_operation_id,
    v_operation_target_settings_revision, v_operation_target_skills_revision,
    v_decision_status, v_decision_delivery_state,
    v_decision_request_key, v_decision_response_text;
END
$$;
--> statement-breakpoint

-- Persist one idempotent checkpoint. expected_sequence is a CAS token; provider operation ids,
-- command ids, Pi invocation ids, event cursors, and parser counters may be set/advanced but never
-- replaced or rewound. A stale or expired lease returns NULL and writes nothing.
CREATE FUNCTION public.companion_runtime_checkpoint(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_expected_sequence bigint,
  p_next_checkpoint text,
  p_provider_operation_id text,
  p_command_id uuid,
  p_pi_invocation_id text,
  p_event_cursor bigint,
  p_activity_at timestamp with time zone,
  p_unknown_event_count integer,
  p_malformed_event_count integer,
  p_oversized_event_count integer
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_lease_expires_at timestamp with time zone;
  v_next_sequence bigint;
  v_attempt_status public.companion_attempt_status;
  v_dispatch_state public.companion_dispatch_state;
  v_turn_id uuid;
  v_cold_start_deadline timestamp with time zone;
  v_inactivity_deadline timestamp with time zone;
  v_absolute_deadline timestamp with time zone;
  v_activity_at timestamp with time zone;
  v_existing_activity_at timestamp with time zone;
  v_current_checkpoint text;
  v_operation_kind public.companion_operation_kind;
  v_box_id text;
  v_box_state public.companion_box_observed_state;
  v_disk_layout_version integer;
  v_pi_state public.companion_pi_observed_state;
  v_observed_pi_invocation_id text;
  v_attempt_pi_invocation_id text;
BEGIN
  IF p_expected_sequence < 0
     OR p_next_checkpoint IS NULL
     OR char_length(p_next_checkpoint) NOT BETWEEN 1 AND 64
     OR p_next_checkpoint !~ '^[a-z][a-z0-9_]{0,63}$'
     OR (p_provider_operation_id IS NOT NULL AND (
       char_length(p_provider_operation_id) NOT BETWEEN 1 AND 200
       OR p_provider_operation_id ~ E'[\n\r]'
     ))
     OR (p_pi_invocation_id IS NOT NULL AND (
       char_length(p_pi_invocation_id) NOT BETWEEN 1 AND 200
       OR p_pi_invocation_id ~ E'[\n\r]'
     ))
     OR (p_event_cursor IS NOT NULL AND p_event_cursor < 0)
     OR (p_unknown_event_count IS NOT NULL AND p_unknown_event_count < 0)
     OR (p_malformed_event_count IS NOT NULL AND p_malformed_event_count < 0)
     OR (p_oversized_event_count IS NOT NULL AND p_oversized_event_count < 0)
     OR (
       (p_unknown_event_count IS NOT NULL
        OR p_malformed_event_count IS NOT NULL
        OR p_oversized_event_count IS NOT NULL)
       AND (p_work_kind <> 'attempt' OR p_next_checkpoint <> 'event_projected'
            OR p_event_cursor IS NULL)
     )
     OR (p_activity_at IS NOT NULL AND p_activity_at > v_now + interval '5 minutes') THEN
    RAISE EXCEPTION 'invalid Runtime v2 checkpoint arguments' USING ERRCODE = '22023';
  END IF;

  SELECT l.expires_at INTO v_lease_expires_at
  FROM public.companion_runtime_leases l
  JOIN public.companion_runtime_control c ON c.id = 'runtime-v2'
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp()
    AND c.enabled
    AND c.gate_epoch = p_gate_epoch
  FOR UPDATE OF l;
  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM 1
  FROM public.companion_runtime_instances i
  WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_now := clock_timestamp();
  IF v_lease_expires_at <= v_now THEN RETURN NULL; END IF;

  IF p_work_kind = 'operation' THEN
    SELECT o.kind, o.checkpoint, i.box_id, i.box_state,
           i.disk_layout_version,
           i.pi_state, i.pi_invocation_id, t.cold_start_deadline_at
    INTO v_operation_kind, v_current_checkpoint, v_box_id, v_box_state,
         v_disk_layout_version, v_pi_state, v_observed_pi_invocation_id,
         v_cold_start_deadline
    FROM public.companion_operations o
    JOIN public.companion_runtime_instances i
      ON i.org_id = o.org_id AND i.companion_id = o.companion_id
    LEFT JOIN public.companion_turns t
      ON t.org_id = o.org_id AND t.companion_id = o.companion_id AND t.id = o.source_turn_id
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.id = p_work_id AND o.status = 'running' AND o.claim_epoch = p_claim_epoch
      AND o.checkpoint_sequence = p_expected_sequence
    FOR UPDATE OF o;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         v_operation_kind IN ('start', 'apply_settings')
         AND v_cold_start_deadline IS NOT NULL
         AND v_now >= v_cold_start_deadline
       ) THEN
      RETURN NULL;
    END IF;
    IF NOT (
      (v_operation_kind = 'start' AND (
        (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'resolving_box')
        OR (v_current_checkpoint = 'box_absence_observed' AND p_next_checkpoint = 'creating_box')
        -- creating_box is the durable pre-POST write intent. Only observe_instance may attach the
        -- returned Box id and advance it to box_created; a takeover must never resend the POST.
        OR (v_current_checkpoint = 'box_resolved' AND p_next_checkpoint = 'waiting_ready')
        OR (v_current_checkpoint = 'box_created' AND p_next_checkpoint = 'waiting_ready')
        OR (v_current_checkpoint = 'box_ready_observed' AND p_next_checkpoint = 'installing_layout')
        OR (v_current_checkpoint = 'installing_layout' AND p_next_checkpoint = 'starting_pi')
        OR (v_current_checkpoint = 'pi_observed' AND p_next_checkpoint = 'pi_ready')
      ))
      OR (v_operation_kind = 'stop' AND (
        (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'stopping_pi')
        OR (v_current_checkpoint = 'stopping_pi' AND p_next_checkpoint = 'provider_stop_requested')
        OR (v_current_checkpoint = 'provider_stop_requested' AND p_next_checkpoint = 'waiting_archived')
      ))
      OR (v_operation_kind = 'restart_pi' AND (
        (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'restarting_pi')
        OR (v_current_checkpoint = 'restarting_pi' AND p_next_checkpoint = 'starting_pi')
        OR (v_current_checkpoint = 'pi_observed' AND p_next_checkpoint = 'pi_ready')
      ))
      OR (v_operation_kind = 'restart_box' AND (
        (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'restarting_box')
        OR (v_current_checkpoint = 'restarting_box' AND p_next_checkpoint = 'waiting_ready')
        OR (v_current_checkpoint = 'box_ready_observed' AND p_next_checkpoint = 'installing_layout')
        OR (v_current_checkpoint = 'installing_layout' AND p_next_checkpoint = 'starting_pi')
        OR (v_current_checkpoint = 'pi_observed' AND p_next_checkpoint = 'pi_ready')
      ))
      OR (v_operation_kind = 'apply_settings'
          AND v_current_checkpoint = 'pending' AND p_next_checkpoint = 'applying_settings')
      OR (v_operation_kind = 'delete' AND (
        (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'provider_delete_requested')
        OR (v_current_checkpoint = 'box_absence_observed'
            AND p_next_checkpoint = 'provider_delete_requested')
        OR (v_current_checkpoint = 'provider_delete_requested' AND p_next_checkpoint = 'waiting_deleted')
      ))
    ) THEN
      RAISE EXCEPTION 'invalid operation checkpoint transition' USING ERRCODE = '22023';
    END IF;
    IF p_next_checkpoint = 'creating_box' AND v_box_id IS NOT NULL THEN
      RAISE EXCEPTION 'Box creation requires an absent canonical Box id' USING ERRCODE = '22023';
    END IF;
    IF p_next_checkpoint = 'waiting_ready' AND v_box_id IS NULL THEN
      RAISE EXCEPTION 'waiting_ready requires a canonical Box id' USING ERRCODE = '22023';
    END IF;
    IF p_next_checkpoint = 'installing_layout'
       AND (v_box_id IS NULL OR v_box_state NOT IN ('ready', 'idle', 'running')) THEN
      RAISE EXCEPTION 'layout installation requires an observed ready Box' USING ERRCODE = '22023';
    END IF;
    IF p_next_checkpoint = 'starting_pi'
       AND v_operation_kind IN ('start', 'restart_pi', 'restart_box')
       AND v_disk_layout_version IS DISTINCT FROM 14 THEN
      RAISE EXCEPTION 'starting_pi requires disk layout version 14' USING ERRCODE = '22023';
    END IF;
    IF p_next_checkpoint = 'pi_ready'
       AND (
         v_box_id IS NULL
         OR v_disk_layout_version IS DISTINCT FROM 14
         OR v_pi_state <> 'idle'
         OR v_observed_pi_invocation_id IS NULL
       ) THEN
      RAISE EXCEPTION 'pi_ready requires disk layout version 14 and an observed idle Pi invocation'
        USING ERRCODE = '22023';
    END IF;
    IF p_next_checkpoint = 'provider_delete_requested'
       AND (p_provider_operation_id IS NULL OR v_box_id IS NULL) THEN
      RAISE EXCEPTION 'provider delete requires a canonical Box id and operation id'
        USING ERRCODE = '22023';
    END IF;
    IF p_next_checkpoint = 'box_absent' AND (
         p_provider_operation_id IS NOT NULL
         OR v_box_state <> 'absent'
       ) THEN
      RAISE EXCEPTION 'box_absent requires operation-bound provider absence evidence'
        USING ERRCODE = '22023';
    END IF;

    UPDATE public.companion_operations o
    SET checkpoint = p_next_checkpoint,
        checkpoint_sequence = o.checkpoint_sequence + 1,
        provider_operation_id = COALESCE(o.provider_operation_id, p_provider_operation_id),
        updated_at = v_now
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.id = p_work_id AND o.status = 'running' AND o.claim_epoch = p_claim_epoch
      AND o.checkpoint_sequence = p_expected_sequence
      AND (p_provider_operation_id IS NULL OR o.provider_operation_id IS NULL
           OR o.provider_operation_id = p_provider_operation_id)
    RETURNING o.checkpoint_sequence INTO v_next_sequence;

  ELSIF p_work_kind = 'attempt' THEN
    v_attempt_status := CASE p_next_checkpoint
      WHEN 'starting' THEN 'starting'::public.companion_attempt_status
      WHEN 'dispatch_write_intent' THEN 'dispatching'::public.companion_attempt_status
      WHEN 'dispatch_accepted' THEN 'running'::public.companion_attempt_status
      WHEN 'dispatch_ambiguous' THEN 'dispatching'::public.companion_attempt_status
      WHEN 'dispatch_rejected' THEN 'dispatching'::public.companion_attempt_status
      WHEN 'running' THEN 'running'::public.companion_attempt_status
      WHEN 'needs_input' THEN 'needs_input'::public.companion_attempt_status
      WHEN 'event_projected' THEN NULL
      WHEN 'agent_settled' THEN 'running'::public.companion_attempt_status
      ELSE NULL
    END;
    IF v_attempt_status IS NULL AND p_next_checkpoint <> 'event_projected' THEN
      RAISE EXCEPTION 'invalid attempt checkpoint' USING ERRCODE = '22023';
    END IF;
    v_dispatch_state := CASE p_next_checkpoint
      WHEN 'dispatch_write_intent' THEN 'write_intent'::public.companion_dispatch_state
      WHEN 'dispatch_accepted' THEN 'accepted'::public.companion_dispatch_state
      WHEN 'dispatch_ambiguous' THEN 'ambiguous'::public.companion_dispatch_state
      WHEN 'dispatch_rejected' THEN 'rejected'::public.companion_dispatch_state
      ELSE NULL
    END;
    IF p_next_checkpoint IN ('dispatch_write_intent', 'dispatch_accepted', 'dispatch_ambiguous', 'dispatch_rejected')
       AND p_command_id IS NULL THEN
      RAISE EXCEPTION 'dispatch checkpoint requires command id' USING ERRCODE = '22023';
    END IF;

    SELECT a.turn_id, t.cold_start_deadline_at, t.inactivity_deadline_at,
           t.absolute_deadline_at, a.last_activity_at, a.checkpoint,
           a.pi_invocation_id
    INTO v_turn_id, v_cold_start_deadline, v_inactivity_deadline,
         v_absolute_deadline, v_existing_activity_at, v_current_checkpoint,
         v_attempt_pi_invocation_id
    FROM public.companion_turn_attempts a
    JOIN public.companion_turns t
      ON t.org_id = a.org_id AND t.companion_id = a.companion_id AND t.id = a.turn_id
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.id = p_work_id AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
      AND a.claim_epoch = p_claim_epoch
    FOR UPDATE OF a, t;
    IF NOT FOUND THEN RETURN NULL; END IF;

    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now THEN RETURN NULL; END IF;
    IF (
         (v_absolute_deadline IS NOT NULL AND v_now >= v_absolute_deadline)
         OR (v_inactivity_deadline IS NOT NULL AND v_now >= v_inactivity_deadline)
       )
       AND p_next_checkpoint NOT IN ('dispatch_ambiguous', 'dispatch_rejected') THEN
      RETURN NULL;
    END IF;
    IF v_cold_start_deadline IS NOT NULL
       AND v_now >= v_cold_start_deadline
       AND (
         v_current_checkpoint = 'starting'
         OR (v_current_checkpoint = 'dispatch_write_intent'
             AND p_next_checkpoint = 'dispatch_accepted')
       ) THEN
      RETURN NULL;
    END IF;

    IF NOT (
      (v_current_checkpoint = 'starting' AND p_next_checkpoint = 'dispatch_write_intent')
      OR (v_current_checkpoint = 'dispatch_write_intent'
          AND p_next_checkpoint IN ('dispatch_accepted', 'dispatch_ambiguous', 'dispatch_rejected'))
      OR (v_current_checkpoint = 'dispatch_accepted'
          AND p_next_checkpoint IN ('running', 'needs_input', 'event_projected', 'agent_settled'))
      OR (v_current_checkpoint = 'running'
          AND p_next_checkpoint IN ('running', 'needs_input', 'event_projected', 'agent_settled'))
      OR (v_current_checkpoint = 'event_projected'
          AND p_next_checkpoint IN ('running', 'needs_input', 'event_projected', 'agent_settled'))
      OR (v_current_checkpoint = 'needs_input'
          AND p_next_checkpoint IN ('running', 'event_projected', 'agent_settled'))
    ) THEN
      RAISE EXCEPTION 'invalid attempt checkpoint transition' USING ERRCODE = '22023';
    END IF;

    IF p_next_checkpoint = 'dispatch_accepted'
       AND (
         p_pi_invocation_id IS NULL
         OR (
           v_attempt_pi_invocation_id IS NOT NULL
           AND p_pi_invocation_id <> v_attempt_pi_invocation_id
         )
       ) THEN
      RAISE EXCEPTION 'dispatch_accepted requires a stable Pi invocation id'
        USING ERRCODE = '22023';
    END IF;
    IF p_next_checkpoint = 'agent_settled'
       AND (
         v_attempt_pi_invocation_id IS NULL
         OR p_pi_invocation_id IS NULL
         OR p_pi_invocation_id <> v_attempt_pi_invocation_id
       ) THEN
      RAISE EXCEPTION 'agent_settled must preserve the accepted Pi invocation id'
        USING ERRCODE = '22023';
    END IF;

    v_activity_at := CASE
      WHEN p_next_checkpoint = 'dispatch_accepted' THEN
        GREATEST(
          COALESCE(v_existing_activity_at, '-infinity'::timestamp with time zone),
          LEAST(COALESCE(p_activity_at, v_now), v_now)
        )
      WHEN p_activity_at IS NOT NULL THEN
        GREATEST(
          COALESCE(v_existing_activity_at, '-infinity'::timestamp with time zone),
          LEAST(p_activity_at, v_now)
        )
      ELSE v_existing_activity_at
    END;

    UPDATE public.companion_turn_attempts a
    SET status = COALESCE(v_attempt_status, a.status),
        checkpoint = p_next_checkpoint,
        checkpoint_sequence = a.checkpoint_sequence + 1,
        dispatch_state = COALESCE(v_dispatch_state, a.dispatch_state),
        dispatch_count = a.dispatch_count + CASE WHEN p_next_checkpoint = 'dispatch_write_intent' THEN 1 ELSE 0 END,
        command_id = COALESCE(a.command_id, p_command_id),
        dispatch_started_at = CASE
          WHEN p_next_checkpoint = 'dispatch_write_intent' THEN COALESCE(a.dispatch_started_at, v_now)
          ELSE a.dispatch_started_at
        END,
        dispatch_accepted_at = CASE
          WHEN p_next_checkpoint = 'dispatch_accepted' THEN COALESCE(a.dispatch_accepted_at, v_now)
          ELSE a.dispatch_accepted_at
        END,
        pi_invocation_id = COALESCE(a.pi_invocation_id, p_pi_invocation_id),
        event_cursor = COALESCE(p_event_cursor, a.event_cursor),
        unknown_event_count = COALESCE(p_unknown_event_count, a.unknown_event_count),
        malformed_event_count = COALESCE(p_malformed_event_count, a.malformed_event_count),
        oversized_event_count = COALESCE(p_oversized_event_count, a.oversized_event_count),
        last_activity_at = v_activity_at,
        updated_at = v_now
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.id = p_work_id AND a.claim_epoch = p_claim_epoch
      AND a.checkpoint_sequence = p_expected_sequence
      AND (p_command_id IS NULL OR a.command_id IS NULL OR a.command_id = p_command_id)
      AND (p_pi_invocation_id IS NULL OR a.pi_invocation_id IS NULL OR a.pi_invocation_id = p_pi_invocation_id)
      AND (p_event_cursor IS NULL OR p_event_cursor >= a.event_cursor)
      AND (p_unknown_event_count IS NULL OR p_unknown_event_count >= a.unknown_event_count)
      AND (p_malformed_event_count IS NULL OR p_malformed_event_count >= a.malformed_event_count)
      AND (p_oversized_event_count IS NULL OR p_oversized_event_count >= a.oversized_event_count)
      AND (
        (
          COALESCE(p_unknown_event_count, a.unknown_event_count) = a.unknown_event_count
          AND COALESCE(p_malformed_event_count, a.malformed_event_count) = a.malformed_event_count
          AND COALESCE(p_oversized_event_count, a.oversized_event_count) = a.oversized_event_count
        )
        OR p_event_cursor > a.event_cursor
      )
    RETURNING a.checkpoint_sequence INTO v_next_sequence;

    IF v_next_sequence IS NOT NULL THEN
      UPDATE public.companion_turns t
      SET status = COALESCE(v_attempt_status::text, t.status::text)::public.companion_turn_status,
          inactivity_deadline_at = CASE
            WHEN v_activity_at IS NULL THEN t.inactivity_deadline_at
            ELSE LEAST(t.absolute_deadline_at, v_activity_at + interval '10 minutes')
          END,
          state_changed_at = CASE
            WHEN v_attempt_status IS NULL OR t.status::text = v_attempt_status::text THEN t.state_changed_at
            ELSE v_now
          END,
          updated_at = v_now
      WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id AND t.id = v_turn_id;
    END IF;

  ELSIF p_work_kind = 'decision' THEN
    IF p_next_checkpoint NOT IN ('write_intent', 'ambiguous') OR p_command_id IS NULL THEN
      RAISE EXCEPTION 'invalid decision delivery checkpoint' USING ERRCODE = '22023';
    END IF;
    SELECT d.delivery_checkpoint, t.inactivity_deadline_at, t.absolute_deadline_at
    INTO v_current_checkpoint, v_inactivity_deadline, v_absolute_deadline
    FROM public.companion_decision_deliveries d
    JOIN public.companion_turns t
      ON t.org_id = d.org_id AND t.companion_id = d.companion_id AND t.id = d.turn_id
    WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
      AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
      AND d.decision_status <> 'pending'
      AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
      AND d.delivery_checkpoint_sequence = p_expected_sequence
    FOR UPDATE OF d, t;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         (
           (v_absolute_deadline IS NOT NULL AND v_now >= v_absolute_deadline)
           OR (v_inactivity_deadline IS NOT NULL AND v_now >= v_inactivity_deadline)
         )
         AND p_next_checkpoint <> 'ambiguous'
       ) THEN
      RETURN NULL;
    END IF;
    IF NOT (
      (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'write_intent')
      OR (v_current_checkpoint = 'write_intent' AND p_next_checkpoint = 'ambiguous')
    ) THEN
      RAISE EXCEPTION 'invalid decision checkpoint transition' USING ERRCODE = '22023';
    END IF;

    UPDATE public.companion_decision_deliveries d
    SET delivery_state = p_next_checkpoint::public.companion_decision_delivery_state,
        delivery_checkpoint = p_next_checkpoint,
        delivery_checkpoint_sequence = d.delivery_checkpoint_sequence + 1,
        command_id = COALESCE(d.command_id, p_command_id),
        delivery_started_at = COALESCE(d.delivery_started_at, v_now),
        updated_at = v_now
    WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
      AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
      AND d.decision_status <> 'pending'
      AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
      AND d.delivery_checkpoint_sequence = p_expected_sequence
      AND (d.command_id IS NULL OR d.command_id = p_command_id)
    RETURNING d.delivery_checkpoint_sequence INTO v_next_sequence;

  ELSIF p_work_kind = 'settings' THEN
    IF p_next_checkpoint <> 'applying' THEN
      RAISE EXCEPTION 'invalid settings checkpoint' USING ERRCODE = '22023';
    END IF;
    SELECT i.settings_claim_cold_start_deadline_at
    INTO v_cold_start_deadline
    FROM public.companion_runtime_instances i
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id AND i.settings_claim_epoch = p_claim_epoch
      AND i.settings_checkpoint_sequence = p_expected_sequence;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (v_cold_start_deadline IS NOT NULL AND v_now >= v_cold_start_deadline) THEN
      RETURN NULL;
    END IF;
    UPDATE public.companion_runtime_instances i
    SET settings_checkpoint = p_next_checkpoint,
        settings_checkpoint_sequence = i.settings_checkpoint_sequence + 1,
        updated_at = v_now
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id AND i.settings_claim_epoch = p_claim_epoch
      AND i.settings_checkpoint_sequence = p_expected_sequence
    RETURNING i.settings_checkpoint_sequence INTO v_next_sequence;

  ELSIF p_work_kind = 'health' THEN
    IF p_next_checkpoint <> 'observing' THEN
      RAISE EXCEPTION 'invalid health checkpoint' USING ERRCODE = '22023';
    END IF;
    UPDATE public.companion_runtime_instances i
    SET health_checkpoint = p_next_checkpoint,
        health_checkpoint_sequence = i.health_checkpoint_sequence + 1,
        updated_at = v_now
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id AND i.health_claim_epoch = p_claim_epoch
      AND i.health_checkpoint_sequence = p_expected_sequence
    RETURNING i.health_checkpoint_sequence INTO v_next_sequence;
  END IF;

  IF v_next_sequence IS NOT NULL THEN
    UPDATE public.companion_runtime_instances i
    SET last_write_epoch = GREATEST(i.last_write_epoch, p_claim_epoch), updated_at = v_now
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
  END IF;
  RETURN v_next_sequence;
END
$$;
--> statement-breakpoint

-- Persist only the sanitized, authoritative instance projection. This is the runtime role's sole
-- write surface for Box/Pi observations: it carries the same lease/gate/work fence as checkpoint,
-- rejects stale generations/timestamps, and never accepts provider payloads, URLs, or secrets.
-- For start, creating_box is the pre-POST write intent. Recording a returned or deterministically
-- rediscovered Box id atomically advances it to box_created. No generic checkpoint can leave
-- creating_box, so takeover must list the generation-qualified name and must never resend POST.
CREATE FUNCTION public.companion_runtime_observe_instance(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_runtime_generation bigint,
  p_expected_checkpoint_sequence bigint,
  p_box_id text,
  p_box_state public.companion_box_observed_state,
  p_pi_state public.companion_pi_observed_state,
  p_pi_invocation_id text,
  p_disk_layout_version integer,
  p_applied_settings_revision bigint,
  p_applied_skills_revision integer,
  p_observed_at timestamp with time zone
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_lease_expires_at timestamp with time zone;
  v_generation bigint;
  v_box_id text;
  v_pi_invocation_id text;
  v_disk_layout_version integer;
  v_desired_settings_revision bigint;
  v_applied_settings_revision bigint;
  v_applied_skills_revision integer;
  v_skills_revision integer;
  v_last_observed_at timestamp with time zone;
  v_checkpoint text;
  v_checkpoint_sequence bigint;
  v_operation_kind public.companion_operation_kind;
  v_client_surface public.companion_client_surface := 'web';
  v_target_settings_revision bigint;
  v_target_skills_revision integer;
  v_observation_checkpoint text;
  v_checkpoint_updated_at timestamp with time zone;
  v_ambiguous_create_interrupted_at timestamp with time zone;
  v_delete_create_ambiguous boolean := false;
  v_settings_claim_revision bigint;
  v_settings_claim_skills_revision integer;
  v_cold_start_deadline timestamp with time zone;
  v_next_sequence bigint;
BEGIN
  IF p_runtime_generation < 1
     OR p_expected_checkpoint_sequence < 0
     OR p_observed_at IS NULL
     OR p_observed_at > v_now + interval '5 minutes'
     OR (p_box_id IS NOT NULL AND p_box_id !~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$')
     OR (p_pi_invocation_id IS NOT NULL AND (
       char_length(p_pi_invocation_id) NOT BETWEEN 1 AND 200
       OR p_pi_invocation_id ~ E'[\n\r]'
     ))
     OR (p_disk_layout_version IS NOT NULL
       AND p_disk_layout_version NOT BETWEEN 0 AND 1000000)
     OR (p_applied_settings_revision IS NOT NULL AND p_applied_settings_revision < 0)
     OR (p_applied_skills_revision IS NOT NULL AND p_applied_skills_revision < 0)
     OR (p_box_id IS NULL AND p_box_state IS NULL AND p_pi_state IS NULL
       AND p_pi_invocation_id IS NULL AND p_disk_layout_version IS NULL
       AND p_applied_settings_revision IS NULL AND p_applied_skills_revision IS NULL)
     OR p_work_kind NOT IN ('operation', 'settings', 'health') THEN
    RAISE EXCEPTION 'invalid Runtime v2 instance observation' USING ERRCODE = '22023';
  END IF;

  SELECT l.expires_at INTO v_lease_expires_at
  FROM public.companion_runtime_leases l
  JOIN public.companion_runtime_control c ON c.id = 'runtime-v2'
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp()
    AND c.enabled
    AND c.gate_epoch = p_gate_epoch
  FOR UPDATE OF l;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT i.generation, i.box_id, i.pi_invocation_id, i.disk_layout_version,
         i.desired_settings_revision, i.applied_settings_revision,
         i.applied_skills_revision, c.skills_revision, i.last_observed_at
  INTO v_generation, v_box_id, v_pi_invocation_id, v_disk_layout_version,
       v_desired_settings_revision, v_applied_settings_revision,
       v_applied_skills_revision, v_skills_revision, v_last_observed_at
  FROM public.companion_runtime_instances i
  JOIN public.companions c
    ON c.org_id = i.org_id AND c.id = i.companion_id
  WHERE i.org_id = p_org_id
    AND i.companion_id = p_companion_id
    AND i.generation = p_runtime_generation
  FOR UPDATE OF i;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_now := clock_timestamp();
  IF v_lease_expires_at <= v_now THEN RETURN NULL; END IF;

  IF (v_last_observed_at IS NOT NULL AND p_observed_at < v_last_observed_at)
     OR (p_disk_layout_version IS NOT NULL AND p_disk_layout_version < v_disk_layout_version)
     OR (p_applied_settings_revision IS NOT NULL AND (
       p_applied_settings_revision < v_applied_settings_revision
       OR p_applied_settings_revision > v_desired_settings_revision
     ))
     OR (p_applied_skills_revision IS NOT NULL AND (
       p_applied_skills_revision < v_applied_skills_revision
       OR p_applied_skills_revision > v_skills_revision
     )) THEN
    RETURN NULL;
  END IF;

  -- A Box id is immutable within one runtime generation. Delete settlement, not an observation,
  -- is the only path that clears it after terminal provider evidence.
  IF p_box_id IS NOT NULL AND v_box_id IS NOT NULL AND p_box_id <> v_box_id THEN
    RAISE EXCEPTION 'Box id is immutable within a runtime generation' USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation' THEN
    SELECT o.kind, o.client_surface,
           o.checkpoint, o.checkpoint_sequence,
           o.target_settings_revision, o.target_skills_revision,
           t.cold_start_deadline_at, o.updated_at
    INTO v_operation_kind, v_client_surface, v_checkpoint, v_checkpoint_sequence,
         v_target_settings_revision, v_target_skills_revision,
         v_cold_start_deadline, v_checkpoint_updated_at
    FROM public.companion_operations o
    LEFT JOIN public.companion_turns t
      ON t.org_id = o.org_id AND t.companion_id = o.companion_id AND t.id = o.source_turn_id
    WHERE o.org_id = p_org_id
      AND o.companion_id = p_companion_id
      AND o.id = p_work_id
      AND o.runtime_generation = p_runtime_generation
      AND o.status = 'running'
      AND o.claim_epoch = p_claim_epoch
      AND o.checkpoint_sequence = p_expected_checkpoint_sequence
    FOR UPDATE OF o;
    IF NOT FOUND THEN RETURN NULL; END IF;

    IF v_operation_kind = 'delete' THEN
      SELECT MAX(ambiguous_start.updated_at)
      INTO v_ambiguous_create_interrupted_at
      FROM public.companion_operations ambiguous_start
      WHERE ambiguous_start.org_id = p_org_id
        AND ambiguous_start.companion_id = p_companion_id
        AND ambiguous_start.runtime_generation = p_runtime_generation
        AND ambiguous_start.kind = 'start'
        AND ambiguous_start.status = 'interrupted'
        AND ambiguous_start.checkpoint = 'creating_box';
      v_delete_create_ambiguous := v_ambiguous_create_interrupted_at IS NOT NULL;
    END IF;
  ELSIF p_work_kind = 'settings' THEN
    SELECT i.settings_checkpoint, i.settings_checkpoint_sequence,
           i.settings_claim_revision, i.settings_claim_skills_revision,
           i.settings_claim_client_surface, i.settings_claim_cold_start_deadline_at
    INTO v_checkpoint, v_checkpoint_sequence,
         v_settings_claim_revision, v_settings_claim_skills_revision, v_client_surface,
         v_cold_start_deadline
    FROM public.companion_runtime_instances i
    WHERE i.org_id = p_org_id
      AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id
      AND i.generation = p_runtime_generation
      AND i.settings_claim_epoch = p_claim_epoch
      AND i.settings_checkpoint = 'applying'
      AND i.settings_checkpoint_sequence = p_expected_checkpoint_sequence;
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSE
    SELECT i.health_checkpoint, i.health_checkpoint_sequence
    INTO v_checkpoint, v_checkpoint_sequence
    FROM public.companion_runtime_instances i
    WHERE i.org_id = p_org_id
      AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id
      AND i.generation = p_runtime_generation
      AND i.health_claim_epoch = p_claim_epoch
      AND i.health_checkpoint = 'observing'
      AND i.health_checkpoint_sequence = p_expected_checkpoint_sequence;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;

  -- A cold Send's budget also fences the last configuration observation before dispatch. The
  -- runtime may still settle the work as interrupted, but it cannot publish an applied revision
  -- after the source turn's three-minute deadline.
  v_now := clock_timestamp();
  IF v_lease_expires_at <= v_now
     OR (
       v_cold_start_deadline IS NOT NULL
       AND v_now >= v_cold_start_deadline
       AND (
         (
           p_work_kind = 'operation'
           AND v_operation_kind = 'start'
           -- Never discard causal identity evidence for a Box lookup/create already performed
           -- under a valid renewal. Recording the canonical id prevents an orphan; checkpoint and
           -- settlement still prohibit any subsequent effect or successful cold turn.
           AND NOT (
             v_checkpoint IN ('resolving_box', 'creating_box')
             AND p_box_id IS NOT NULL
           )
         )
         OR (p_work_kind = 'operation' AND v_operation_kind = 'apply_settings')
         OR p_work_kind = 'settings'
       )
     ) THEN
    RETURN NULL;
  END IF;

  -- A create POST cannot be cancelled after its write intent. When Delete preempts that exact
  -- generation, absence is not proof until the full cold-create outcome horizon has elapsed. A
  -- later second observation is still required below, so a delayed named Box is attached and
  -- permanently deleted instead of appearing after retirement.
  IF p_work_kind = 'operation'
     AND v_operation_kind = 'delete'
     AND v_checkpoint = 'pending'
     AND p_box_id IS NULL
     AND p_box_state = 'absent'
     AND v_delete_create_ambiguous
     AND v_now < v_ambiguous_create_interrupted_at + interval '3 minutes' THEN
    RETURN NULL;
  END IF;

  -- Health is observation-only: it may refresh typed states/timestamps, but it cannot discover a
  -- new identity or claim that layout/settings/skills were applied. Lifecycle work may attach a
  -- new Box only while a start is resolving it or immediately after the create write intent.
  IF p_work_kind = 'health' AND (
       (p_box_id IS NOT NULL AND (v_box_id IS NULL OR p_box_id <> v_box_id))
       OR (p_pi_invocation_id IS NOT NULL
         AND (v_pi_invocation_id IS NULL OR p_pi_invocation_id <> v_pi_invocation_id))
       OR p_disk_layout_version IS NOT NULL
       OR p_applied_settings_revision IS NOT NULL
       OR p_applied_skills_revision IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'health observation cannot mutate runtime identity or applied revisions'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'settings' AND (
       p_box_id IS NOT NULL
       OR p_box_state IS NOT NULL
       OR p_disk_layout_version IS NOT NULL
       OR p_pi_state IS DISTINCT FROM 'idle'::public.companion_pi_observed_state
       OR p_pi_invocation_id IS NULL
       OR p_pi_invocation_id IS NOT DISTINCT FROM v_pi_invocation_id
       OR p_applied_settings_revision IS DISTINCT FROM v_settings_claim_revision
       OR CASE WHEN v_client_surface = 'native_mobile'
            THEN p_applied_skills_revision IS NOT NULL
            ELSE p_applied_skills_revision IS DISTINCT FROM v_settings_claim_skills_revision
          END
     ) THEN
    RAISE EXCEPTION 'settings activation requires exact revisions and a new idle Pi invocation'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND p_box_id IS NOT NULL
     AND v_box_id IS NULL
     AND NOT (
       (v_operation_kind = 'start' AND v_checkpoint IN ('resolving_box', 'creating_box'))
       -- A Delete that preempted an ambiguous create must resolve the deterministic generation
       -- name before it may prove absence. If the provider list finds that Box, attach its id so
       -- the normal permanent-delete path is mandatory instead of orphaning the resource.
       OR (v_operation_kind = 'delete'
           AND v_checkpoint IN ('pending', 'box_absence_observed'))
     ) THEN
    RAISE EXCEPTION 'operation cannot attach a Box id at this checkpoint' USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND p_pi_invocation_id IS DISTINCT FROM v_pi_invocation_id
     AND p_pi_invocation_id IS NOT NULL
     AND NOT (
       (v_operation_kind IN ('start', 'restart_pi', 'restart_box')
        AND v_checkpoint = 'starting_pi')
       OR (v_operation_kind = 'apply_settings'
           AND v_checkpoint = 'applying_settings')
     ) THEN
    RAISE EXCEPTION 'operation cannot replace the Pi invocation at this checkpoint'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND v_operation_kind IN ('restart_pi', 'restart_box', 'apply_settings')
     AND p_pi_invocation_id IS DISTINCT FROM v_pi_invocation_id
     AND p_pi_invocation_id IS NOT NULL
     AND p_pi_state IS DISTINCT FROM 'idle'::public.companion_pi_observed_state THEN
    RAISE EXCEPTION 'a restarted Pi invocation may be attached only with idle proof'
      USING ERRCODE = '22023';
  END IF;

  -- Applying settings is one activation proof: staged revisions become durable only when the same
  -- observation replaces the old daemon identity with a new idle Pi invocation.
  IF p_work_kind = 'operation'
     AND v_operation_kind = 'apply_settings'
     AND v_checkpoint = 'applying_settings'
     AND (
       p_pi_state IS DISTINCT FROM 'idle'::public.companion_pi_observed_state
       OR p_pi_invocation_id IS NULL
       OR p_pi_invocation_id IS NOT DISTINCT FROM v_pi_invocation_id
       OR p_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
       OR CASE WHEN v_client_surface = 'native_mobile'
            THEN p_applied_skills_revision IS NOT NULL
            ELSE p_applied_skills_revision IS DISTINCT FROM v_target_skills_revision
          END
     ) THEN
    RAISE EXCEPTION 'settings activation requires exact revisions and a new idle Pi invocation'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND p_disk_layout_version IS NOT NULL
     AND NOT (
       v_operation_kind IN ('start', 'restart_box')
       AND v_checkpoint IN ('installing_layout', 'starting_pi', 'pi_ready')
     ) THEN
    RAISE EXCEPTION 'operation cannot apply a disk layout at this checkpoint'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND (p_applied_settings_revision IS NOT NULL OR p_applied_skills_revision IS NOT NULL)
     AND NOT (
       (v_operation_kind IN ('start', 'restart_box')
         AND v_checkpoint IN ('installing_layout', 'starting_pi', 'pi_ready'))
       OR (v_operation_kind = 'apply_settings' AND v_checkpoint = 'applying_settings')
     ) THEN
    RAISE EXCEPTION 'operation cannot apply revisions at this checkpoint' USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND v_operation_kind IN ('start', 'restart_box', 'apply_settings')
     AND (p_applied_settings_revision IS NOT NULL OR p_applied_skills_revision IS NOT NULL)
     AND (CASE
       WHEN v_operation_kind IN ('start', 'restart_box', 'apply_settings')
            AND v_client_surface = 'native_mobile' THEN
         v_target_settings_revision IS NULL
         OR p_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
         OR p_applied_skills_revision IS NOT NULL
       ELSE
         v_target_settings_revision IS NULL
         OR v_target_skills_revision IS NULL
         OR p_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
         OR p_applied_skills_revision IS DISTINCT FROM v_target_skills_revision
     END) THEN
    RAISE EXCEPTION 'operation observation must prove its exact captured revisions'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.companion_runtime_instances i
  SET box_id = COALESCE(i.box_id, p_box_id),
      box_state = COALESCE(p_box_state, i.box_state),
      pi_state = COALESCE(p_pi_state, i.pi_state),
      pi_invocation_id = CASE
        -- Absence is positive proof that no invocation remains. Retaining the previous id would
        -- pair an absent daemon state with stale identity and mislead the next health claimant.
        WHEN p_pi_state = 'absent'::public.companion_pi_observed_state THEN NULL
        ELSE COALESCE(p_pi_invocation_id, i.pi_invocation_id)
      END,
      disk_layout_version = COALESCE(p_disk_layout_version, i.disk_layout_version),
      applied_settings_revision = CASE
        WHEN p_work_kind = 'settings' THEN i.applied_settings_revision
        ELSE COALESCE(p_applied_settings_revision, i.applied_settings_revision)
      END,
      applied_skills_revision = CASE
        WHEN p_work_kind = 'settings' THEN i.applied_skills_revision
        ELSE COALESCE(p_applied_skills_revision, i.applied_skills_revision)
      END,
      applied_client_surface = CASE
        WHEN p_work_kind = 'operation' AND p_applied_settings_revision IS NOT NULL
          THEN v_client_surface
        ELSE i.applied_client_surface
      END,
      settings_checkpoint = CASE
        WHEN p_work_kind = 'settings' THEN 'applied'
        ELSE i.settings_checkpoint
      END,
      settings_checkpoint_sequence = i.settings_checkpoint_sequence
        + CASE WHEN p_work_kind = 'settings' THEN 1 ELSE 0 END,
      health_checkpoint = CASE
        WHEN p_work_kind = 'health' THEN 'observed'
        ELSE i.health_checkpoint
      END,
      health_checkpoint_sequence = i.health_checkpoint_sequence
        + CASE WHEN p_work_kind = 'health' THEN 1 ELSE 0 END,
      last_heartbeat_at = CASE
        WHEN p_work_kind = 'health' THEN GREATEST(COALESCE(i.last_heartbeat_at, p_observed_at), p_observed_at)
        ELSE i.last_heartbeat_at
      END,
      box_observed_at = CASE
        WHEN p_box_id IS NOT NULL OR p_box_state IS NOT NULL
          THEN GREATEST(COALESCE(i.box_observed_at, p_observed_at), p_observed_at)
        ELSE i.box_observed_at
      END,
      pi_observed_at = CASE
        WHEN p_pi_state IS NOT NULL OR p_pi_invocation_id IS NOT NULL
          THEN GREATEST(COALESCE(i.pi_observed_at, p_observed_at), p_observed_at)
        ELSE i.pi_observed_at
      END,
      last_observed_at = GREATEST(COALESCE(i.last_observed_at, p_observed_at), p_observed_at),
      last_write_epoch = GREATEST(i.last_write_epoch, p_claim_epoch),
      updated_at = v_now
  WHERE i.org_id = p_org_id
    AND i.companion_id = p_companion_id
    AND i.generation = p_runtime_generation
    AND (p_box_id IS NULL OR i.box_id IS NULL OR i.box_id = p_box_id)
    AND (
      p_work_kind <> 'health'
      OR (
        i.health_claim_epoch = p_claim_epoch
        AND i.health_checkpoint = 'observing'
        AND i.health_checkpoint_sequence = p_expected_checkpoint_sequence
      )
    )
    AND (
      p_work_kind <> 'settings'
      OR (
        i.settings_claim_epoch = p_claim_epoch
        AND i.settings_checkpoint = 'applying'
        AND i.settings_checkpoint_sequence = p_expected_checkpoint_sequence
      )
    );
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_next_sequence := v_checkpoint_sequence
    + CASE WHEN p_work_kind IN ('settings', 'health') THEN 1 ELSE 0 END;
  IF p_work_kind = 'operation' THEN
    v_observation_checkpoint := CASE
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'resolving_box'
        AND p_box_id IS NULL
        AND p_box_state = 'absent' THEN 'box_absence_observed'
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'resolving_box'
        AND p_box_id IS NOT NULL
        AND p_box_state IN ('ready', 'idle', 'running') THEN 'box_ready_observed'
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'resolving_box'
        AND p_box_id IS NOT NULL THEN 'box_resolved'
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'creating_box'
        AND p_box_id IS NOT NULL
        AND p_box_state IN ('ready', 'idle', 'running') THEN 'box_ready_observed'
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'creating_box'
        AND p_box_id IS NOT NULL THEN 'box_created'
      WHEN v_operation_kind IN ('start', 'restart_box')
        AND v_checkpoint = 'waiting_ready'
        AND p_box_state IN ('ready', 'idle', 'running') THEN 'box_ready_observed'
      WHEN v_operation_kind = 'stop'
        AND v_checkpoint = 'waiting_archived'
        AND p_box_state = 'archived' THEN 'box_archived'
      WHEN v_operation_kind = 'delete'
        AND v_checkpoint = 'pending'
        AND p_box_id IS NULL
        AND p_box_state = 'absent'
        AND v_delete_create_ambiguous THEN 'box_absence_observed'
      WHEN v_operation_kind = 'delete'
        AND v_checkpoint = 'pending'
        AND p_box_id IS NULL
        AND p_box_state = 'absent'
        AND NOT v_delete_create_ambiguous THEN 'box_absent'
      WHEN v_operation_kind = 'delete'
        AND v_checkpoint = 'box_absence_observed'
        AND p_box_id IS NULL
        AND p_box_state = 'absent'
        AND v_now >= v_checkpoint_updated_at + interval '30 seconds' THEN 'box_absent'
      WHEN v_operation_kind = 'delete'
        AND v_checkpoint = 'waiting_deleted'
        AND p_box_state = 'absent' THEN 'provider_deleted'
      WHEN v_operation_kind = 'apply_settings'
        AND v_checkpoint = 'applying_settings'
        AND p_pi_state = 'idle'
        AND p_pi_invocation_id IS NOT NULL
        AND (v_pi_invocation_id IS NULL OR p_pi_invocation_id <> v_pi_invocation_id)
        AND p_applied_settings_revision = v_target_settings_revision
        AND CASE WHEN v_client_surface = 'native_mobile'
          THEN p_applied_skills_revision IS NULL
          ELSE p_applied_skills_revision = v_target_skills_revision
        END THEN 'settings_applied'
      WHEN v_operation_kind IN ('start', 'restart_pi', 'restart_box')
        AND v_checkpoint = 'starting_pi'
        AND p_pi_state = 'idle'
        AND p_pi_invocation_id IS NOT NULL
        AND (v_pi_invocation_id IS NULL OR p_pi_invocation_id <> v_pi_invocation_id)
        THEN 'pi_observed'
      ELSE NULL
    END;
  END IF;

  IF v_observation_checkpoint IS NOT NULL THEN
    UPDATE public.companion_operations o
    SET checkpoint = v_observation_checkpoint,
        checkpoint_sequence = o.checkpoint_sequence + 1,
        updated_at = v_now
    WHERE o.org_id = p_org_id
      AND o.companion_id = p_companion_id
      AND o.id = p_work_id
      AND o.runtime_generation = p_runtime_generation
      AND o.status = 'running'
      AND o.claim_epoch = p_claim_epoch
      AND o.checkpoint = v_checkpoint
      AND o.checkpoint_sequence = p_expected_checkpoint_sequence
    RETURNING o.checkpoint_sequence INTO v_next_sequence;
    IF v_next_sequence IS NULL THEN
      RAISE EXCEPTION 'failed to persist operation observation evidence' USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN v_next_sequence;
END
$$;
--> statement-breakpoint

-- Settle work and release its lease in one transaction. The terminal update repeats the complete
-- token/claim/gate/work fence; a stale executor cannot settle even if it still knows the work id.
CREATE FUNCTION public.companion_runtime_settle(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_terminal_status text,
  p_error_code text,
  p_error_message text,
  p_error_action public.companion_runtime_error_action
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_lease_expires_at timestamp with time zone;
  v_turn_id uuid;
  v_operation_kind public.companion_operation_kind;
  v_operation_actor_id text;
  v_operation_checkpoint text;
  v_target_settings_revision bigint;
  v_target_skills_revision integer;
  v_operation_box_id text;
  v_operation_box_state public.companion_box_observed_state;
  v_operation_pi_state public.companion_pi_observed_state;
  v_operation_pi_invocation_id text;
  v_operation_disk_layout_version integer;
  v_operation_applied_settings_revision bigint;
  v_operation_applied_skills_revision integer;
  v_operation_applied_client_surface public.companion_client_surface;
  v_client_surface public.companion_client_surface := 'web';
  v_cold_start_deadline timestamp with time zone;
  v_inactivity_deadline timestamp with time zone;
  v_absolute_deadline timestamp with time zone;
  v_live_desired_settings_revision bigint;
  v_live_skills_revision integer;
  v_settings_claim_revision bigint;
  v_settings_claim_skills_revision integer;
  v_settings_checkpoint text;
  v_dispatch_state public.companion_dispatch_state;
  v_attempt_checkpoint text;
  v_attempt_pi_invocation_id text;
  v_decision_delivery_state public.companion_decision_delivery_state;
  v_decision_attempt_id uuid;
  v_decision_command_id uuid;
  v_previous_runtime_protocol text;
  v_success boolean := false;
BEGIN
  IF p_terminal_status NOT IN ('succeeded', 'failed', 'interrupted', 'cancelled')
     OR ((p_error_code IS NULL) <> (p_error_message IS NULL))
     OR ((p_error_code IS NULL) <> (p_error_action IS NULL))
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z][a-z0-9_]{0,63}$')
     OR (p_error_message IS NOT NULL AND (
       char_length(p_error_message) > 500 OR p_error_message ~ E'[\n\r]'
     ))
     OR (p_terminal_status IN ('failed', 'interrupted') AND p_error_code IS NULL)
     OR (p_terminal_status IN ('succeeded', 'cancelled') AND p_error_code IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid Runtime v2 settlement' USING ERRCODE = '22023';
  END IF;

  SELECT l.expires_at INTO v_lease_expires_at
  FROM public.companion_runtime_leases l
  JOIN public.companion_runtime_control c ON c.id = 'runtime-v2'
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp()
    AND c.enabled
    AND c.gate_epoch = p_gate_epoch
  FOR UPDATE OF l;
  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM 1
  FROM public.companion_runtime_instances i
  WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_now := clock_timestamp();
  IF v_lease_expires_at <= v_now THEN RETURN false; END IF;

  IF p_work_kind = 'operation' THEN
    SELECT o.kind, o.actor_id, o.checkpoint, o.target_settings_revision, o.target_skills_revision,
           o.source_turn_id, o.client_surface,
           i.box_id, i.box_state, i.pi_state, i.pi_invocation_id,
           i.disk_layout_version, i.applied_settings_revision, i.applied_skills_revision,
           i.applied_client_surface
    INTO v_operation_kind, v_operation_actor_id, v_operation_checkpoint,
         v_target_settings_revision, v_target_skills_revision,
         v_turn_id, v_client_surface,
         v_operation_box_id, v_operation_box_state, v_operation_pi_state,
         v_operation_pi_invocation_id, v_operation_disk_layout_version,
         v_operation_applied_settings_revision, v_operation_applied_skills_revision,
         v_operation_applied_client_surface
    FROM public.companion_operations o
    JOIN public.companion_runtime_instances i
      ON i.org_id = o.org_id AND i.companion_id = o.companion_id
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.id = p_work_id AND o.status = 'running' AND o.claim_epoch = p_claim_epoch
    FOR UPDATE OF o;
    IF NOT FOUND THEN RETURN false; END IF;

    IF v_turn_id IS NOT NULL THEN
      SELECT t.cold_start_deadline_at
      INTO v_cold_start_deadline
      FROM public.companion_turns t
      WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id AND t.id = v_turn_id
      FOR UPDATE;
      IF NOT FOUND THEN RETURN false; END IF;
    END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         p_terminal_status = 'succeeded'
         AND v_operation_kind IN ('start', 'apply_settings')
         AND v_cold_start_deadline IS NOT NULL
         AND v_now >= v_cold_start_deadline
       ) THEN
      RETURN false;
    END IF;

    IF p_terminal_status = 'succeeded' AND NOT (
      (v_operation_kind IN ('start', 'restart_pi', 'restart_box') AND v_operation_checkpoint = 'pi_ready')
      OR (v_operation_kind = 'stop' AND v_operation_checkpoint = 'box_archived')
      OR (v_operation_kind = 'apply_settings' AND v_operation_checkpoint = 'settings_applied')
      OR (v_operation_kind = 'delete' AND v_operation_checkpoint IN ('provider_deleted', 'box_absent'))
    ) THEN
      RAISE EXCEPTION 'operation lacks terminal checkpoint proof' USING ERRCODE = '22023';
    END IF;

    IF p_terminal_status = 'succeeded'
       AND v_operation_kind IN ('start', 'restart_pi', 'restart_box')
       AND (
         v_operation_box_id IS NULL
         OR v_operation_box_state NOT IN ('ready', 'idle', 'running')
         OR v_operation_pi_state <> 'idle'
         OR v_operation_pi_invocation_id IS NULL
         OR v_operation_disk_layout_version IS DISTINCT FROM 14
         OR (
           v_operation_kind IN ('start', 'restart_box')
           AND (
             v_target_settings_revision IS NULL
             OR v_target_skills_revision IS NULL
             OR v_operation_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
             OR CASE
               WHEN v_operation_kind IN ('start', 'restart_box')
                    AND v_client_surface = 'native_mobile' THEN
                 v_operation_applied_client_surface IS DISTINCT FROM 'native_mobile'
               ELSE
                 v_operation_applied_skills_revision IS DISTINCT FROM v_target_skills_revision
                 OR v_operation_applied_client_surface IS NULL
                 OR v_operation_applied_client_surface = 'native_mobile'
             END
           )
         )
       ) THEN
      RAISE EXCEPTION 'operation lacks terminal Box/Pi/layout observation proof'
        USING ERRCODE = '22023';
    END IF;

    IF p_terminal_status = 'succeeded'
       AND v_operation_kind = 'stop'
       AND v_operation_box_state <> 'archived' THEN
      RAISE EXCEPTION 'stop lacks archived Box observation proof' USING ERRCODE = '22023';
    END IF;

    IF p_terminal_status = 'succeeded'
       AND v_operation_kind = 'delete'
       AND v_operation_box_state <> 'absent' THEN
      RAISE EXCEPTION 'delete lacks absent Box observation proof' USING ERRCODE = '22023';
    END IF;

    IF v_operation_kind = 'apply_settings' AND p_terminal_status = 'succeeded' THEN
      IF v_target_settings_revision IS NULL OR v_target_skills_revision IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.companion_runtime_instances i
        JOIN public.companions c
          ON c.org_id = i.org_id AND c.id = i.companion_id
        WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
          AND v_target_settings_revision <= i.desired_settings_revision
          AND v_target_skills_revision <= c.skills_revision
          AND i.applied_settings_revision >= v_target_settings_revision
          AND CASE WHEN v_client_surface = 'native_mobile'
            THEN i.applied_client_surface = 'native_mobile'
            ELSE i.applied_skills_revision >= v_target_skills_revision
              AND i.applied_client_surface IS NOT NULL
              AND i.applied_client_surface <> 'native_mobile'
          END
      ) THEN
        RAISE EXCEPTION 'settings operation target revisions are invalid' USING ERRCODE = '22023';
      END IF;
      UPDATE public.companion_runtime_instances i
      SET applied_settings_revision = GREATEST(i.applied_settings_revision, v_target_settings_revision),
          applied_skills_revision = CASE WHEN v_client_surface = 'native_mobile'
            THEN i.applied_skills_revision
            ELSE GREATEST(i.applied_skills_revision, v_target_skills_revision)
          END,
          updated_at = v_now
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
    END IF;

    UPDATE public.companion_operations o
    SET status = p_terminal_status::public.companion_operation_status,
        checkpoint_sequence = o.checkpoint_sequence + 1,
        settled_at = v_now,
        last_error_code = p_error_code,
        last_error_message = p_error_message,
        last_error_action = p_error_action,
        updated_at = v_now
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.id = p_work_id AND o.status = 'running' AND o.claim_epoch = p_claim_epoch;
    v_success := FOUND;

    IF v_success
       AND v_operation_kind IN ('start', 'apply_settings')
       AND v_turn_id IS NOT NULL
       AND p_terminal_status <> 'succeeded' THEN
      UPDATE public.companion_turns t
      SET status = CASE
            WHEN p_error_code = 'cold_start_deadline_exceeded'
              THEN 'interrupted'::public.companion_turn_status
            ELSE p_terminal_status::public.companion_turn_status
          END,
          inactivity_deadline_at = CASE
            WHEN p_terminal_status = 'cancelled' THEN NULL
            ELSE t.inactivity_deadline_at
          END,
          absolute_deadline_at = CASE
            WHEN p_terminal_status = 'cancelled' THEN NULL
            ELSE COALESCE(t.absolute_deadline_at, v_now)
          END,
          state_changed_at = v_now,
          settled_at = v_now,
          last_error_code = p_error_code,
          last_error_message = p_error_message,
          last_error_action = p_error_action,
          updated_at = v_now
      WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
        AND t.id = v_turn_id
        AND t.status IN ('queued', 'starting', 'dispatching', 'running', 'needs_input');
    END IF;

    IF v_success AND v_operation_kind = 'delete' AND p_terminal_status = 'succeeded' THEN
      -- Provider proof is the irreversible cutover point. Preserve a minimal, sanitized audit row,
      -- then delete the aggregate root so legacy thread/transcript state and every Runtime v2 row
      -- disappear atomically. Provider connections, member MCP accounts, Skills, and their secrets
      -- are workspace resources and intentionally do not cascade from the Companion.
      INSERT INTO public.audit_log (
        org_id, actor_id, action, target_type, target_id, metadata
      ) VALUES (
        p_org_id,
        CASE WHEN EXISTS (
          SELECT 1 FROM public."user" u WHERE u.id = v_operation_actor_id
        ) THEN v_operation_actor_id ELSE NULL END,
        'companion.deleted',
        'companion',
        p_companion_id::text,
        jsonb_build_object(
          'operation_id', p_work_id::text,
          'provider_checkpoint', v_operation_checkpoint
        )
      );

      -- The legacy mutation fence is diagnostic rather than an authorization boundary. Pin it only
      -- around this SECURITY DEFINER-owned aggregate delete, avoiding CREATE FUNCTION SET clauses
      -- that require deployment-specific custom-parameter privileges from the migration owner.
      UPDATE public.companion_runtime_instances i
      SET settings_claim_turn_id = NULL,
          settings_claim_cold_start_deadline_at = NULL,
          updated_at = v_now
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
      UPDATE public.companion_operations o
      SET source_turn_id = NULL, updated_at = v_now
      WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
        AND o.source_turn_id IS NOT NULL;

      v_previous_runtime_protocol := pg_catalog.current_setting(
        'app.companion_runtime_protocol', true
      );
      PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
      DELETE FROM public.companions c
      WHERE c.org_id = p_org_id AND c.id = p_companion_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'delete settlement lost Companion aggregate root' USING ERRCODE = '40001';
      END IF;
      PERFORM pg_catalog.set_config(
        'app.companion_runtime_protocol', COALESCE(v_previous_runtime_protocol, ''), true
      );
      RETURN true;
    END IF;

  ELSIF p_work_kind = 'attempt' THEN
    SELECT a.turn_id, a.dispatch_state, a.checkpoint, a.pi_invocation_id,
           t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at
    INTO v_turn_id, v_dispatch_state, v_attempt_checkpoint, v_attempt_pi_invocation_id,
         v_cold_start_deadline, v_inactivity_deadline, v_absolute_deadline
    FROM public.companion_turn_attempts a
    JOIN public.companion_turns t
      ON t.org_id = a.org_id AND t.companion_id = a.companion_id AND t.id = a.turn_id
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.id = p_work_id AND a.claim_epoch = p_claim_epoch
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
    FOR UPDATE OF a, t;
    IF NOT FOUND THEN RETURN false; END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         p_terminal_status = 'succeeded'
         AND (
           (v_absolute_deadline IS NOT NULL AND v_now >= v_absolute_deadline)
           OR (v_inactivity_deadline IS NOT NULL AND v_now >= v_inactivity_deadline)
         )
       ) THEN
      RETURN false;
    END IF;
    IF v_dispatch_state = 'ambiguous' AND p_terminal_status <> 'interrupted' THEN
      RAISE EXCEPTION 'an ambiguous attempt may only settle interrupted' USING ERRCODE = '22023';
    END IF;
    IF v_dispatch_state = 'write_intent' AND p_terminal_status <> 'interrupted' THEN
      RAISE EXCEPTION 'a dispatch write intent without ACK may only settle interrupted'
        USING ERRCODE = '22023';
    END IF;
    IF v_dispatch_state = 'rejected' AND p_terminal_status NOT IN ('failed', 'interrupted') THEN
      RAISE EXCEPTION 'a rejected dispatch must settle failed or interrupted' USING ERRCODE = '22023';
    END IF;
    IF p_terminal_status = 'succeeded'
       AND (
         v_dispatch_state <> 'accepted'
         OR v_attempt_checkpoint <> 'agent_settled'
         OR v_attempt_pi_invocation_id IS NULL
       ) THEN
      RAISE EXCEPTION 'attempt lacks accepted dispatch, Pi invocation, and agent settlement proof'
        USING ERRCODE = '22023';
    END IF;

    UPDATE public.companion_turn_attempts a
    SET status = p_terminal_status::public.companion_attempt_status,
        checkpoint_sequence = a.checkpoint_sequence + 1,
        settled_at = v_now,
        last_error_code = p_error_code,
        last_error_message = p_error_message,
        last_error_action = p_error_action,
        updated_at = v_now
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.id = p_work_id AND a.claim_epoch = p_claim_epoch
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
    IF NOT FOUND THEN RETURN false; END IF;

    PERFORM public.companion_runtime_close_attempt_decisions(
      p_org_id, p_companion_id, p_work_id,
      p_error_code, p_error_message, p_error_action, NULL
    );

    UPDATE public.companion_turns t
    SET status = p_terminal_status::public.companion_turn_status,
        state_changed_at = v_now,
        settled_at = v_now,
        last_error_code = p_error_code,
        last_error_message = p_error_message,
        last_error_action = p_error_action,
        updated_at = v_now
    WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
      AND t.id = v_turn_id AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');
    v_success := FOUND;

  ELSIF p_work_kind = 'decision' THEN
    SELECT d.turn_id, d.attempt_id, d.delivery_state, d.command_id,
           t.inactivity_deadline_at, t.absolute_deadline_at
    INTO v_turn_id, v_decision_attempt_id, v_decision_delivery_state, v_decision_command_id,
         v_inactivity_deadline, v_absolute_deadline
    FROM public.companion_decision_deliveries d
    JOIN public.companion_turns t
      ON t.org_id = d.org_id AND t.companion_id = d.companion_id AND t.id = d.turn_id
    WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
      AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
      AND d.decision_status <> 'pending'
      AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
    FOR UPDATE OF d, t;
    IF NOT FOUND THEN RETURN false; END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         p_terminal_status = 'succeeded'
         AND (
           (v_absolute_deadline IS NOT NULL AND v_now >= v_absolute_deadline)
           OR (v_inactivity_deadline IS NOT NULL AND v_now >= v_inactivity_deadline)
         )
       ) THEN
      RETURN false;
    END IF;

    IF p_terminal_status = 'succeeded' THEN
      IF v_decision_delivery_state <> 'write_intent' OR v_decision_command_id IS NULL THEN
        RAISE EXCEPTION 'decision success requires an unambiguous durable write intent'
          USING ERRCODE = '22023';
      END IF;
      UPDATE public.companion_decision_deliveries d
      SET delivery_state = 'delivered',
          delivery_checkpoint = 'delivered',
          delivery_checkpoint_sequence = d.delivery_checkpoint_sequence + 1,
          delivered_at = v_now,
          last_error_code = NULL,
          last_error_message = NULL,
          last_error_action = NULL,
          updated_at = v_now
      WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
        AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
        AND d.decision_status <> 'pending'
        AND d.delivery_state = 'write_intent'
        AND d.command_id IS NOT NULL;
      v_success := FOUND;
    ELSE
      IF p_terminal_status = 'cancelled' THEN
        RAISE EXCEPTION 'decision delivery cancellation must be explicit failure or interruption'
          USING ERRCODE = '22023';
      END IF;
      UPDATE public.companion_decision_deliveries d
      SET delivery_state = CASE
            WHEN d.command_id IS NULL AND p_terminal_status = 'interrupted'
              THEN 'cancelled'::public.companion_decision_delivery_state
            WHEN d.command_id IS NULL THEN 'pending'::public.companion_decision_delivery_state
            ELSE 'ambiguous'::public.companion_decision_delivery_state
          END,
          delivery_checkpoint = CASE
            WHEN d.command_id IS NULL AND p_terminal_status = 'interrupted' THEN 'cancelled'
            WHEN d.command_id IS NULL THEN 'pending'
            ELSE 'ambiguous'
          END,
          delivery_checkpoint_sequence = d.delivery_checkpoint_sequence + 1,
          last_error_code = p_error_code,
          last_error_message = p_error_message,
          last_error_action = p_error_action,
          updated_at = v_now
      WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
        AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
        AND d.decision_status <> 'pending'
        AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous');
      v_success := FOUND;

      -- Do not mutate the parent after a failed delivery CAS. FOUND would otherwise be replaced by
      -- the later UPDATEs and settlement could report success after changing only the parent.
      IF NOT v_success THEN RETURN false; END IF;

      -- A pre-write failure remains retryable, but an explicit interruption is terminal even when
      -- authorization vanished before the write. Once a command id exists, the response may have
      -- reached Pi. Both paths close the parent visibly instead of reclaiming this decision forever.
      IF v_decision_command_id IS NOT NULL OR p_terminal_status = 'interrupted' THEN
        PERFORM public.companion_runtime_close_attempt_decisions(
          p_org_id, p_companion_id, v_decision_attempt_id,
          p_error_code, p_error_message, p_error_action, p_work_id
        );
        UPDATE public.companion_turn_attempts a
        SET status = 'interrupted', settled_at = v_now,
            last_error_code = p_error_code,
            last_error_message = p_error_message,
            last_error_action = p_error_action,
            updated_at = v_now
        WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
          AND a.id = v_decision_attempt_id
          AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
        UPDATE public.companion_turns t
        SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
            last_error_code = p_error_code,
            last_error_message = p_error_message,
            last_error_action = p_error_action,
            updated_at = v_now
        WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
          AND t.id = v_turn_id
          AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');
      END IF;
    END IF;
  ELSIF p_work_kind = 'settings' THEN
    SELECT i.settings_claim_revision, i.settings_claim_skills_revision,
           i.settings_claim_client_surface, i.settings_checkpoint,
           i.settings_claim_turn_id, i.settings_claim_cold_start_deadline_at,
           i.desired_settings_revision, c.skills_revision
    INTO v_settings_claim_revision, v_settings_claim_skills_revision,
         v_client_surface, v_settings_checkpoint,
         v_turn_id, v_cold_start_deadline,
         v_live_desired_settings_revision, v_live_skills_revision
    FROM public.companion_runtime_instances i
    JOIN public.companions c
      ON c.org_id = i.org_id AND c.id = i.companion_id
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id AND i.settings_claim_epoch = p_claim_epoch
    FOR UPDATE OF i, c;
    IF NOT FOUND THEN RETURN false; END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         p_terminal_status = 'succeeded'
         AND v_cold_start_deadline IS NOT NULL
         AND v_now >= v_cold_start_deadline
       ) THEN
      RETURN false;
    END IF;

    IF p_terminal_status = 'succeeded' THEN
      IF v_settings_checkpoint <> 'applied'
         OR v_settings_claim_revision IS DISTINCT FROM v_live_desired_settings_revision
         OR (
           v_client_surface <> 'native_mobile'
           AND v_settings_claim_skills_revision IS DISTINCT FROM v_live_skills_revision
         ) THEN
        RETURN false;
      END IF;
      UPDATE public.companion_runtime_instances i
      SET applied_settings_revision = GREATEST(i.applied_settings_revision, v_settings_claim_revision),
          applied_skills_revision = GREATEST(i.applied_skills_revision, v_settings_claim_skills_revision),
          applied_client_surface = v_client_surface,
          settings_checkpoint = 'applied',
          settings_checkpoint_sequence = i.settings_checkpoint_sequence + 1,
          settings_claim_epoch = NULL,
          settings_claim_actor_id = NULL,
          settings_claim_client_surface = NULL,
          settings_claim_turn_id = NULL,
          settings_claim_cold_start_deadline_at = NULL,
          settings_claim_revision = NULL,
          settings_claim_skills_revision = NULL,
          settings_claim_model_id = NULL,
          settings_claim_persona = NULL,
          settings_claim_can_write_skills = NULL,
          settings_claim_provider_ids = NULL,
          settings_claim_selected_skill_ids = NULL,
          settings_claim_skill_refs = NULL,
          settings_claim_selected_mcp_account_ids = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          last_error_action = NULL,
          updated_at = v_now
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
    ELSE
      UPDATE public.companion_runtime_instances i
      SET settings_checkpoint = 'pending',
          settings_checkpoint_sequence = i.settings_checkpoint_sequence + 1,
          settings_claim_epoch = NULL,
          settings_claim_actor_id = NULL,
          settings_claim_client_surface = NULL,
          settings_claim_turn_id = NULL,
          settings_claim_cold_start_deadline_at = NULL,
          settings_claim_revision = NULL,
          settings_claim_skills_revision = NULL,
          settings_claim_model_id = NULL,
          settings_claim_persona = NULL,
          settings_claim_can_write_skills = NULL,
          settings_claim_provider_ids = NULL,
          settings_claim_selected_skill_ids = NULL,
          settings_claim_skill_refs = NULL,
          settings_claim_selected_mcp_account_ids = NULL,
          settings_available_at = v_now + interval '30 seconds',
          last_error_code = p_error_code,
          last_error_message = p_error_message,
          last_error_action = p_error_action,
          updated_at = v_now
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
    END IF;
    v_success := FOUND;

    IF v_success AND v_turn_id IS NOT NULL AND p_terminal_status <> 'succeeded' THEN
      UPDATE public.companion_turns t
      SET status = CASE
            WHEN p_error_code = 'cold_start_deadline_exceeded'
              THEN 'interrupted'::public.companion_turn_status
            ELSE p_terminal_status::public.companion_turn_status
          END,
          inactivity_deadline_at = CASE
            WHEN p_terminal_status = 'cancelled' THEN NULL
            ELSE t.inactivity_deadline_at
          END,
          absolute_deadline_at = CASE
            WHEN p_terminal_status = 'cancelled' THEN NULL
            ELSE COALESCE(t.absolute_deadline_at, v_now)
          END,
          state_changed_at = v_now,
          settled_at = v_now,
          last_error_code = p_error_code,
          last_error_message = p_error_message,
          last_error_action = p_error_action,
          updated_at = v_now
      WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
        AND t.id = v_turn_id AND t.status = 'queued';
    END IF;

  ELSIF p_work_kind = 'health' THEN
    UPDATE public.companion_runtime_instances i
    SET health_checkpoint = CASE WHEN p_terminal_status = 'succeeded' THEN 'observed' ELSE 'pending' END,
        health_checkpoint_sequence = i.health_checkpoint_sequence + 1,
        health_claim_epoch = NULL,
        health_due_at = v_now + CASE
          WHEN p_terminal_status = 'succeeded' THEN interval '30 seconds'
          ELSE interval '15 seconds'
        END,
        last_error_code = p_error_code,
        last_error_message = p_error_message,
        last_error_action = p_error_action,
        updated_at = v_now
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id
      AND i.health_claim_epoch = p_claim_epoch
      AND (p_terminal_status <> 'succeeded' OR i.health_checkpoint = 'observed');
    v_success := FOUND;
  END IF;

  IF NOT v_success THEN RETURN false; END IF;

  UPDATE public.companion_runtime_instances i
  SET last_write_epoch = GREATEST(i.last_write_epoch, p_claim_epoch), updated_at = v_now
  WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;

  UPDATE public.companion_runtime_leases l
  SET claim_token = NULL,
      gate_epoch = NULL,
      executor_id = NULL,
      work_kind = NULL,
      work_id = NULL,
      claimed_at = NULL,
      renewed_at = NULL,
      expires_at = NULL,
      updated_at = v_now
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id;
  RETURN FOUND;
END
$$;
--> statement-breakpoint

-- Release abandons no work and changes no status; it only makes the serial queue claimable again.
-- Gate epoch is still required, so a pre-disable token cannot even release a newer claim.
CREATE FUNCTION public.companion_runtime_release_lease(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  UPDATE public.companion_runtime_leases l
  SET claim_token = NULL,
      gate_epoch = NULL,
      executor_id = NULL,
      work_kind = NULL,
      work_id = NULL,
      claimed_at = NULL,
      renewed_at = NULL,
      expires_at = NULL,
      updated_at = v_now
  FROM public.companion_runtime_control c
  WHERE c.id = 'runtime-v2'
    AND c.enabled
    AND c.gate_epoch = p_gate_epoch
    AND l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp();
  RETURN FOUND;
END
$$;
--> statement-breakpoint

-- Runtime rows are never an application-role CRUD surface. FORCE RLS applies even to the table
-- owner; only these constrained SECURITY DEFINER functions' owner may see or mutate them.
ALTER TABLE "companion_runtime_control" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_runtime_control" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_runtime_instances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_runtime_instances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_turns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_turns" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_turn_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_turn_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_operations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_operations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_decision_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_decision_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_runtime_leases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_runtime_leases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "companion_runtime_control_function_owner_rls"
  ON "companion_runtime_control" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_runtime_instances_function_owner_rls"
  ON "companion_runtime_instances" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_turns_runtime_function_owner_rls"
  ON "companion_turns" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_turn_attempts_runtime_function_owner_rls"
  ON "companion_turn_attempts" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_operations_runtime_function_owner_rls"
  ON "companion_operations" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_decision_deliveries_runtime_function_owner_rls"
  ON "companion_decision_deliveries" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_runtime_leases_function_owner_rls"
  ON "companion_runtime_leases" FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint

-- Minimal authorization reads for renew_and_authorize. These policies admit only that constrained
-- function owner; callers receive typed identifiers/generations, never ciphertext or account URLs.
CREATE POLICY "memberships_runtime_v2_authorization_rls"
  ON "memberships" FOR SELECT
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,companion_runtime_work_kind,uuid,integer)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companions_runtime_v2_authorization_rls"
  ON "companions" FOR SELECT
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,companion_runtime_work_kind,uuid,integer)'::regprocedure
  )));
--> statement-breakpoint
-- Successful permanent deletion is the only Runtime v2 write to the aggregate root. The settle
-- function has already fenced the lease, terminal checkpoint, and provider absence before this
-- policy can admit its DELETE.
CREATE POLICY "companions_runtime_v2_delete_rls"
  ON "companions" FOR DELETE
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_settle(uuid,uuid,uuid,bigint,bigint,text,companion_runtime_work_kind,uuid,text,text,text,companion_runtime_error_action)'::regprocedure
  )));
--> statement-breakpoint
-- audit_log is not currently FORCE RLS, but keep the definer exception explicit and narrow so a
-- future FORCE hardening cannot silently make proven Companion deletion non-atomic.
CREATE POLICY "audit_log_runtime_v2_companion_delete_rls"
  ON "audit_log" FOR INSERT
  WITH CHECK (
    current_user = pg_get_userbyid((
      SELECT p.proowner FROM pg_proc p
      WHERE p.oid = 'public.companion_runtime_settle(uuid,uuid,uuid,bigint,bigint,text,companion_runtime_work_kind,uuid,text,text,text,companion_runtime_error_action)'::regprocedure
    ))
    AND action = 'companion.deleted'
    AND target_type = 'companion'
    AND private_to_user_id IS NULL
  );
--> statement-breakpoint
CREATE POLICY "companion_workspace_access_runtime_v2_authorization_rls"
  ON "companion_workspace_access" FOR SELECT
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,companion_runtime_work_kind,uuid,integer)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "skills_runtime_v2_authorization_rls"
  ON "skills" FOR SELECT
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,companion_runtime_work_kind,uuid,integer)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_mcp_accounts_runtime_v2_authorization_rls"
  ON "companion_mcp_accounts" FOR SELECT
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,companion_runtime_work_kind,uuid,integer)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY "companion_provider_connections_runtime_v2_authorization_rls"
  ON "companion_provider_connections" FOR SELECT
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,companion_runtime_work_kind,uuid,integer)'::regprocedure
  )));
--> statement-breakpoint

-- Close the rolling-deploy window in the migration transaction itself. The external grants hook
-- repeats this downgrade after every migration, but it runs only after Drizzle commits. Revoke
-- every directly recorded non-owner grant here while the legacy table locks at the top of 0090
-- are still held, so neither an old login nor an old SECURITY DEFINER entry point can write once
-- the cutover commits. New Runtime v2 API entry points are narrow owner functions added later.
DO $$
DECLARE
  v_table regclass;
  v_private_table regclass;
  v_function regprocedure;
  v_grantee name;
  v_legacy_grantees name[] := ARRAY[]::name[];
  v_default_function_grantees name[] := ARRAY[]::name[];
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'public.companions'::regclass,
    'public.companion_runtime_pools'::regclass,
    'public.companion_workspace_access'::regclass,
    'public.companion_member_state'::regclass,
    'public.companion_threads'::regclass,
    'public.companion_transcript_entries'::regclass,
    'public.companion_reconcile_leases'::regclass
  ]
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE %s FROM PUBLIC', v_table);
    FOR v_grantee IN
      SELECT DISTINCT r.rolname
      FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))
      ) acl
      JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
      WHERE c.oid = v_table
        AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
        AND acl.grantee <> c.relowner
    LOOP
      IF NOT v_grantee = ANY(v_legacy_grantees) THEN
        v_legacy_grantees := array_append(v_legacy_grantees, v_grantee);
      END IF;
      EXECUTE format(
        'REVOKE INSERT, UPDATE, DELETE ON TABLE %s FROM %I',
        v_table,
        v_grantee
      );
    END LOOP;
  END LOOP;

  -- The legacy single-role grants hook also installed schema-wide default table grants. Discover
  -- mutation-capable grantees directly as well, covering an operator who cleaned current ACLs but
  -- left pg_default_acl behind. Clear SELECT with DML so a retired executor cannot automatically
  -- read any future private v2 table either; current SELECT grants on legacy tables remain intact.
  FOR v_grantee IN
    SELECT DISTINCT r.rolname
    FROM pg_catalog.pg_default_acl defaults
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) acl
    JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
    WHERE defaults.defaclrole = (
      SELECT role.oid FROM pg_catalog.pg_roles role WHERE role.rolname = current_user
    )
      AND defaults.defaclnamespace = 'public'::regnamespace
      AND defaults.defaclobjtype = 'r'
      AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  LOOP
    IF NOT v_grantee = ANY(v_legacy_grantees) THEN
      v_legacy_grantees := array_append(v_legacy_grantees, v_grantee);
    END IF;
  END LOOP;

  EXECUTE
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM PUBLIC';
  FOREACH v_grantee IN ARRAY v_legacy_grantees
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM %I',
      v_grantee
    );
  END LOOP;

  FOREACH v_private_table IN ARRAY ARRAY[
    'public.companion_runtime_control'::regclass,
    'public.companion_runtime_instances'::regclass,
    'public.companion_turns'::regclass,
    'public.companion_turn_attempts'::regclass,
    'public.companion_operations'::regclass,
    'public.companion_decision_deliveries'::regclass,
    'public.companion_runtime_leases'::regclass
  ]
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC', v_private_table);
    FOREACH v_grantee IN ARRAY v_legacy_grantees
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE %s FROM %I',
        v_private_table,
        v_grantee
      );
    END LOOP;
  END LOOP;

  -- PostgreSQL applies the migration owner's function defaults when each SECURITY DEFINER
  -- function is created. Remove every named non-owner default grantee and PUBLIC in this same
  -- transaction, then scrub the resulting ACL from all Runtime v2 entry points and helpers. The
  -- post-migration grants hook later grants only the dedicated executor surface.
  SELECT COALESCE(array_agg(DISTINCT grantee.rolname), ARRAY[]::name[])
  INTO v_default_function_grantees
  FROM pg_catalog.pg_default_acl defaults
  CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) acl
  JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
  WHERE defaults.defaclrole = (
      SELECT owner.oid FROM pg_catalog.pg_roles owner WHERE owner.rolname = current_user
    )
    AND defaults.defaclnamespace IN (0, 'public'::regnamespace)
    AND defaults.defaclobjtype = 'f'
    AND acl.privilege_type = 'EXECUTE'
    AND grantee.rolname <> current_user;

  EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  EXECUTE
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
  FOREACH v_grantee IN ARRAY v_default_function_grantees
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM %I',
      v_grantee
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE EXECUTE ON FUNCTIONS FROM %I',
      v_grantee
    );
  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    'public.companion_runtime_create_lease_row()'::regprocedure,
    'public.companion_runtime_assert_v2_mutation()'::regprocedure,
    'public.companion_runtime_require_v2_mutation()'::regprocedure,
    'public.companion_runtime_fence_legacy_token()'::regprocedure,
    'public.companion_runtime_require_instance_at_commit()'::regprocedure,
    'public.companion_runtime_assign_turn_sequence()'::regprocedure,
    'public.companion_runtime_assign_operation_intent()'::regprocedure,
    'public.companion_runtime_assign_attempt_snapshot()'::regprocedure,
    'public.companion_runtime_reject_actor_change()'::regprocedure,
    'public.companion_runtime_reject_turn_surface_change()'::regprocedure,
    'public.companion_runtime_reject_attempt_snapshot_change()'::regprocedure,
    'public.companion_runtime_reject_operation_snapshot_change()'::regprocedure,
    'public.companion_runtime_reject_responder_change()'::regprocedure,
    'public.companion_runtime_close_attempt_decisions(uuid,uuid,uuid,text,text,public.companion_runtime_error_action,uuid)'::regprocedure,
    'public.companion_runtime_gate_status()'::regprocedure,
    'public.companion_runtime_disable(bigint,text)'::regprocedure,
    'public.companion_runtime_enable(bigint,text)'::regprocedure,
    'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure,
    'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure,
    'public.companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,timestamp with time zone,integer,integer,integer)'::regprocedure,
    'public.companion_runtime_observe_instance(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,bigint,text,public.companion_box_observed_state,public.companion_pi_observed_state,text,integer,bigint,integer,timestamp with time zone)'::regprocedure,
    'public.companion_runtime_settle(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,text,text,public.companion_runtime_error_action)'::regprocedure,
    'public.companion_runtime_release_lease(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)'::regprocedure
  ]
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_function);
    FOR v_grantee IN
      SELECT DISTINCT grantee.rolname
      FROM pg_catalog.pg_proc protected_proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(protected_proc.proacl, pg_catalog.acldefault('f', protected_proc.proowner))
      ) acl
      JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
      WHERE protected_proc.oid = v_function
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee <> protected_proc.proowner
    LOOP
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        v_function,
        v_grantee
      );
    END LOOP;
  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    'public.companion_claim_delivery_lease(uuid,uuid,uuid,integer)'::regprocedure,
    'public.companion_release_delivery_lease(uuid,uuid,uuid)'::regprocedure,
    'public.companion_renew_delivery_lease(uuid,uuid,uuid,integer)'::regprocedure,
    'public.companion_accept_delivery_lease(uuid,uuid,uuid,integer,integer)'::regprocedure,
    'public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone,integer,integer)'::regprocedure,
    'public.companion_claim_reconcile_candidates(text,integer,integer,integer,integer)'::regprocedure,
    'public.companion_settle_reconcile_lease(uuid,uuid,text,text,integer)'::regprocedure
  ]
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_function);
    FOR v_grantee IN
      SELECT DISTINCT r.rolname
      FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) acl
      JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
      WHERE p.oid = v_function
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee <> p.proowner
    LOOP
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        v_function,
        v_grantee
      );
    END LOOP;
  END LOOP;
END
$$;
--> statement-breakpoint

REVOKE ALL ON TABLE public.companion_runtime_control FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.companion_runtime_instances FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.companion_turns FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.companion_turn_attempts FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.companion_operations FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.companion_decision_deliveries FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.companion_runtime_leases FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_reject_actor_change() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_reject_turn_surface_change() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_reject_responder_change() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_assign_turn_sequence() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_assign_operation_intent() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_assign_attempt_snapshot() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_reject_attempt_snapshot_change() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_reject_operation_snapshot_change() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_create_lease_row() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_assert_v2_mutation() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_require_v2_mutation() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_fence_legacy_token() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_require_instance_at_commit() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_close_attempt_decisions(
  uuid, uuid, uuid, text, text, public.companion_runtime_error_action, uuid
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_gate_status() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_disable(bigint, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_enable(bigint, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_claim_work(text, integer, integer, bigint) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_renew_and_authorize(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_checkpoint(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid,
  bigint, text, text, uuid, text, bigint, timestamp with time zone, integer, integer, integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_observe_instance(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid,
  bigint, bigint, text, public.companion_box_observed_state,
  public.companion_pi_observed_state, text, integer, bigint, integer,
  timestamp with time zone
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_settle(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid,
  text, text, text, public.companion_runtime_error_action
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_release_lease(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid
) FROM PUBLIC;
