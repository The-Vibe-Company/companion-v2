-- Runtime v2 executor surfaces. Every callable entry point below is SECURITY DEFINER, uses a
-- fixed search_path with RLS enabled, and returns no diagnostic row when its lease fence is stale.

ALTER TABLE public.companion_runtime_instances
  DROP CONSTRAINT companion_runtime_instances_generation_check;
--> statement-breakpoint
ALTER TABLE public.companion_runtime_instances
  ADD CONSTRAINT companion_runtime_instances_generation_check
  CHECK (generation BETWEEN 1 AND 2147483647);
--> statement-breakpoint
ALTER TABLE public.companion_turn_attempts
  DROP CONSTRAINT companion_turn_attempts_runtime_check;
--> statement-breakpoint
ALTER TABLE public.companion_turn_attempts
  ADD CONSTRAINT companion_turn_attempts_runtime_check CHECK (
    runtime_generation BETWEEN 1 AND 2147483647
    AND settings_revision >= 1
    AND skills_revision >= 1
    AND (claim_epoch IS NULL OR claim_epoch >= 1)
  );
--> statement-breakpoint
ALTER TABLE public.companion_turn_attempts
  DROP CONSTRAINT companion_turn_attempts_checkpoint_check;
--> statement-breakpoint
ALTER TABLE public.companion_turn_attempts
  ADD CONSTRAINT companion_turn_attempts_checkpoint_check CHECK (
    checkpoint IN (
      'starting', 'dispatch_write_intent', 'dispatch_accepted', 'dispatch_ambiguous',
      'dispatch_rejected', 'running', 'needs_input', 'event_projected',
      'agent_settled', 'process_exited'
    )
    AND checkpoint_sequence >= 0
  );
--> statement-breakpoint
ALTER TABLE public.companion_turn_attempts
  ADD COLUMN provider_credential_refs jsonb,
  ADD COLUMN mcp_credential_refs jsonb;
