-- Config proposal decision kind. Inert: nothing emits this kind yet. The generic
-- answer_decision path rejects it fail-closed until companion_api_answer_config_decision
-- lands. ALTER TYPE ADD VALUE is the first statement so later DDL can mention the label
-- only as text in this same transaction (PostgreSQL cannot read a newly added enum label
-- until commit).

ALTER TYPE public.companion_decision_request_kind ADD VALUE IF NOT EXISTS 'config_proposal';
--> statement-breakpoint

ALTER TABLE public.companion_decision_deliveries
  ADD COLUMN proposal jsonb;
--> statement-breakpoint

-- Compare request_kind as text: PostgreSQL refuses to read an enum label added earlier
-- in the same transaction.
ALTER TABLE public.companion_decision_deliveries
  ADD CONSTRAINT companion_decision_deliveries_proposal_check
  CHECK (
    (
      proposal IS NULL
      AND request_kind::text <> 'config_proposal'
    )
    OR (
      request_kind::text = 'config_proposal'
      AND proposal IS NOT NULL
      AND jsonb_typeof(proposal) = 'object'
      AND octet_length(proposal::text) <= 16384
    )
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_get_material(
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
  attachments jsonb,
  credential_snapshot_matches boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
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
  v_attachments jsonb := '[]'::jsonb;
  v_attachment_bytes bigint := 0;
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

    -- Files the runtime must stage read-only on the Box before it dispatches this prompt. The
    -- storage key travels because only the runtime holds object-storage credentials; the digest
    -- travels so the bytes it downloads can be proven to be the bytes that were accepted.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', attachment.id,
        'storage_key', attachment.storage_key,
        'content_type', attachment.content_type,
        'byte_size', attachment.byte_size,
        'sha256', attachment.sha256,
        'filename', attachment.filename,
        'position', attachment.position
      ) ORDER BY attachment.position), '[]'::jsonb),
      COALESCE(sum(attachment.byte_size), 0)
    INTO v_attachments, v_attachment_bytes
    FROM public.companion_message_attachments attachment
    WHERE attachment.org_id = p_org_id
      AND attachment.companion_id = p_companion_id
      AND attachment.entry_event_id = v_message_event_id
      AND attachment.kind = 'user_upload';
    IF jsonb_array_length(v_attachments) > 5 OR v_attachment_bytes > 52428800 THEN
      RAISE EXCEPTION 'claimed turn attachments exceed the bounded executor contract'
        USING ERRCODE = '22023';
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
        WHEN delivery.request_kind::text IN ('confirmation', 'config_proposal')
             AND delivery.decision_status = 'allowed' THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key, 'confirmed', true
          )
        WHEN delivery.request_kind::text IN ('confirmation', 'config_proposal')
             AND delivery.decision_status = 'denied' THEN
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
    v_has_visible_output, v_attachments, v_credential_snapshot_matches;
