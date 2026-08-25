-- Phase 2.1 direct transport (read path): let the runtime executor read the hosted Box agent
-- endpoint registered by staging (0124) on the claim path. companion_runtime_get_material gains
-- box_id plus the three agent endpoint columns so a claim can rebuild the direct event channel
-- after a process restart. Adding output columns changes the function's return type, so the
-- previous definition is dropped rather than replaced (latest-wins convention; body copied from
-- 0111 with only the agent additions — the argument list is unchanged, so every stored signature
-- literal stays valid). Grants are re-applied below because DROP discards them.
DROP FUNCTION public.companion_runtime_get_material(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer
);
--> statement-breakpoint
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
  attachments jsonb,
  credential_snapshot_matches boolean,
  box_id text,
  agent_hosted_url text,
  agent_token_ciphertext text,
  agent_observed_at timestamp with time zone
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
  v_agent_hosted_url text;
  v_agent_token_ciphertext text;
  v_agent_observed_at timestamp with time zone;
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
        WHEN delivery.request_kind::text IN ('confirmation', 'config_proposal', 'routine_proposal', 'trigger_proposal')
             AND delivery.decision_status = 'allowed' THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key, 'confirmed', true
          )
        WHEN delivery.request_kind::text IN ('confirmation', 'config_proposal', 'routine_proposal', 'trigger_proposal')
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

  -- Phase 2 direct-transport read path: expose the registered hosted agent endpoint under the
  -- same fenced authorization proof as the material itself. Read-only exposure: freshness
  -- (agent_observed_at) is judged by the runtime before any direct call, and the token ciphertext
  -- stays opaque here — only apps/runtime holds the master key.
  SELECT instance.agent_hosted_url, instance.agent_token_ciphertext, instance.agent_observed_at
  INTO v_agent_hosted_url, v_agent_token_ciphertext, v_agent_observed_at
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id
    AND instance.companion_id = p_companion_id;

  RETURN QUERY SELECT
    v_turn_id, v_visible_attempt_id, v_message_event_id, v_prompt_text,
    v_request_kind, v_response_payload,
    v_provider_material, v_skill_material, v_mcp_material, NULL::jsonb,
    v_has_visible_output, v_attachments, v_credential_snapshot_matches,
    v_authorization.box_id, v_agent_hosted_url, v_agent_token_ciphertext, v_agent_observed_at;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_get_material(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer
) FROM PUBLIC;
--> statement-breakpoint

-- Mirror the runtime executor already trusted by the fenced material snapshot writer (0124),
-- exactly as 0124 mirrored from this function before it was dropped above. The migration never
-- grants the function to API/worker roles and fails closed if the split-role ACL is ambiguous.
DO $companion_agent_endpoint_read_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure(
    'public.companion_runtime_record_material_snapshot(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,public.companion_client_surface,'
    || 'timestamp with time zone,text,text)'
  );
  v_grantees oid[];
  v_role name;
BEGIN
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Companion runtime material snapshot surface is missing' USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT acl.grantee), ARRAY[]::oid[])
  INTO v_grantees
  FROM pg_catalog.pg_proc source_proc
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
  ) acl
  WHERE source_proc.oid = v_source
    AND acl.privilege_type = 'EXECUTE'
    AND acl.grantee <> source_proc.proowner
    AND acl.grantee <> 0;
  IF cardinality(v_grantees) = 0 THEN RETURN; END IF;
  IF cardinality(v_grantees) > 1 THEN
    RAISE EXCEPTION 'Companion runtime ACL must name exactly one executor' USING ERRCODE = '55000';
  END IF;
  SELECT executor_role.rolname INTO STRICT v_role
  FROM pg_catalog.pg_roles executor_role WHERE executor_role.oid = v_grantees[1];
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_get_material('
    || 'uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) TO %I',
    v_role
  );
END
$companion_agent_endpoint_read_acl$;