--> statement-breakpoint
ALTER TABLE public.companion_turn_attempts
  ADD CONSTRAINT companion_turn_attempts_credential_snapshot_check CHECK (
    (provider_credential_refs IS NULL OR (
      jsonb_typeof(provider_credential_refs) = 'array'
      AND octet_length(provider_credential_refs::text) <= 262144
    ))
    AND (mcp_credential_refs IS NULL OR (
      jsonb_typeof(mcp_credential_refs) = 'array'
      AND octet_length(mcp_credential_refs::text) <= 262144
    ))
    AND ((provider_credential_refs IS NULL) = (mcp_credential_refs IS NULL))
    AND (dispatch_state <> 'accepted' OR provider_credential_refs IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE public.companion_operations
  DROP CONSTRAINT companion_operations_runtime_check;
--> statement-breakpoint
ALTER TABLE public.companion_operations
  ADD CONSTRAINT companion_operations_runtime_check CHECK (
    runtime_generation BETWEEN 1 AND 2147483647
    AND (claim_epoch IS NULL OR claim_epoch >= 1)
  );
--> statement-breakpoint

CREATE TYPE public.companion_decision_request_kind AS ENUM ('question', 'confirmation');
--> statement-breakpoint
ALTER TABLE public.companion_decision_deliveries
  ADD COLUMN request_kind public.companion_decision_request_kind DEFAULT 'question' NOT NULL;
--> statement-breakpoint

CREATE TYPE public.companion_duplicate_cleanup_status AS ENUM (
  'pending', 'delete_requested', 'waiting_deleted', 'deleted', 'already_deleted', 'blocked'
);
--> statement-breakpoint

-- A start operation can discover more than one exact generation-named Box. Each non-canonical Box
-- gets its own crash-resumable deletion record instead of overloading the canonical operation id.
CREATE TABLE public.companion_runtime_duplicate_cleanups (
  org_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  box_id text NOT NULL,
  status public.companion_duplicate_cleanup_status DEFAULT 'pending' NOT NULL,
  provider_operation_id text,
  checkpoint_sequence bigint DEFAULT 0 NOT NULL,
  delete_requested_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT companion_runtime_duplicate_cleanups_pk PRIMARY KEY (operation_id, box_id),
  CONSTRAINT companion_runtime_duplicate_cleanups_org_companion_operation_uq
    UNIQUE (org_id, companion_id, operation_id, box_id),
  CONSTRAINT companion_runtime_duplicate_cleanups_operation_fk
    FOREIGN KEY (org_id, companion_id, operation_id)
    REFERENCES public.companion_operations(org_id, companion_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_runtime_duplicate_cleanups_box_id_check
    CHECK (box_id ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'),
  CONSTRAINT companion_runtime_duplicate_cleanups_provider_operation_check CHECK (
    provider_operation_id IS NULL
    OR (char_length(provider_operation_id) BETWEEN 1 AND 200 AND provider_operation_id !~ E'[\\n\\r]')
  ),
  CONSTRAINT companion_runtime_duplicate_cleanups_sequence_check CHECK (checkpoint_sequence >= 0),
  CONSTRAINT companion_runtime_duplicate_cleanups_state_check CHECK (
    (status = 'pending' AND provider_operation_id IS NULL
      AND delete_requested_at IS NULL AND completed_at IS NULL)
    OR (status IN ('delete_requested', 'waiting_deleted') AND provider_operation_id IS NOT NULL
      AND delete_requested_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'deleted' AND provider_operation_id IS NOT NULL
      AND delete_requested_at IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'already_deleted' AND completed_at IS NOT NULL)
    OR (status = 'blocked' AND completed_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX companion_runtime_duplicate_cleanups_provider_operation_uq
  ON public.companion_runtime_duplicate_cleanups(provider_operation_id)
  WHERE provider_operation_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX companion_runtime_duplicate_cleanups_pending_idx
  ON public.companion_runtime_duplicate_cleanups(operation_id, status, box_id)
  WHERE status NOT IN ('deleted', 'already_deleted', 'blocked');
--> statement-breakpoint

-- Only a digest and typed projection identity are retained. Raw broker/Pi lines never enter SQL.
CREATE TABLE public.companion_runtime_event_projections (
  org_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  broker_sequence bigint NOT NULL,
  pi_invocation_id text NOT NULL,
  projection_kind text NOT NULL,
  projection_sha256 text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT companion_runtime_event_projections_pk PRIMARY KEY (attempt_id, broker_sequence),
  CONSTRAINT companion_runtime_event_projections_org_companion_attempt_uq
    UNIQUE (org_id, companion_id, attempt_id, broker_sequence),
  CONSTRAINT companion_runtime_event_projections_attempt_fk
    FOREIGN KEY (org_id, companion_id, attempt_id)
    REFERENCES public.companion_turn_attempts(org_id, companion_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_runtime_event_projections_sequence_check CHECK (broker_sequence >= 1),
  CONSTRAINT companion_runtime_event_projections_invocation_check CHECK (
    char_length(pi_invocation_id) BETWEEN 1 AND 200 AND pi_invocation_id !~ E'[\\n\\r]'
  ),
  CONSTRAINT companion_runtime_event_projections_kind_check CHECK (
    projection_kind IN (
      'assistant', 'tool', 'decision', 'activity', 'settled', 'process_exit'
    )
  ),
  CONSTRAINT companion_runtime_event_projections_digest_check
    CHECK (projection_sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX companion_runtime_event_projections_cursor_idx
  ON public.companion_runtime_event_projections(attempt_id, broker_sequence);
--> statement-breakpoint

ALTER TABLE public.companion_runtime_duplicate_cleanups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_runtime_duplicate_cleanups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_runtime_event_projections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_runtime_event_projections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY companion_runtime_duplicate_cleanups_function_owner_rls
  ON public.companion_runtime_duplicate_cleanups FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY companion_runtime_event_projections_function_owner_rls
  ON public.companion_runtime_event_projections FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint

-- These policies admit the migration/function owner only. The executor still has no table grant.
CREATE POLICY skill_versions_runtime_v2_material_rls ON public.skill_versions FOR SELECT
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY companion_threads_runtime_v2_projection_rls ON public.companion_threads FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY companion_transcript_entries_runtime_v2_projection_rls
  ON public.companion_transcript_entries FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY companion_mcp_accounts_runtime_v2_refresh_rls
  ON public.companion_mcp_accounts FOR UPDATE
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_guard_duplicate_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF NEW.kind = 'start'
     AND OLD.checkpoint IN ('resolving_box', 'creating_box', 'box_resolved', 'box_created')
     AND NEW.checkpoint <> OLD.checkpoint
     AND EXISTS (
       SELECT 1
       FROM public.companion_runtime_duplicate_cleanups cleanup
       WHERE cleanup.org_id = NEW.org_id
         AND cleanup.companion_id = NEW.companion_id
         AND cleanup.operation_id = NEW.id
         AND cleanup.status NOT IN ('deleted', 'already_deleted')
     ) THEN
    RAISE EXCEPTION 'duplicate Box cleanup is incomplete' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER companion_operations_duplicate_cleanup_guard
  BEFORE UPDATE OF checkpoint ON public.companion_operations
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_guard_duplicate_cleanup();
--> statement-breakpoint

-- Return exactly the resources frozen on the claimed work row. The encrypted envelopes remain
-- ciphertext; decryption is process-local in apps/runtime and no plaintext crosses PostgreSQL.
CREATE FUNCTION public.companion_runtime_get_material(
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
  turn_id uuid,
  attempt_id uuid,
  message_event_id text,
  prompt_text text,
  decision_request_kind public.companion_decision_request_kind,
  decision_response_payload jsonb,
  provider_material jsonb,
  skill_material jsonb,
  mcp_material jsonb,
  model_input jsonb,
  has_visible_output boolean,
  credential_snapshot_matches boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_authorization record;
  v_turn_id uuid;
  v_message_event_id text;
  v_prompt_text text;
  v_request_kind public.companion_decision_request_kind;
  v_response_payload jsonb;
  v_provider_material jsonb := '[]'::jsonb;
  v_skill_material jsonb := '[]'::jsonb;
  v_mcp_material jsonb := '[]'::jsonb;
  v_visible_attempt_id uuid;
  v_has_visible_output boolean := false;
  v_pinned_provider_refs jsonb;
  v_pinned_mcp_refs jsonb;
  v_credential_snapshot_matches boolean := true;
  v_expected integer;
BEGIN
  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN
    RETURN;
  END IF;

  v_turn_id := v_authorization.turn_id;
  IF p_work_kind = 'attempt' THEN
    v_visible_attempt_id := p_work_id;
    SELECT attempt.provider_credential_refs, attempt.mcp_credential_refs,
      turn_row.message_event_id, entry.content
    INTO v_pinned_provider_refs, v_pinned_mcp_refs, v_message_event_id, v_prompt_text
    FROM public.companion_turn_attempts attempt
    JOIN public.companion_turns turn_row
      ON turn_row.org_id = attempt.org_id
     AND turn_row.companion_id = attempt.companion_id
     AND turn_row.id = attempt.turn_id
    JOIN public.companion_transcript_entries entry
      ON entry.org_id = turn_row.org_id
     AND entry.companion_id = turn_row.companion_id
     AND entry.event_id = turn_row.message_event_id
    WHERE attempt.org_id = p_org_id
      AND attempt.companion_id = p_companion_id
      AND attempt.id = p_work_id
      AND attempt.turn_id = v_turn_id
      AND attempt.claim_epoch = p_claim_epoch
      AND entry.role = 'user'
      AND entry.author_id = turn_row.actor_id
    FOR UPDATE OF attempt;
    IF NOT FOUND OR v_prompt_text IS NULL OR octet_length(v_prompt_text) > 1048576 THEN
      RAISE EXCEPTION 'claimed turn prompt is unavailable' USING ERRCODE = '22023';
    END IF;
    IF v_pinned_provider_refs IS NULL AND v_pinned_mcp_refs IS NULL THEN
      UPDATE public.companion_turn_attempts attempt
      SET provider_credential_refs = v_authorization.provider_refs,
          mcp_credential_refs = v_authorization.mcp_refs,
          updated_at = clock_timestamp()
      WHERE attempt.org_id = p_org_id
        AND attempt.companion_id = p_companion_id
        AND attempt.id = p_work_id
        AND attempt.claim_epoch = p_claim_epoch;
      v_pinned_provider_refs := v_authorization.provider_refs;
      v_pinned_mcp_refs := v_authorization.mcp_refs;
    ELSIF v_pinned_provider_refs IS NULL
       OR v_pinned_mcp_refs IS NULL
       OR v_pinned_provider_refs IS DISTINCT FROM v_authorization.provider_refs
       OR v_pinned_mcp_refs IS DISTINCT FROM v_authorization.mcp_refs THEN
      v_credential_snapshot_matches := false;
    END IF;
  END IF;

  IF p_work_kind = 'decision' THEN
    SELECT delivery.attempt_id, delivery.request_kind,
      CASE
        WHEN delivery.request_kind = 'question' AND delivery.decision_status = 'answered' THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key,
            'value', delivery.response_text
          )
        WHEN delivery.request_kind = 'confirmation' AND delivery.decision_status = 'allowed' THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key, 'confirmed', true
          )
        WHEN delivery.request_kind = 'confirmation' AND delivery.decision_status = 'denied' THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key, 'confirmed', false
          )
        WHEN delivery.decision_status IN ('denied', 'expired', 'cancelled') THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key, 'cancelled', true
          )
        ELSE NULL
      END
    INTO v_visible_attempt_id, v_request_kind, v_response_payload
    FROM public.companion_decision_deliveries delivery
    WHERE delivery.org_id = p_org_id
      AND delivery.companion_id = p_companion_id
      AND delivery.id = p_work_id
      AND delivery.claim_epoch = p_claim_epoch;
    IF NOT FOUND OR v_response_payload IS NULL OR octet_length(v_response_payload::text) > 32768 THEN
      RAISE EXCEPTION 'claimed decision response is unavailable' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'provider_id', connection.provider_id,
      'auth_method', connection.auth_method,
      'credential_generation', connection.credential_generation,
      'credential_version', connection.credential_version,
      'ciphertext', connection.ciphertext,
      'iv', connection.iv,
      'auth_tag', connection.auth_tag,
      'wrapped_dek', connection.wrapped_dek,
      'wrap_iv', connection.wrap_iv,
      'wrap_auth_tag', connection.wrap_auth_tag,
      'key_id', connection.key_id
    ) ORDER BY connection.provider_id), '[]'::jsonb)
  INTO v_provider_material
  FROM public.companion_provider_connections connection
  WHERE connection.org_id = p_org_id
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_authorization.provider_refs) ref
      WHERE ref ->> 'provider_id' = connection.provider_id
        AND ref ->> 'credential_generation' = connection.credential_generation::text
        AND (ref ->> 'credential_version')::integer = connection.credential_version
    );
  v_expected := jsonb_array_length(v_authorization.provider_refs);
  IF jsonb_array_length(v_provider_material) <> v_expected THEN
    RAISE EXCEPTION 'provider material changed after authorization' USING ERRCODE = '40001';
  END IF;

  IF v_authorization.client_surface IS DISTINCT FROM 'native_mobile' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_authorization.skill_refs) ref
      WHERE jsonb_typeof(ref) <> 'object'
        OR COALESCE(jsonb_typeof(ref -> 'skill_id'), 'missing') <> 'string'
        OR COALESCE(jsonb_typeof(ref -> 'current_version_id'), 'missing') <> 'string'
    ) THEN
      RAISE EXCEPTION 'Skill material is not pinned to an immutable version' USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'skill_id', skill.id,
        'slug', skill.slug,
        'version_id', version.id,
        'version', version.version,
        'checksum', version.checksum,
        'size_bytes', version.size_bytes,
        'storage_path', version.storage_path
      ) ORDER BY skill.id), '[]'::jsonb)
    INTO v_skill_material
    FROM public.skills skill
    JOIN public.skill_versions version
      ON version.org_id = skill.org_id AND version.skill_id = skill.id
    WHERE skill.org_id = p_org_id
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_authorization.skill_refs) ref
        WHERE ref ->> 'skill_id' = skill.id::text
          AND ref ->> 'current_version_id' = version.id::text
      );
    IF jsonb_array_length(v_skill_material) <> jsonb_array_length(v_authorization.skill_refs) THEN
      RAISE EXCEPTION 'Skill material changed after authorization' USING ERRCODE = '40001';
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'account_id', account.id,
        'owner_id', account.owner_id,
        'provider', account.provider,
        'label', account.label,
        'transport', account.transport,
        'account_config', account.account_config,
        'credential_generation', account.credential_generation,
        'ciphertext', account.ciphertext,
        'iv', account.iv,
        'auth_tag', account.auth_tag,
        'wrapped_dek', account.wrapped_dek,
        'wrap_iv', account.wrap_iv,
        'wrap_auth_tag', account.wrap_auth_tag,
        'key_id', account.key_id
      ) ORDER BY account.id), '[]'::jsonb)
    INTO v_mcp_material
    FROM public.companion_mcp_accounts account
    WHERE account.org_id = p_org_id
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_authorization.mcp_refs) ref
        WHERE ref ->> 'account_id' = account.id::text
          AND ref ->> 'credential_generation' = account.credential_generation::text
      );
    IF jsonb_array_length(v_mcp_material) <> jsonb_array_length(v_authorization.mcp_refs) THEN
      RAISE EXCEPTION 'MCP material changed after authorization' USING ERRCODE = '40001';
    END IF;
  END IF;

  IF octet_length(v_provider_material::text) > 2097152
     OR octet_length(v_skill_material::text) > 2097152
     OR octet_length(v_mcp_material::text) > 4194304 THEN
    RAISE EXCEPTION 'authorized material exceeds the bounded executor contract' USING ERRCODE = '22023';
  END IF;

  IF v_visible_attempt_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.companion_transcript_entries entry
      WHERE entry.org_id = p_org_id
        AND entry.companion_id = p_companion_id
        AND entry.event_id LIKE ('v2:' || v_visible_attempt_id::text || ':%')
        AND entry.role IN ('assistant', 'decision')
    ) INTO v_has_visible_output;
  END IF;

  RETURN QUERY SELECT
    v_turn_id, v_visible_attempt_id, v_message_event_id, v_prompt_text,
    v_request_kind, v_response_payload,
    v_provider_material, v_skill_material, v_mcp_material, NULL::jsonb,
    v_has_visible_output, v_credential_snapshot_matches;