END
$function$;
--> statement-breakpoint

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_project_event_batch(
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
  v_proposal jsonb;
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
          'sequence','type','entry_key','request_key','request_kind','content','decision',
          'expires_at','proposal'
        ]::text[] <> '{}'::jsonb
         OR COALESCE(jsonb_typeof(v_event -> 'entry_key'), 'missing') <> 'string'
         OR char_length(v_event ->> 'entry_key') NOT BETWEEN 1 AND 240
         OR (v_event ->> 'entry_key') ~ E'[\n\r]'
         OR COALESCE(jsonb_typeof(v_event -> 'request_key'), 'missing') <> 'string'
         OR char_length(v_event ->> 'request_key') NOT BETWEEN 1 AND 200
         OR (v_event ->> 'request_key') ~ E'[\n\r]'
         OR COALESCE(jsonb_typeof(v_event -> 'request_kind'), 'missing') <> 'string'
         OR (v_event ->> 'request_kind') NOT IN ('question', 'confirmation', 'config_proposal')
         OR COALESCE(jsonb_typeof(v_event -> 'content'), 'missing') <> 'string'
         OR char_length(v_event ->> 'content') > 300
         OR COALESCE(jsonb_typeof(v_event -> 'expires_at'), 'missing') <> 'string'
         OR COALESCE(jsonb_typeof(v_decision), 'missing') <> 'object'
         OR v_decision - ARRAY[
           'request_id','kind','name','title','detail','status','answer',
           'decided_by_id','decided_by_name','decided_at','expires_at','proposal'
         ]::text[] <> '{}'::jsonb
         OR NOT (v_decision ?& ARRAY[
           'request_id','kind','name','title','detail','status','answer',
           'decided_by_id','decided_by_name','decided_at','expires_at'
         ])
         OR v_decision ->> 'request_id' IS DISTINCT FROM v_event ->> 'request_key'
         OR (v_decision ->> 'kind') NOT IN ('shell', 'file', 'question', 'config')
         OR ((v_event ->> 'request_kind' = 'question') IS DISTINCT FROM
             (v_decision ->> 'kind' = 'question'))
         -- A config proposal is exactly the config kind and carries the same bounded payload on the
         -- event and on the projected card. Every other kind carries no proposal at all: an absent
         -- key and an explicit JSON null both count as none, because the card shape always has the
         -- field.
         OR ((v_event ->> 'request_kind' = 'config_proposal') IS DISTINCT FROM
             (v_decision ->> 'kind' = 'config'))
         OR (CASE WHEN v_event ->> 'request_kind' = 'config_proposal'
               THEN jsonb_typeof(v_event -> 'proposal') IS DISTINCT FROM 'object'
                 OR (v_decision -> 'proposal') IS DISTINCT FROM (v_event -> 'proposal')
               ELSE COALESCE(jsonb_typeof(v_event -> 'proposal'), 'null') <> 'null'
                 OR COALESCE(jsonb_typeof(v_decision -> 'proposal'), 'null') <> 'null'
             END)
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
      v_proposal := v_event -> 'proposal';
      IF v_proposal = 'null'::jsonb THEN
        v_proposal := NULL;
      END IF;
      IF v_request_kind::text = 'config_proposal' THEN
        IF v_proposal IS NULL
           OR jsonb_typeof(v_proposal) <> 'object'
           OR octet_length(v_proposal::text) > 16384 THEN
          RAISE EXCEPTION 'invalid Companion config proposal' USING ERRCODE = '22023';
        END IF;
      ELSIF v_proposal IS NOT NULL THEN
        RAISE EXCEPTION 'invalid Companion config proposal' USING ERRCODE = '22023';
      END IF;
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
        ),
        'proposal', v_proposal
      );
      INSERT INTO public.companion_decision_deliveries(
        org_id, companion_id, turn_id, attempt_id, request_key, request_kind, expires_at, proposal
      ) VALUES (
        p_org_id, p_companion_id, v_attempt.turn_id, p_work_id,
        v_request_key, v_request_kind, v_expires_at, v_proposal
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
          AND delivery.request_kind = v_request_kind
          AND delivery.proposal IS NOT DISTINCT FROM v_proposal;
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

CREATE OR REPLACE FUNCTION public.companion_api_answer_decision(
  p_org_id uuid,
  p_companion_id uuid,
  p_request_key text,
  p_action text,
  p_answer text
)
RETURNS TABLE (
  delivery_id uuid,
  turn_id uuid,
  decision_status public.companion_decision_status,
  delivery_state public.companion_decision_delivery_state,
  responded_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_actor_name text;
  v_delivery public.companion_decision_deliveries%ROWTYPE;
  v_status public.companion_decision_status;
  v_response text;
  v_event_id text;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 1 AND 200
     OR p_request_key ~ E'[\n\r]' OR p_action NOT IN ('allow', 'deny', 'answer') THEN
    RAISE EXCEPTION 'invalid Companion decision response' USING ERRCODE = '22023';
  END IF;
  SELECT delivery.* INTO v_delivery
  FROM public.companion_decision_deliveries delivery
  JOIN public.companion_turn_attempts attempt
    ON attempt.org_id = delivery.org_id
   AND attempt.companion_id = delivery.companion_id
   AND attempt.id = delivery.attempt_id
  WHERE delivery.org_id = p_org_id
    AND delivery.companion_id = p_companion_id
    AND delivery.request_key = p_request_key
    AND delivery.decision_status = 'pending'
    AND attempt.status = 'needs_input'
  ORDER BY delivery.created_at DESC, delivery.id DESC
  LIMIT 1
  FOR UPDATE OF delivery;

  IF FOUND AND v_delivery.request_kind::text = 'config_proposal' THEN
    RAISE EXCEPTION 'Companion config proposals cannot be answered here' USING ERRCODE = '22023';
  END IF;

  IF NOT FOUND THEN
    -- A browser replay of the same durable answer is idempotent; a conflicting second answer is not.
    SELECT delivery.* INTO v_delivery
    FROM public.companion_decision_deliveries delivery
    WHERE delivery.org_id = p_org_id
      AND delivery.companion_id = p_companion_id
      AND delivery.request_key = p_request_key
      AND delivery.actor_id = v_actor_id
    ORDER BY delivery.created_at DESC, delivery.id DESC
    LIMIT 1;
    IF FOUND AND v_delivery.request_kind::text = 'config_proposal' THEN
      RAISE EXCEPTION 'Companion config proposals cannot be answered here' USING ERRCODE = '22023';
    END IF;
    IF NOT FOUND OR NOT (
      (p_action = 'allow' AND v_delivery.decision_status = 'allowed')
      OR (p_action = 'deny' AND v_delivery.decision_status = 'denied')
      OR (
        p_action = 'answer'
        AND v_delivery.decision_status = 'answered'
        AND v_delivery.response_text = btrim(p_answer)
      )
    ) THEN
      RAISE EXCEPTION 'Companion decision is not pending' USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT v_delivery.id, v_delivery.turn_id, v_delivery.decision_status,
      v_delivery.delivery_state, v_delivery.responded_at;
    RETURN;
  END IF;

  IF (v_delivery.request_kind = 'question' AND p_action = 'allow')
     OR (v_delivery.request_kind = 'confirmation' AND p_action = 'answer') THEN
    RAISE EXCEPTION 'decision action does not match request kind' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'answer' AND (
    p_answer IS NULL OR char_length(btrim(p_answer)) NOT BETWEEN 1 AND 8000
  ) THEN
    RAISE EXCEPTION 'invalid Companion decision answer' USING ERRCODE = '22023';
  END IF;
  IF p_action <> 'answer' AND p_answer IS NOT NULL THEN
    RAISE EXCEPTION 'only an answer action may carry response text' USING ERRCODE = '22023';
  END IF;
  IF v_delivery.expires_at <= v_now THEN
    RAISE EXCEPTION 'Companion decision has expired' USING ERRCODE = '55000';
  END IF;

  v_status := CASE p_action
    WHEN 'allow' THEN 'allowed'::public.companion_decision_status
    WHEN 'deny' THEN 'denied'::public.companion_decision_status
    ELSE 'answered'::public.companion_decision_status
  END;
  v_response := CASE WHEN p_action = 'answer' THEN btrim(p_answer) ELSE NULL END;
  UPDATE public.companion_decision_deliveries delivery
  SET decision_status = v_status,
      actor_id = v_actor_id,
      response_text = v_response,
      responded_at = v_now,
      updated_at = v_now
  WHERE delivery.id = v_delivery.id
    AND delivery.org_id = p_org_id
    AND delivery.companion_id = p_companion_id
    AND delivery.decision_status = 'pending'
  RETURNING delivery.* INTO v_delivery;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion decision changed concurrently' USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(profile.name, app_user.name, app_user.email)
  INTO v_actor_name
  FROM public."user" app_user
  LEFT JOIN public.profiles profile ON profile.id = app_user.id
  WHERE app_user.id = v_actor_id;
  SELECT entry.event_id INTO v_event_id
  FROM public.companion_transcript_entries entry
  WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
    AND entry.role = 'decision'
    AND entry.decision ->> 'request_id' = p_request_key
    AND entry.decision ->> 'status' = 'pending'
  ORDER BY entry.ordinal DESC
  LIMIT 1
  FOR UPDATE;
  IF v_event_id IS NULL THEN
    RAISE EXCEPTION 'Companion decision transcript projection is missing' USING ERRCODE = '55000';
  END IF;
  UPDATE public.companion_transcript_entries entry
  SET decision = entry.decision || jsonb_build_object(
    'status', v_status,
    'answer', v_response,
    'decided_by_id', v_actor_id,
    'decided_by_name', v_actor_name,
    'decided_at', to_char(
      v_now AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  )
  WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
    AND entry.event_id = v_event_id;

  RETURN QUERY SELECT v_delivery.id, v_delivery.turn_id, v_delivery.decision_status,
    v_delivery.delivery_state, v_delivery.responded_at;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_get_material(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_project_event_batch(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid,
  bigint, text, jsonb, bigint, timestamp with time zone, integer, integer, integer
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_answer_decision(uuid,uuid,text,text,text) FROM PUBLIC;