END
$$;
--> statement-breakpoint

-- Read only the already-committed terminal proof needed after a lease takeover. This path is
-- deliberately independent of provider/MCP material: credential rotation after Pi emitted a
-- terminal record must not strand the broker cursor or reinterpret the projected transcript.
CREATE FUNCTION public.companion_runtime_get_attempt_terminal_projection(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid
)
RETURNS TABLE (
  checkpoint text,
  event_cursor bigint,
  has_visible_output boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_checkpoint text;
  v_event_cursor bigint;
  v_has_visible_output boolean;
BEGIN
  IF p_work_kind <> 'attempt' THEN
    RAISE EXCEPTION 'terminal projection is attempt-only' USING ERRCODE = '22023';
  END IF;

  SELECT attempt.checkpoint, attempt.event_cursor
  INTO v_checkpoint, v_event_cursor
  FROM public.companion_runtime_leases lease
  JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
  JOIN public.companion_turn_attempts attempt
    ON attempt.org_id = lease.org_id
   AND attempt.companion_id = lease.companion_id
   AND attempt.id = lease.work_id
  WHERE lease.org_id = p_org_id
    AND lease.companion_id = p_companion_id
    AND lease.claim_token = p_claim_token
    AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch
    AND lease.executor_id = p_executor_id
    AND lease.work_kind = p_work_kind
    AND lease.work_id = p_work_id
    AND lease.expires_at > clock_timestamp()
    AND control.enabled
    AND control.gate_epoch = p_gate_epoch
    AND attempt.claim_epoch = p_claim_epoch
    AND attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
    AND attempt.dispatch_state = 'accepted'
    AND attempt.checkpoint IN ('agent_settled', 'process_exited')
    AND attempt.event_cursor > 0
  FOR UPDATE OF lease, attempt;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.companion_transcript_entries entry
    WHERE entry.org_id = p_org_id
      AND entry.companion_id = p_companion_id
      AND entry.event_id LIKE ('v2:' || p_work_id::text || ':%')
      AND entry.role IN ('assistant', 'decision')
  ) INTO v_has_visible_output;

  RETURN QUERY SELECT v_checkpoint, v_event_cursor, v_has_visible_output;
END
$$;
--> statement-breakpoint

-- Refresh may only replace the encrypted envelope of an MCP account already frozen on the active
-- work item. credential_generation is the compare-and-swap token; config and identity are immutable.
CREATE FUNCTION public.companion_runtime_cas_mcp_oauth(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_account_id uuid,
  p_expected_generation uuid,
  p_next_generation uuid,
  p_ciphertext text,
  p_iv text,
  p_auth_tag text,
  p_wrapped_dek text,
  p_wrap_iv text,
  p_wrap_auth_tag text,
  p_key_id text
)
RETURNS TABLE (updated boolean, credential_generation uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_authorization record;
  v_current_generation uuid;
BEGIN
  IF p_work_kind NOT IN ('operation', 'settings')
     OR p_account_id IS NULL OR p_expected_generation IS NULL OR p_next_generation IS NULL
     OR p_expected_generation = p_next_generation
     OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 1048576
     OR p_iv IS NULL OR octet_length(p_iv) NOT BETWEEN 1 AND 16384
     OR p_auth_tag IS NULL OR octet_length(p_auth_tag) NOT BETWEEN 1 AND 16384
     OR p_wrapped_dek IS NULL OR octet_length(p_wrapped_dek) NOT BETWEEN 1 AND 1048576
     OR p_wrap_iv IS NULL OR octet_length(p_wrap_iv) NOT BETWEEN 1 AND 16384
     OR p_wrap_auth_tag IS NULL OR octet_length(p_wrap_auth_tag) NOT BETWEEN 1 AND 16384
     OR p_key_id IS NULL OR char_length(p_key_id) NOT BETWEEN 1 AND 200
     OR p_key_id ~ E'[\n\r]'
     OR p_ciphertext ~ E'[\n\r]' OR p_iv ~ E'[\n\r]' OR p_auth_tag ~ E'[\n\r]'
     OR p_wrapped_dek ~ E'[\n\r]' OR p_wrap_iv ~ E'[\n\r]' OR p_wrap_auth_tag ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid encrypted MCP refresh material or work kind' USING ERRCODE = '22023';
  END IF;

  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, 30
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_authorization.mcp_refs) ref
    WHERE ref ->> 'account_id' = p_account_id::text
  ) THEN
    RAISE EXCEPTION 'MCP account is not part of the authorized work snapshot' USING ERRCODE = '22023';
  END IF;

  SELECT account.credential_generation INTO v_current_generation
  FROM public.companion_mcp_accounts account
  WHERE account.org_id = p_org_id AND account.id = p_account_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_current_generation <> p_expected_generation THEN
    RETURN QUERY SELECT false, v_current_generation;
    RETURN;
  END IF;

  UPDATE public.companion_mcp_accounts account
  SET credential_generation = p_next_generation,
      ciphertext = p_ciphertext,
      iv = p_iv,
      auth_tag = p_auth_tag,
      wrapped_dek = p_wrapped_dek,
      wrap_iv = p_wrap_iv,
      wrap_auth_tag = p_wrap_auth_tag,
      key_id = p_key_id,
      updated_at = clock_timestamp()
  WHERE account.org_id = p_org_id
    AND account.id = p_account_id
    AND account.credential_generation = p_expected_generation
  RETURNING account.credential_generation INTO v_current_generation;
  IF NOT FOUND THEN
    RETURN QUERY
      SELECT false, account.credential_generation
      FROM public.companion_mcp_accounts account
      WHERE account.org_id = p_org_id AND account.id = p_account_id;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, v_current_generation;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_register_duplicate_cleanups(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_box_ids text[]
)
RETURNS TABLE (
  box_id text,
  status public.companion_duplicate_cleanup_status,
  provider_operation_id text,
  checkpoint_sequence bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_authorization record;
  v_canonical_box_id text;
BEGIN
  IF p_box_ids IS NULL OR cardinality(p_box_ids) > 64
     OR EXISTS (
       SELECT 1 FROM unnest(p_box_ids) candidate(box_id)
       WHERE candidate.box_id IS NULL
          OR candidate.box_id !~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'
     )
     OR cardinality(p_box_ids) <> (
       SELECT count(DISTINCT candidate.box_id)::integer FROM unnest(p_box_ids) candidate(box_id)
     ) THEN
    RAISE EXCEPTION 'invalid duplicate Box cleanup set' USING ERRCODE = '22023';
  END IF;
  IF p_work_kind <> 'operation' THEN
    RAISE EXCEPTION 'duplicate Box cleanup requires operation work' USING ERRCODE = '22023';
  END IF;

  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, 30
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN RETURN; END IF;

  SELECT instance.box_id INTO v_canonical_box_id
  FROM public.companion_operations operation
  JOIN public.companion_runtime_instances instance
    ON instance.org_id = operation.org_id AND instance.companion_id = operation.companion_id
  WHERE operation.org_id = p_org_id
    AND operation.companion_id = p_companion_id
    AND operation.id = p_work_id
    AND operation.kind = 'start'
    AND operation.status = 'running'
    AND operation.claim_epoch = p_claim_epoch
    AND (
      cardinality(p_box_ids) = 0
      OR operation.checkpoint IN (
        'resolving_box', 'creating_box', 'box_resolved', 'box_created'
      )
    )
  FOR UPDATE OF operation, instance;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_canonical_box_id = ANY(p_box_ids) THEN
    RAISE EXCEPTION 'canonical Box cannot be registered for duplicate cleanup' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.companion_runtime_duplicate_cleanups (
    org_id, companion_id, operation_id, box_id
  )
  SELECT p_org_id, p_companion_id, p_work_id, candidate.box_id
  FROM unnest(p_box_ids) candidate(box_id)
  ON CONFLICT ON CONSTRAINT companion_runtime_duplicate_cleanups_pk DO NOTHING;

  RETURN QUERY
  SELECT cleanup.box_id, cleanup.status, cleanup.provider_operation_id,
         cleanup.checkpoint_sequence
  FROM public.companion_runtime_duplicate_cleanups cleanup
  WHERE cleanup.org_id = p_org_id
    AND cleanup.companion_id = p_companion_id
    AND cleanup.operation_id = p_work_id
  ORDER BY cleanup.box_id;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_checkpoint_duplicate_cleanup(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_box_id text,
  p_expected_sequence bigint,
  p_next_status public.companion_duplicate_cleanup_status,
  p_provider_operation_id text
)
RETURNS TABLE (
  box_id text,
  status public.companion_duplicate_cleanup_status,
  provider_operation_id text,
  checkpoint_sequence bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_authorization record;
  v_cleanup public.companion_runtime_duplicate_cleanups%ROWTYPE;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_work_kind <> 'operation'
     OR p_box_id IS NULL
     OR p_box_id !~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$'
     OR p_expected_sequence IS NULL OR p_expected_sequence < 0
     OR p_next_status IS NULL
     OR (p_provider_operation_id IS NOT NULL AND (
       char_length(p_provider_operation_id) NOT BETWEEN 1 AND 200
       OR p_provider_operation_id ~ E'[\n\r]'
     )) THEN
    RAISE EXCEPTION 'invalid duplicate Box checkpoint' USING ERRCODE = '22023';
  END IF;

  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, 30
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN RETURN; END IF;

  SELECT cleanup.* INTO v_cleanup
  FROM public.companion_runtime_duplicate_cleanups cleanup
  JOIN public.companion_operations operation
    ON operation.org_id = cleanup.org_id
   AND operation.companion_id = cleanup.companion_id
   AND operation.id = cleanup.operation_id
  WHERE cleanup.org_id = p_org_id
    AND cleanup.companion_id = p_companion_id
    AND cleanup.operation_id = p_work_id
    AND cleanup.box_id = p_box_id
    AND operation.kind = 'start'
    AND operation.status = 'running'
    AND operation.claim_epoch = p_claim_epoch
  FOR UPDATE OF cleanup, operation;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_cleanup.checkpoint_sequence <> p_expected_sequence THEN
    RAISE EXCEPTION 'duplicate Box checkpoint sequence is stale' USING ERRCODE = '40001';
  END IF;
  IF p_provider_operation_id IS NOT NULL
     AND v_cleanup.provider_operation_id IS NOT NULL
     AND p_provider_operation_id <> v_cleanup.provider_operation_id THEN
    RAISE EXCEPTION 'duplicate Box provider operation is immutable' USING ERRCODE = '22023';
  END IF;
  IF NOT (
    (v_cleanup.status = 'pending' AND p_next_status IN ('delete_requested', 'already_deleted', 'blocked'))
    OR (v_cleanup.status = 'delete_requested' AND p_next_status IN ('waiting_deleted', 'deleted', 'already_deleted', 'blocked'))
    OR (v_cleanup.status = 'waiting_deleted' AND p_next_status IN ('deleted', 'already_deleted', 'blocked'))
  ) THEN
    RAISE EXCEPTION 'invalid duplicate Box cleanup transition' USING ERRCODE = '22023';
  END IF;
  IF p_next_status = 'delete_requested' AND p_provider_operation_id IS NULL THEN
    RAISE EXCEPTION 'duplicate Box delete request requires provider operation id' USING ERRCODE = '22023';
  END IF;

  UPDATE public.companion_runtime_duplicate_cleanups cleanup
  SET status = p_next_status,
      provider_operation_id = COALESCE(cleanup.provider_operation_id, p_provider_operation_id),
      checkpoint_sequence = cleanup.checkpoint_sequence + 1,
      delete_requested_at = CASE
        WHEN p_next_status = 'delete_requested' THEN COALESCE(cleanup.delete_requested_at, v_now)
        ELSE cleanup.delete_requested_at
      END,
      completed_at = CASE
        WHEN p_next_status IN ('deleted', 'already_deleted', 'blocked') THEN v_now
        ELSE NULL
      END,
      updated_at = v_now
  WHERE cleanup.org_id = p_org_id
    AND cleanup.companion_id = p_companion_id
    AND cleanup.operation_id = p_work_id
    AND cleanup.box_id = p_box_id
    AND cleanup.checkpoint_sequence = p_expected_sequence
  RETURNING cleanup.* INTO v_cleanup;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY SELECT v_cleanup.box_id, v_cleanup.status,
                      v_cleanup.provider_operation_id, v_cleanup.checkpoint_sequence;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_authorize_desktop(
  p_org_id uuid,
  p_companion_id uuid,
  p_actor_id text
)
RETURNS TABLE (
  authorized boolean,
  denial_code text,
  box_id text,
  box_state public.companion_box_observed_state,
  runtime_generation bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_box_id text;
  v_box_state public.companion_box_observed_state;
  v_generation bigint;
  v_authorized boolean := false;
BEGIN
  IF p_actor_id IS NULL OR char_length(p_actor_id) NOT BETWEEN 1 AND 200
     OR p_actor_id ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid desktop authorization actor' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.companion_runtime_control control
    WHERE control.id = 'runtime-v2' AND control.enabled
  ) THEN
    RETURN QUERY SELECT false, 'runtime_disabled'::text, NULL::text,
      NULL::public.companion_box_observed_state, NULL::bigint;
    RETURN;
  END IF;

  SELECT instance.box_id, instance.box_state, instance.generation,
    companion.owner_id = p_actor_id OR EXISTS (
      SELECT 1 FROM public.companion_workspace_access access
      WHERE access.org_id = companion.org_id
        AND access.companion_id = companion.id
        AND access.role = 'editor'
    )
  INTO v_box_id, v_box_state, v_generation, v_authorized
  FROM public.memberships membership
  JOIN public.companions companion
    ON companion.org_id = membership.org_id AND companion.id = p_companion_id
  JOIN public.companion_runtime_instances instance
    ON instance.org_id = companion.org_id AND instance.companion_id = companion.id
  WHERE membership.org_id = p_org_id
    AND membership.user_id = p_actor_id
    AND companion.org_id = p_org_id
    AND instance.retirement_state = 'active'
  FOR KEY SHARE OF membership, companion, instance;
  IF NOT FOUND OR NOT v_authorized THEN
    RETURN QUERY SELECT false, 'not_authorized'::text, NULL::text,
      NULL::public.companion_box_observed_state, NULL::bigint;
    RETURN;
  END IF;
  IF v_box_id IS NULL OR v_box_state NOT IN ('ready', 'idle', 'running') THEN
    RETURN QUERY SELECT false, 'box_unavailable'::text, NULL::text,
      NULL::public.companion_box_observed_state, NULL::bigint;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, NULL::text, v_box_id, v_box_state, v_generation;
END
$$;
--> statement-breakpoint

-- Persist normalized UI projections and the broker cursor in one transaction. The caller may ACK
-- the broker only after this function commits. Unknown/malformed/oversized records are represented
-- only by cumulative counters; no rejected line or raw Pi event is accepted here.
CREATE FUNCTION public.companion_runtime_project_event_batch(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_expected_sequence bigint,
  p_pi_invocation_id text,
  p_events jsonb,
  p_through_cursor bigint,
  p_activity_at timestamp with time zone,
  p_unknown_event_count integer,
  p_malformed_event_count integer,
  p_oversized_event_count integer
)
RETURNS TABLE (checkpoint_sequence bigint, event_cursor bigint, has_visible_output boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_attempt public.companion_turn_attempts%ROWTYPE;
  v_turn public.companion_turns%ROWTYPE;
  v_event jsonb;
  v_event_count integer;
  v_sequence bigint;
  v_previous_sequence bigint := 0;
  v_event_type text;
  v_event_hash text;
  v_existing_hash text;
  v_event_id text;
  v_existing_event_id text;
  v_ordinal integer;
  v_content text;
  v_reasoning text;
  v_tool jsonb;
  v_decision jsonb;
  v_request_key text;
  v_request_kind public.companion_decision_request_kind;
  v_expires_at timestamp with time zone;
  v_inserted integer;
  v_has_decision boolean := false;
  v_has_activity boolean := false;
  v_has_settled boolean := false;
  v_has_process_exit boolean := false;
  v_now timestamp with time zone := clock_timestamp();
  v_effective_activity_at timestamp with time zone;
  v_next_status public.companion_attempt_status;
BEGIN
  -- This is the only executor capability that still projects into the legacy thread aggregate.
  -- Pin the diagnostic mutation protocol at execution time: CREATE FUNCTION proconfig for a custom
  -- GUC would require an administrator-only parameter grant during a fresh migration.
  PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
  IF p_work_kind <> 'attempt'
     OR p_expected_sequence IS NULL OR p_expected_sequence < 0
     OR p_pi_invocation_id IS NULL
     OR char_length(p_pi_invocation_id) NOT BETWEEN 1 AND 200
     OR p_pi_invocation_id ~ E'[\n\r]'
     OR p_events IS NULL OR jsonb_typeof(p_events) <> 'array'
     OR octet_length(p_events::text) > 4194304
     OR p_through_cursor IS NULL OR p_through_cursor < 1
     OR p_unknown_event_count IS NULL OR p_unknown_event_count < 0
     OR p_malformed_event_count IS NULL OR p_malformed_event_count < 0
     OR p_oversized_event_count IS NULL OR p_oversized_event_count < 0 THEN
    RAISE EXCEPTION 'invalid Runtime v2 event batch' USING ERRCODE = '22023';
  END IF;
  v_event_count := jsonb_array_length(p_events);
  IF v_event_count > 256 THEN
    RAISE EXCEPTION 'Runtime v2 event batch is too large' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.companion_runtime_leases lease
  JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
  WHERE lease.org_id = p_org_id
    AND lease.companion_id = p_companion_id
    AND lease.claim_token = p_claim_token
    AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch
    AND lease.executor_id = p_executor_id
    AND lease.work_kind = p_work_kind
    AND lease.work_id = p_work_id
    AND lease.expires_at > clock_timestamp()
    AND control.enabled
    AND control.gate_epoch = p_gate_epoch
  FOR UPDATE OF lease;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT attempt.* INTO v_attempt
  FROM public.companion_turn_attempts attempt
  WHERE attempt.org_id = p_org_id
    AND attempt.companion_id = p_companion_id
    AND attempt.id = p_work_id
    AND attempt.claim_epoch = p_claim_epoch
    AND attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
    AND attempt.dispatch_state = 'accepted'
    AND attempt.pi_invocation_id = p_pi_invocation_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT turn_row.* INTO v_turn
  FROM public.companion_turns turn_row
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = p_companion_id
    AND turn_row.id = v_attempt.turn_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_now := clock_timestamp();
  IF (v_turn.absolute_deadline_at IS NOT NULL AND v_now >= v_turn.absolute_deadline_at)
     OR (v_turn.inactivity_deadline_at IS NOT NULL AND v_now >= v_turn.inactivity_deadline_at) THEN
    RETURN;
  END IF;
  IF p_unknown_event_count < v_attempt.unknown_event_count
     OR p_malformed_event_count < v_attempt.malformed_event_count
     OR p_oversized_event_count < v_attempt.oversized_event_count THEN
    RAISE EXCEPTION 'Runtime v2 parser counters cannot rewind' USING ERRCODE = '22023';
  END IF;

  -- Validate the full typed batch before any insert. Sequence gaps are legal because rejected or
  -- unsupported broker records advance the acknowledged cursor but are represented only by counts.
  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events)
  LOOP
    IF jsonb_typeof(v_event) <> 'object'
       OR COALESCE(jsonb_typeof(v_event -> 'sequence'), 'missing') <> 'string'
       OR (v_event ->> 'sequence') !~ '^[1-9][0-9]{0,17}$'
       OR COALESCE(jsonb_typeof(v_event -> 'type'), 'missing') <> 'string' THEN
      RAISE EXCEPTION 'invalid normalized Runtime v2 event' USING ERRCODE = '22023';
    END IF;
    v_sequence := (v_event ->> 'sequence')::bigint;
    v_event_type := v_event ->> 'type';
    IF v_sequence <= v_previous_sequence OR v_sequence > p_through_cursor THEN
      RAISE EXCEPTION 'Runtime v2 event sequences are not strictly ordered' USING ERRCODE = '22023';
    END IF;
    v_previous_sequence := v_sequence;

    IF v_event_type = 'assistant' THEN
      IF v_event - ARRAY['sequence','type','entry_key','content','reasoning']::text[] <> '{}'::jsonb
         OR COALESCE(jsonb_typeof(v_event -> 'entry_key'), 'missing') <> 'string'
         OR char_length(v_event ->> 'entry_key') NOT BETWEEN 1 AND 240
         OR (v_event ->> 'entry_key') ~ E'[\n\r]'
         OR COALESCE(jsonb_typeof(v_event -> 'content'), 'missing') <> 'string'
         OR char_length(v_event ->> 'content') > 100000
         OR octet_length(v_event ->> 'content') > 1048576
         OR COALESCE(jsonb_typeof(v_event -> 'reasoning'), 'null') NOT IN ('string', 'null')
         OR char_length(COALESCE(v_event ->> 'reasoning', '')) > 16000
         OR octet_length(COALESCE(v_event ->> 'reasoning', '')) > 48000 THEN
        RAISE EXCEPTION 'invalid assistant projection' USING ERRCODE = '22023';
      END IF;
      v_has_activity := true;
    ELSIF v_event_type = 'tool' THEN
      v_tool := v_event -> 'tool';
      IF v_event - ARRAY['sequence','type','entry_key','content','tool']::text[] <> '{}'::jsonb
         OR COALESCE(jsonb_typeof(v_event -> 'entry_key'), 'missing') <> 'string'
         OR char_length(v_event ->> 'entry_key') NOT BETWEEN 1 AND 240
         OR (v_event ->> 'entry_key') ~ E'[\n\r]'
         OR COALESCE(jsonb_typeof(v_event -> 'content'), 'missing') <> 'string'
         OR char_length(v_event ->> 'content') > 300
         OR COALESCE(jsonb_typeof(v_tool), 'missing') <> 'object'
         OR v_tool - ARRAY['call_id','kind','name','title','status','detail','screenshot']::text[] <> '{}'::jsonb
         OR NOT (v_tool ?& ARRAY['call_id','kind','name','title','status','detail','screenshot'])
         OR COALESCE(jsonb_typeof(v_tool -> 'call_id'), 'null') NOT IN ('string', 'null')
         OR char_length(COALESCE(v_tool ->> 'call_id', '')) > 200
         OR COALESCE(jsonb_typeof(v_tool -> 'kind'), 'missing') <> 'string'
         OR (v_tool ->> 'kind') NOT IN ('shell', 'file', 'browse', 'computer', 'tool')
         OR COALESCE(jsonb_typeof(v_tool -> 'name'), 'missing') <> 'string'
         OR char_length(v_tool ->> 'name') NOT BETWEEN 1 AND 120
         OR COALESCE(jsonb_typeof(v_tool -> 'title'), 'missing') <> 'string'
         OR char_length(v_tool ->> 'title') > 300
         OR COALESCE(jsonb_typeof(v_tool -> 'status'), 'missing') <> 'string'
         OR (v_tool ->> 'status') NOT IN ('running', 'ok', 'error', 'timeout')
         OR COALESCE(jsonb_typeof(v_tool -> 'detail'), 'null') NOT IN ('string', 'null')
         OR char_length(COALESCE(v_tool ->> 'detail', '')) > 16000
         OR jsonb_typeof(v_tool -> 'screenshot') IS DISTINCT FROM 'null'
         OR octet_length(v_tool::text) > 262144 THEN
        RAISE EXCEPTION 'invalid tool projection' USING ERRCODE = '22023';
      END IF;
      v_has_activity := true;
    ELSIF v_event_type = 'decision' THEN
      v_decision := v_event -> 'decision';
      IF v_event - ARRAY[
          'sequence','type','entry_key','request_key','request_kind','content','decision','expires_at'
        ]::text[] <> '{}'::jsonb
         OR COALESCE(jsonb_typeof(v_event -> 'entry_key'), 'missing') <> 'string'
         OR char_length(v_event ->> 'entry_key') NOT BETWEEN 1 AND 240
         OR (v_event ->> 'entry_key') ~ E'[\n\r]'
         OR COALESCE(jsonb_typeof(v_event -> 'request_key'), 'missing') <> 'string'
         OR char_length(v_event ->> 'request_key') NOT BETWEEN 1 AND 200
         OR (v_event ->> 'request_key') ~ E'[\n\r]'
         OR COALESCE(jsonb_typeof(v_event -> 'request_kind'), 'missing') <> 'string'
         OR (v_event ->> 'request_kind') NOT IN ('question', 'confirmation')
         OR COALESCE(jsonb_typeof(v_event -> 'content'), 'missing') <> 'string'
         OR char_length(v_event ->> 'content') > 300
         OR COALESCE(jsonb_typeof(v_event -> 'expires_at'), 'missing') <> 'string'
         OR COALESCE(jsonb_typeof(v_decision), 'missing') <> 'object'
         OR v_decision - ARRAY[
           'request_id','kind','name','title','detail','status','answer',
           'decided_by_id','decided_by_name','decided_at','expires_at'
         ]::text[] <> '{}'::jsonb
         OR NOT (v_decision ?& ARRAY[
           'request_id','kind','name','title','detail','status','answer',
           'decided_by_id','decided_by_name','decided_at','expires_at'
         ])
         OR v_decision ->> 'request_id' IS DISTINCT FROM v_event ->> 'request_key'
         OR (v_decision ->> 'kind') NOT IN ('shell', 'file', 'question')
         OR ((v_event ->> 'request_kind' = 'question') IS DISTINCT FROM
             (v_decision ->> 'kind' = 'question'))
         OR COALESCE(jsonb_typeof(v_decision -> 'name'), 'missing') <> 'string'
         OR char_length(v_decision ->> 'name') NOT BETWEEN 1 AND 120
         OR COALESCE(jsonb_typeof(v_decision -> 'title'), 'missing') <> 'string'
         OR char_length(v_decision ->> 'title') > 300
         OR v_decision ->> 'title' IS DISTINCT FROM v_event ->> 'content'
         OR COALESCE(jsonb_typeof(v_decision -> 'detail'), 'null') NOT IN ('string', 'null')
         OR char_length(COALESCE(v_decision ->> 'detail', '')) > 16000
         OR v_decision ->> 'status' IS DISTINCT FROM 'pending'
         OR jsonb_typeof(v_decision -> 'answer') IS DISTINCT FROM 'null'
         OR jsonb_typeof(v_decision -> 'decided_by_id') IS DISTINCT FROM 'null'
         OR jsonb_typeof(v_decision -> 'decided_by_name') IS DISTINCT FROM 'null'
         OR jsonb_typeof(v_decision -> 'decided_at') IS DISTINCT FROM 'null'
         OR v_decision ->> 'expires_at' IS DISTINCT FROM v_event ->> 'expires_at'
         OR octet_length(v_decision::text) > 262144 THEN
        RAISE EXCEPTION 'invalid decision projection' USING ERRCODE = '22023';
      END IF;
      BEGIN
        v_expires_at := (v_event ->> 'expires_at')::timestamp with time zone;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'invalid decision expiry' USING ERRCODE = '22023';
      END;
      IF v_expires_at <= v_now OR v_expires_at > v_now + interval '24 hours' THEN
        RAISE EXCEPTION 'invalid decision expiry' USING ERRCODE = '22023';
      END IF;
      v_has_decision := true;
      v_has_activity := true;
    ELSIF v_event_type = 'activity' THEN
      IF v_event - ARRAY['sequence','type','event_type']::text[] <> '{}'::jsonb
         OR COALESCE(jsonb_typeof(v_event -> 'event_type'), 'missing') <> 'string'
         OR (v_event ->> 'event_type') NOT IN (
           'agent_start', 'agent_end', 'turn_start', 'turn_end',
           'message_start', 'message_update', 'message_end',
           'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
           'extension_ui_request', 'extension_error', 'auto_retry_start', 'auto_retry_end',
           'queue_update', 'compaction_start', 'compaction_update', 'compaction_end'
         ) THEN
        RAISE EXCEPTION 'invalid activity projection' USING ERRCODE = '22023';
      END IF;
      v_has_activity := true;
    ELSIF v_event_type = 'settled' THEN
      IF v_event - ARRAY['sequence','type']::text[] <> '{}'::jsonb THEN
        RAISE EXCEPTION 'invalid settlement projection' USING ERRCODE = '22023';
      END IF;
      v_has_settled := true;
    ELSIF v_event_type = 'process_exit' THEN
      IF v_event - ARRAY['sequence','type','code','signal']::text[] <> '{}'::jsonb
         OR COALESCE(jsonb_typeof(v_event -> 'code'), 'null') NOT IN ('number', 'null')
         OR (jsonb_typeof(v_event -> 'code') = 'number' AND (
           (v_event ->> 'code') !~ '^-?[0-9]{1,10}$'
           OR (v_event ->> 'code')::numeric NOT BETWEEN -2147483648 AND 2147483647
         ))
         OR COALESCE(jsonb_typeof(v_event -> 'signal'), 'null') NOT IN ('string', 'null')
         OR char_length(COALESCE(v_event ->> 'signal', '')) > 40
         OR COALESCE(v_event ->> 'signal', '') ~ E'[\n\r]' THEN
        RAISE EXCEPTION 'invalid process exit projection' USING ERRCODE = '22023';
      END IF;
      v_has_process_exit := true;
    ELSE
      RAISE EXCEPTION 'unsupported normalized Runtime v2 event' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF v_attempt.event_cursor >= p_through_cursor THEN
    -- A response-lost retry may replay an already committed page. Verify every supplied digest and
    -- return the current cursor/sequence; partial or altered replay is a serialization conflict.
    FOR v_event IN SELECT value FROM jsonb_array_elements(p_events)
    LOOP
      v_sequence := (v_event ->> 'sequence')::bigint;
      v_event_hash := encode(sha256(convert_to(v_event::text, 'UTF8')), 'hex');
      SELECT projection.projection_sha256 INTO v_existing_hash
      FROM public.companion_runtime_event_projections projection
      WHERE projection.attempt_id = p_work_id AND projection.broker_sequence = v_sequence;
      IF NOT FOUND OR v_existing_hash <> v_event_hash THEN
        RAISE EXCEPTION 'Runtime v2 event replay does not match committed projection'
          USING ERRCODE = '40001';
      END IF;
    END LOOP;
    IF p_unknown_event_count > v_attempt.unknown_event_count
       OR p_malformed_event_count > v_attempt.malformed_event_count
       OR p_oversized_event_count > v_attempt.oversized_event_count THEN
      RAISE EXCEPTION 'Runtime v2 replay counters exceed committed counters' USING ERRCODE = '40001';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.companion_transcript_entries entry
      WHERE entry.org_id = p_org_id
        AND entry.companion_id = p_companion_id
        AND entry.event_id LIKE ('v2:' || p_work_id::text || ':%')
        AND entry.role IN ('assistant', 'decision')
    ) INTO has_visible_output;
    RETURN QUERY SELECT v_attempt.checkpoint_sequence, v_attempt.event_cursor, has_visible_output;
    RETURN;
  END IF;
  IF v_attempt.checkpoint_sequence <> p_expected_sequence THEN
    RAISE EXCEPTION 'Runtime v2 event checkpoint sequence is stale' USING ERRCODE = '40001';
  END IF;
  IF p_through_cursor <= v_attempt.event_cursor
     OR p_through_cursor > v_attempt.event_cursor + 10000
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_events) supplied(value)
       WHERE (supplied.value ->> 'sequence')::bigint <= v_attempt.event_cursor
     ) THEN
    RAISE EXCEPTION 'Runtime v2 event cursor did not advance consistently' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.companion_threads(org_id, companion_id, next_ordinal)
  VALUES (p_org_id, p_companion_id, 0)
  ON CONFLICT (companion_id) DO NOTHING;

  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events)
  LOOP
    v_sequence := (v_event ->> 'sequence')::bigint;
    v_event_type := v_event ->> 'type';
    v_event_hash := encode(sha256(convert_to(v_event::text, 'UTF8')), 'hex');
    INSERT INTO public.companion_runtime_event_projections(
      org_id, companion_id, attempt_id, broker_sequence,
      pi_invocation_id, projection_kind, projection_sha256
    ) VALUES (
      p_org_id, p_companion_id, p_work_id, v_sequence,
      p_pi_invocation_id, v_event_type, v_event_hash
    );

    v_event_id := 'v2:' || p_work_id::text || ':' || v_sequence::text;
    IF v_event_type = 'assistant' THEN
      v_content := v_event ->> 'content';
      v_reasoning := v_event ->> 'reasoning';
      UPDATE public.companion_threads thread
      SET next_ordinal = thread.next_ordinal + 1,
          last_message_at = v_now,
          updated_at = v_now
      WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
      RETURNING thread.next_ordinal - 1 INTO v_ordinal;
      INSERT INTO public.companion_transcript_entries(
        org_id, companion_id, event_id, ordinal, role, content, reasoning, created_at
      ) VALUES (
        p_org_id, p_companion_id, v_event_id, v_ordinal, 'assistant',
        v_content, v_reasoning, v_now
      );
    ELSIF v_event_type = 'tool' THEN
      v_content := v_event ->> 'content';
      v_tool := v_event -> 'tool';
      v_existing_event_id := NULL;
      IF v_tool ->> 'call_id' IS NOT NULL THEN
        SELECT entry.event_id INTO v_existing_event_id
        FROM public.companion_transcript_entries entry
        WHERE entry.org_id = p_org_id
          AND entry.companion_id = p_companion_id
          AND entry.role = 'tool'
          AND entry.event_id LIKE ('v2:' || p_work_id::text || ':%')
          AND entry.tool ->> 'call_id' = v_tool ->> 'call_id'
        ORDER BY entry.ordinal DESC
        LIMIT 1
        FOR UPDATE;
      END IF;
      IF v_existing_event_id IS NULL THEN
        UPDATE public.companion_threads thread
        SET next_ordinal = thread.next_ordinal + 1,
            last_message_at = v_now,
            updated_at = v_now
        WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
        RETURNING thread.next_ordinal - 1 INTO v_ordinal;
        INSERT INTO public.companion_transcript_entries(
          org_id, companion_id, event_id, ordinal, role, content, tool, created_at
        ) VALUES (
          p_org_id, p_companion_id, v_event_id, v_ordinal, 'tool', v_content, v_tool, v_now
        );
      ELSE
        UPDATE public.companion_transcript_entries entry
        SET content = v_content, tool = v_tool
        WHERE entry.org_id = p_org_id
          AND entry.companion_id = p_companion_id
          AND entry.event_id = v_existing_event_id;
        UPDATE public.companion_threads thread
        SET last_message_at = v_now, updated_at = v_now
        WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id;
      END IF;
    ELSIF v_event_type = 'decision' THEN
      v_content := v_event ->> 'content';
      v_request_key := v_event ->> 'request_key';
      v_request_kind := (v_event ->> 'request_kind')::public.companion_decision_request_kind;
      v_expires_at := LEAST(
        (v_event ->> 'expires_at')::timestamp with time zone,
        COALESCE(v_turn.absolute_deadline_at, 'infinity'::timestamp with time zone)
      );
      v_decision := jsonb_build_object(
        'request_id', v_request_key,
        'kind', v_event -> 'decision' ->> 'kind',
        'name', v_event -> 'decision' ->> 'name',
        'title', v_event -> 'decision' ->> 'title',
        'detail', v_event -> 'decision' -> 'detail',
        'status', 'pending',
        'answer', NULL,
        'decided_by_id', NULL,
        'decided_by_name', NULL,
        'decided_at', NULL,
        'expires_at', to_char(
          v_expires_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      );
      INSERT INTO public.companion_decision_deliveries(
        org_id, companion_id, turn_id, attempt_id, request_key, request_kind, expires_at
      ) VALUES (
        p_org_id, p_companion_id, v_attempt.turn_id, p_work_id,
        v_request_key, v_request_kind, v_expires_at
      )
      ON CONFLICT ON CONSTRAINT companion_decision_deliveries_request_uq DO NOTHING;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      IF v_inserted = 1 THEN
        UPDATE public.companion_threads thread
        SET next_ordinal = thread.next_ordinal + 1,
            last_message_at = v_now,
            updated_at = v_now
        WHERE thread.org_id = p_org_id AND thread.companion_id = p_companion_id
        RETURNING thread.next_ordinal - 1 INTO v_ordinal;
        INSERT INTO public.companion_transcript_entries(
          org_id, companion_id, event_id, ordinal, role, content, decision, created_at
        ) VALUES (
          p_org_id, p_companion_id, v_event_id, v_ordinal, 'decision',
          v_content, v_decision, v_now
        );
      ELSE
        PERFORM 1
        FROM public.companion_decision_deliveries delivery
        WHERE delivery.org_id = p_org_id
          AND delivery.companion_id = p_companion_id
          AND delivery.attempt_id = p_work_id
          AND delivery.request_key = v_request_key
          AND delivery.request_kind = v_request_kind;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'decision request key was reused inconsistently' USING ERRCODE = '22023';
        END IF;
      END IF;
    END IF;
  END LOOP;

  v_next_status := CASE WHEN v_has_decision AND NOT v_has_settled AND NOT v_has_process_exit
                        THEN 'needs_input'
                        ELSE 'running' END::public.companion_attempt_status;
  v_effective_activity_at := CASE
    WHEN v_has_activity THEN GREATEST(
      COALESCE(v_attempt.last_activity_at, '-infinity'::timestamp with time zone),
      LEAST(COALESCE(p_activity_at, v_now), v_now)
    )
    ELSE v_attempt.last_activity_at
  END;

  UPDATE public.companion_turn_attempts attempt
  SET status = v_next_status,
      -- The terminal proof and cursor advance are one durable mutation. If the SQL response or the
      -- subsequent broker ACK is lost, a lease takeover can ACK this cursor and settle immediately
      -- instead of polling forever beyond the already-projected terminal record.
      checkpoint = CASE
        WHEN v_has_process_exit THEN 'process_exited'
        WHEN v_has_settled THEN 'agent_settled'
        ELSE 'event_projected'
      END,
      checkpoint_sequence = attempt.checkpoint_sequence + 1,
      event_cursor = p_through_cursor,
      last_activity_at = v_effective_activity_at,
      unknown_event_count = p_unknown_event_count,
      malformed_event_count = p_malformed_event_count,
      oversized_event_count = p_oversized_event_count,
      updated_at = v_now
  WHERE attempt.org_id = p_org_id
    AND attempt.companion_id = p_companion_id
    AND attempt.id = p_work_id
    AND attempt.claim_epoch = p_claim_epoch
    AND attempt.checkpoint_sequence = p_expected_sequence
  RETURNING attempt.checkpoint_sequence, attempt.event_cursor
  INTO checkpoint_sequence, event_cursor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Runtime v2 event checkpoint sequence changed' USING ERRCODE = '40001';
  END IF;

  UPDATE public.companion_turns turn_row
  SET status = v_next_status::text::public.companion_turn_status,
      inactivity_deadline_at = CASE
        WHEN v_effective_activity_at IS NULL THEN turn_row.inactivity_deadline_at
        ELSE LEAST(turn_row.absolute_deadline_at, v_effective_activity_at + interval '10 minutes')
      END,
      state_changed_at = CASE
        WHEN turn_row.status::text = v_next_status::text THEN turn_row.state_changed_at ELSE v_now
      END,
      updated_at = v_now
  WHERE turn_row.org_id = p_org_id
    AND turn_row.companion_id = p_companion_id
    AND turn_row.id = v_attempt.turn_id;
  UPDATE public.companion_runtime_instances instance
  SET last_write_epoch = GREATEST(instance.last_write_epoch, p_claim_epoch), updated_at = v_now
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;

  SELECT EXISTS (
    SELECT 1 FROM public.companion_transcript_entries entry
    WHERE entry.org_id = p_org_id
      AND entry.companion_id = p_companion_id
      AND entry.event_id LIKE ('v2:' || p_work_id::text || ':%')
      AND entry.role IN ('assistant', 'decision')
  ) INTO has_visible_output;

  RETURN NEXT;
END
$$;
--> statement-breakpoint

-- A successfully delivered extension response wakes the same attempt back up. The decision has
-- its own lease/checkpoint row, so this parent transition must happen in the same transaction as
-- `companion_runtime_settle`: otherwise the attempt remains permanently parked in needs_input and
-- no executor can consume Pi's post-response events. A response is user activity and therefore
-- receives a fresh inactivity window, still capped by the turn's absolute deadline.
CREATE FUNCTION public.companion_runtime_resume_after_decision_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF NEW.delivery_state <> 'delivered' OR OLD.delivery_state = 'delivered' THEN
    RETURN NEW;
  END IF;

  -- This additive migration must also upgrade databases that already ran 0090. Keep the trigger
  -- narrow by proving the exact live decision lease and the write-intent evidence that only the
  -- fenced settlement function can produce; a generic table update must never resume a turn.
  IF OLD.delivery_state <> 'write_intent'
     OR NEW.delivery_checkpoint <> 'delivered'
     OR NEW.command_id IS NULL
     OR NEW.delivered_at IS NULL
     OR NEW.claim_epoch IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.companion_runtime_leases lease
       JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
       WHERE lease.org_id = NEW.org_id
         AND lease.companion_id = NEW.companion_id
         AND lease.work_kind = 'decision'
         AND lease.work_id = NEW.id
         AND lease.claim_epoch = NEW.claim_epoch
         AND lease.gate_epoch = control.gate_epoch
         AND lease.expires_at > v_now
         AND control.enabled
     ) THEN
    RAISE EXCEPTION 'delivered decision lacks a live fenced write intent' USING ERRCODE = '22023';
  END IF;

  -- Pi may have emitted more than one pending request. Delivering one response does not prove it
  -- can run again while a sibling request remains unresolved.
  IF EXISTS (
    SELECT 1
    FROM public.companion_decision_deliveries sibling
    WHERE sibling.org_id = NEW.org_id
      AND sibling.companion_id = NEW.companion_id
      AND sibling.attempt_id = NEW.attempt_id
      AND sibling.id <> NEW.id
      AND sibling.delivery_state NOT IN ('delivered', 'cancelled')
  ) THEN
    RETURN NEW;
  END IF;

  UPDATE public.companion_turn_attempts attempt
  SET status = 'running',
      last_activity_at = GREATEST(COALESCE(attempt.last_activity_at, v_now), v_now),
      updated_at = v_now
  WHERE attempt.org_id = NEW.org_id
    AND attempt.companion_id = NEW.companion_id
    AND attempt.id = NEW.attempt_id
    AND attempt.turn_id = NEW.turn_id
    AND attempt.status = 'needs_input';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivered decision has no resumable attempt' USING ERRCODE = '40001';
  END IF;

  UPDATE public.companion_turns turn_row
  SET status = 'running',
      inactivity_deadline_at = LEAST(
        COALESCE(turn_row.absolute_deadline_at, v_now + interval '10 minutes'),
        v_now + interval '10 minutes'
      ),
      state_changed_at = CASE
        WHEN turn_row.status = 'running' THEN turn_row.state_changed_at ELSE v_now
      END,
      updated_at = v_now
  WHERE turn_row.org_id = NEW.org_id
    AND turn_row.companion_id = NEW.companion_id
    AND turn_row.id = NEW.turn_id
    AND turn_row.status = 'needs_input';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivered decision has no resumable turn' USING ERRCODE = '40001';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER companion_decision_deliveries_resume_parent
  AFTER UPDATE OF delivery_state ON public.companion_decision_deliveries
  FOR EACH ROW
  WHEN (NEW.delivery_state = 'delivered' AND OLD.delivery_state <> 'delivered')
  EXECUTE FUNCTION public.companion_runtime_resume_after_decision_delivery();
--> statement-breakpoint

-- Fail closed in the migration transaction. The post-migration grants hook repeats these revokes
-- and grants only the dedicated runtime login the narrow callable functions.
REVOKE ALL ON TABLE public.companion_runtime_duplicate_cleanups FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.companion_runtime_event_projections FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_guard_duplicate_cleanup() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_resume_after_decision_delivery() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_get_material(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_get_attempt_terminal_projection(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_cas_mcp_oauth(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid,
  uuid, uuid, uuid, text, text, text, text, text, text, text
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_register_duplicate_cleanups(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, text[]
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_checkpoint_duplicate_cleanup(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid,
  text, bigint, public.companion_duplicate_cleanup_status, text
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_authorize_desktop(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_project_event_batch(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid,
  bigint, text, jsonb, bigint, timestamp with time zone, integer, integer, integer
) FROM PUBLIC;
--> statement-breakpoint
