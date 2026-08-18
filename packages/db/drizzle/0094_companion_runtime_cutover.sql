-- Final Runtime v2 cutover. This migration is intentionally fail-closed: it removes the legacy
-- executor schema only after the one-shot provider purge and every migration-first compatibility
-- fence are demonstrably quiescent. No DROP uses CASCADE.

-- The migration runner first checkpoints through additive migration 0093 and executes the exact
-- role-grant block on this physical connection. That block writes a random nonce and this
-- backend/role-bound marker
-- only after every role, object and ACL validation succeeds. Keep this guard as the first statement:
-- a standalone replay, a connection-pool hop, or a copied/spoof marker must precede no cutover DDL.
DO $runtime_v2_cutover_grants_guard$
DECLARE
  v_nonce text := nullif(current_setting('companion.runtime_grants_nonce', true), '');
  v_verified text := nullif(current_setting('companion.runtime_grants_verified', true), '');
  v_api_role text := nullif(current_setting('companion.api_role', true), '');
  v_worker_role text := nullif(current_setting('companion.worker_role', true), '');
  v_runtime_role text := nullif(
    current_setting('companion.companion_runtime_role', true), ''
  );
  v_retired_role text := nullif(
    current_setting('companion.retired_runtime_role', true), ''
  );
  v_expected text;
BEGIN
  IF v_nonce IS NULL OR v_nonce !~ '^[0-9a-f]{32}$'
     OR v_api_role IS NULL OR v_worker_role IS NULL OR v_runtime_role IS NULL THEN
    RAISE EXCEPTION 'Runtime v2 final cutover grants were not verified on this connection'
      USING ERRCODE = '55000',
            HINT = 'Run the two-phase API migration entrypoint with all three active role names.';
  END IF;

  v_expected := 'v1:' || md5(concat_ws(
    chr(31),
    v_nonce,
    current_database(),
    current_user,
    pg_backend_pid()::text,
    v_api_role,
    v_worker_role,
    v_runtime_role,
    coalesce(v_retired_role, '')
  ));
  IF v_verified IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Runtime v2 final cutover grants were not verified on this connection'
      USING ERRCODE = '55000',
            DETAIL = 'the grant marker is missing, stale, copied, or does not match this backend and role set',
            HINT = 'Run the two-phase API migration entrypoint; do not execute migration 0094 directly.';
  END IF;

  PERFORM set_config('companion.runtime_grants_verified', 'consumed', false);
END
$runtime_v2_cutover_grants_guard$;
--> statement-breakpoint

ALTER TABLE public.companions DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_runtime_instances DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_threads DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_runtime_pools DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_reconcile_leases DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_tokens DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_legacy_purge_runs DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_legacy_purge_targets DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DO $$
DECLARE
  v_detail text;
BEGIN
  SELECT concat_ws(', ',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM public.companion_runtime_control c
      WHERE c.id = 'runtime-v2' AND c.enabled = false
    ) THEN 'runtime v2 gate is not disabled' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM public.companion_runtime_leases l
      WHERE l.claim_token IS NOT NULL
    ) THEN 'runtime v2 claims remain active' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM public.companion_legacy_purge_runs r
      WHERE r.phase <> 'database_complete'
    ) THEN 'legacy purge is not database_complete' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM public.companion_legacy_purge_targets t
      WHERE t.state NOT IN ('completed', 'absent')
    ) THEN 'legacy provider deletion target is incomplete' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.companion_runtime_pools)
      THEN 'legacy runtime pools remain' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.companion_reconcile_leases)
      THEN 'legacy reconcile leases remain' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM public.api_tokens WHERE source_type = 'companion'
    ) THEN 'legacy Companion bearer tokens remain' END,
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.companions c
      LEFT JOIN public.companion_runtime_instances i
        ON i.org_id = c.org_id AND i.companion_id = c.id
      WHERE i.companion_id IS NULL
    ) THEN 'a Companion has no Runtime v2 instance' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM public.companion_threads t
      WHERE t.delivered_ordinal IS NOT NULL
         OR t.accepted_delivery_ordinal IS NOT NULL
         OR t.timeout_recovery_ordinal IS NOT NULL
         OR t.timeout_restart_ordinal IS NOT NULL
         OR t.timeout_delivery_ordinal IS NOT NULL
         OR t.pi_log_offset <> 0
    ) THEN 'legacy thread delivery watermarks are not neutral' END
  ) INTO v_detail;

  IF v_detail <> '' THEN
    RAISE EXCEPTION 'Runtime v2 final cutover preflight failed'
      USING ERRCODE = '55000', DETAIL = v_detail,
            HINT = 'Disable Companions, complete the legacy purge, and drain old API/worker replicas.';
  END IF;
END
$$;
--> statement-breakpoint

-- Recreate the two API functions that still mentioned projection columns owned by the old API
-- executor. Their signatures, privileges, ownership and durable behavior remain unchanged.
CREATE OR REPLACE FUNCTION public.companion_api_update_companion(
  p_org_id uuid,
  p_companion_id uuid,
  p_patch jsonb
)
RETURNS TABLE (
  companion_id uuid,
  desired_settings_revision bigint,
  skills_revision integer,
  settings_changed boolean,
  skills_changed boolean,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_companion public.companions%ROWTYPE;
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_name text;
  v_persona text;
  v_provider_id text;
  v_model_id text;
  v_selected_skill_ids jsonb;
  v_can_write_skills boolean;
  v_selected_mcp_account_ids jsonb;
  v_settings_changed boolean;
  v_skills_changed boolean;
  v_updated_at timestamp with time zone := clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_patch) patch_key
       WHERE patch_key NOT IN (
         'name', 'persona', 'provider_id', 'model_id', 'selected_skill_ids',
         'can_write_skills', 'selected_mcp_account_ids'
       )
     ) THEN
    RAISE EXCEPTION 'invalid Companion settings patch' USING ERRCODE = '22023';
  END IF;

  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;
  IF v_instance.retirement_state <> 'active' THEN
    RAISE EXCEPTION 'retired Companion settings cannot change' USING ERRCODE = '55000';
  END IF;
  SELECT companion.* INTO STRICT v_companion
  FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
  FOR UPDATE;

  IF p_patch ? 'name' AND (
    jsonb_typeof(p_patch -> 'name') <> 'string'
    OR char_length(btrim(p_patch ->> 'name')) NOT BETWEEN 1 AND 120
  ) THEN
    RAISE EXCEPTION 'invalid Companion name' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'persona' AND NOT (
    jsonb_typeof(p_patch -> 'persona') = 'null'
    OR jsonb_typeof(p_patch -> 'persona') = 'string'
      AND char_length(p_patch ->> 'persona') <= 280
  ) THEN
    RAISE EXCEPTION 'invalid Companion persona' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'provider_id' AND (
    jsonb_typeof(p_patch -> 'provider_id') <> 'string'
    OR (p_patch ->> 'provider_id') !~ '^[a-z][a-z0-9-]{0,62}$'
  ) THEN
    RAISE EXCEPTION 'invalid Companion provider' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'model_id' AND (
    jsonb_typeof(p_patch -> 'model_id') <> 'string'
    OR char_length(p_patch ->> 'model_id') NOT BETWEEN 1 AND 200
    OR (p_patch ->> 'model_id') ~ E'[\n\r]'
  ) THEN
    RAISE EXCEPTION 'invalid Companion model' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'selected_skill_ids'
     AND jsonb_typeof(p_patch -> 'selected_skill_ids') <> 'array' THEN
    RAISE EXCEPTION 'invalid Companion Skill selection' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'selected_mcp_account_ids'
     AND jsonb_typeof(p_patch -> 'selected_mcp_account_ids') <> 'array' THEN
    RAISE EXCEPTION 'invalid Companion MCP selection' USING ERRCODE = '22023';
  END IF;
  IF p_patch ? 'can_write_skills'
     AND jsonb_typeof(p_patch -> 'can_write_skills') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid Companion Skills write setting' USING ERRCODE = '22023';
  END IF;

  v_name := CASE WHEN p_patch ? 'name' THEN btrim(p_patch ->> 'name') ELSE v_companion.name END;
  v_persona := CASE WHEN p_patch ? 'persona'
    THEN NULLIF(btrim(p_patch ->> 'persona'), '') ELSE v_companion.persona END;
  v_provider_id := CASE WHEN p_patch ? 'provider_id'
    THEN p_patch ->> 'provider_id' ELSE v_companion.provider_ids ->> 0 END;
  v_model_id := CASE WHEN p_patch ? 'model_id'
    THEN p_patch ->> 'model_id' ELSE v_companion.model_id END;
  v_selected_skill_ids := CASE WHEN p_patch ? 'selected_skill_ids'
    THEN p_patch -> 'selected_skill_ids' ELSE v_companion.selected_skill_ids END;
  v_can_write_skills := CASE WHEN p_patch ? 'can_write_skills'
    THEN (p_patch ->> 'can_write_skills')::boolean ELSE v_companion.can_write_skills END;
  v_selected_mcp_account_ids := CASE WHEN p_patch ? 'selected_mcp_account_ids'
    THEN p_patch -> 'selected_mcp_account_ids' ELSE v_companion.selected_mcp_account_ids END;

  IF v_provider_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.companion_provider_connections connection
    WHERE connection.org_id = p_org_id AND connection.provider_id = v_provider_id
  ) THEN
    RAISE EXCEPTION 'Companion provider is not connected' USING ERRCODE = '22023';
  END IF;
  PERFORM public.companion_api_validate_resource_selection(
    p_org_id, v_selected_skill_ids, v_companion.selected_skill_ids,
    v_selected_mcp_account_ids, v_companion.selected_mcp_account_ids
  );

  v_skills_changed := v_selected_skill_ids IS DISTINCT FROM v_companion.selected_skill_ids;
  v_settings_changed := v_persona IS DISTINCT FROM v_companion.persona
    OR v_provider_id IS DISTINCT FROM v_companion.provider_ids ->> 0
    OR v_model_id IS DISTINCT FROM v_companion.model_id
    OR v_skills_changed
    OR v_can_write_skills IS DISTINCT FROM v_companion.can_write_skills
    OR v_selected_mcp_account_ids IS DISTINCT FROM v_companion.selected_mcp_account_ids;

  UPDATE public.companions companion
  SET name = v_name,
      persona = v_persona,
      provider_ids = CASE WHEN v_provider_id IS NULL
        THEN '[]'::jsonb ELSE jsonb_build_array(v_provider_id) END,
      model_id = v_model_id,
      selected_skill_ids = v_selected_skill_ids,
      can_write_skills = v_can_write_skills,
      selected_mcp_account_ids = v_selected_mcp_account_ids,
      skills_revision = companion.skills_revision + CASE WHEN v_skills_changed THEN 1 ELSE 0 END,
      updated_at = v_updated_at
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
  RETURNING companion.skills_revision INTO v_companion.skills_revision;

  UPDATE public.companion_runtime_instances instance
  SET desired_settings_revision = instance.desired_settings_revision
        + CASE WHEN v_settings_changed THEN 1 ELSE 0 END,
      settings_actor_id = CASE WHEN v_settings_changed THEN v_actor_id ELSE instance.settings_actor_id END,
      settings_checkpoint = CASE WHEN v_settings_changed THEN 'pending' ELSE instance.settings_checkpoint END,
      settings_available_at = CASE WHEN v_settings_changed THEN v_updated_at ELSE instance.settings_available_at END,
      last_error_code = CASE WHEN v_settings_changed THEN NULL ELSE instance.last_error_code END,
      last_error_message = CASE WHEN v_settings_changed THEN NULL ELSE instance.last_error_message END,
      last_error_action = CASE WHEN v_settings_changed THEN NULL ELSE instance.last_error_action END,
      updated_at = v_updated_at
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  RETURNING instance.desired_settings_revision INTO v_instance.desired_settings_revision;

  INSERT INTO public.audit_log(
    org_id, actor_id, action, target_type, target_id, metadata
  ) VALUES (
    p_org_id, v_actor_id, 'companion.settings.updated', 'companion', p_companion_id::text,
    jsonb_build_object(
      'name', p_patch ? 'name',
      'persona', p_patch ? 'persona',
      'provider', p_patch ? 'provider_id',
      'model', p_patch ? 'model_id' OR p_patch ? 'provider_id',
      'selected_skills', p_patch ? 'selected_skill_ids',
      'can_write_skills', p_patch ? 'can_write_skills',
      'selected_mcp_accounts', p_patch ? 'selected_mcp_account_ids'
    )
  );

  RETURN QUERY SELECT p_companion_id, v_instance.desired_settings_revision,
    v_companion.skills_revision, v_settings_changed, v_skills_changed, v_updated_at;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_bump_skill_revision(
  p_org_id uuid,
  p_skill_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_count integer := 0;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_skill_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.skills skill
    WHERE skill.org_id = p_org_id AND skill.id = p_skill_id
      AND (skill.scope = 'org' OR skill.creator_id = v_actor_id)
  ) THEN
    RAISE EXCEPTION 'Skill not found' USING ERRCODE = 'P0002';
  END IF;

  WITH targets AS MATERIALIZED (
    SELECT companion.id
    FROM public.companions companion
    WHERE companion.org_id = p_org_id
      AND companion.selected_skill_ids @> jsonb_build_array(p_skill_id::text)
  ), marked AS (
    UPDATE public.companion_runtime_instances instance
    SET settings_checkpoint = 'pending',
        settings_available_at = v_now,
        last_error_code = NULL,
        last_error_message = NULL,
        last_error_action = NULL,
        updated_at = v_now
    WHERE instance.org_id = p_org_id
      AND instance.companion_id IN (SELECT targets.id FROM targets)
    RETURNING instance.companion_id
  ), bumped AS (
    UPDATE public.companions companion
    SET skills_revision = companion.skills_revision + 1,
        updated_at = v_now
    WHERE companion.org_id = p_org_id
      AND companion.id IN (SELECT marked.companion_id FROM marked)
    RETURNING companion.id
  )
  SELECT count(*)::integer INTO v_count FROM bumped;
  RETURN v_count;
END
$$;
--> statement-breakpoint

-- Pi bearer tokens are permanently unsupported in Runtime v2. Install the data constraint before
-- removing the migration-era trigger that fenced old replicas.
ALTER TABLE public.api_tokens DROP CONSTRAINT api_tokens_source_provenance_check;
--> statement-breakpoint
ALTER TABLE public.api_tokens
  ADD CONSTRAINT api_tokens_source_provenance_check
  CHECK (
    (source_type = 'human' AND source_agent_id IS NULL AND target_workspace_id IS NULL)
    OR (source_type = 'agent_auth' AND source_agent_id IS NOT NULL)
  );
--> statement-breakpoint
DROP TRIGGER api_tokens_companion_runtime_v2_mutation_fence ON public.api_tokens;
--> statement-breakpoint
DROP FUNCTION public.companion_runtime_fence_legacy_token();
--> statement-breakpoint

-- Remove the restrictive transcript policy first: PostgreSQL otherwise correctly refuses to drop
-- its predicate function. Compatibility owner policies are no longer required either.
DROP POLICY companion_transcript_entries_delivery_fence_rls
  ON public.companion_transcript_entries;
--> statement-breakpoint
DROP POLICY companion_threads_delivery_compat_maintenance_rls
  ON public.companion_threads;
--> statement-breakpoint
DROP POLICY companion_transcript_entries_delivery_compat_maintenance_rls
  ON public.companion_transcript_entries;
--> statement-breakpoint
DROP POLICY companion_transcript_entries_timeout_maintenance_rls
  ON public.companion_transcript_entries;
--> statement-breakpoint
DROP POLICY companion_threads_timeout_maintenance_rls
  ON public.companion_threads;
--> statement-breakpoint
DROP POLICY companion_reconcile_leases_maintenance_rls
  ON public.companion_reconcile_leases;
--> statement-breakpoint

-- Remove the one-shot finalizer's FORCE-RLS capabilities from every retained table before the
-- function itself disappears. The purge ledger gets a new owner-only read policy below.
DROP POLICY companion_legacy_purge_runs_maintenance_rls
  ON public.companion_legacy_purge_runs;
--> statement-breakpoint
DROP POLICY companion_legacy_purge_targets_maintenance_rls
  ON public.companion_legacy_purge_targets;
--> statement-breakpoint
DROP POLICY companions_legacy_purge_maintenance_rls ON public.companions;
--> statement-breakpoint
DROP POLICY companion_runtime_pools_legacy_purge_maintenance_rls
  ON public.companion_runtime_pools;
--> statement-breakpoint
DROP POLICY companion_workspace_access_legacy_purge_maintenance_rls
  ON public.companion_workspace_access;
--> statement-breakpoint
DROP POLICY companion_member_state_legacy_purge_maintenance_rls
  ON public.companion_member_state;
--> statement-breakpoint
DROP POLICY companion_threads_legacy_purge_maintenance_rls
  ON public.companion_threads;
--> statement-breakpoint
DROP POLICY companion_transcript_entries_legacy_purge_maintenance_rls
  ON public.companion_transcript_entries;
--> statement-breakpoint
DROP POLICY companion_reconcile_leases_legacy_purge_maintenance_rls
  ON public.companion_reconcile_leases;
--> statement-breakpoint
DROP POLICY api_tokens_legacy_companion_purge_maintenance_rls
  ON public.api_tokens;
--> statement-breakpoint

CREATE POLICY companion_legacy_purge_runs_owner_read_rls
  ON public.companion_legacy_purge_runs FOR SELECT
  USING (
    current_user = pg_get_userbyid((
      SELECT relation.relowner FROM pg_class relation
      WHERE relation.oid = 'public.companion_legacy_purge_runs'::regclass
    ))
  );
--> statement-breakpoint
CREATE POLICY companion_legacy_purge_targets_owner_read_rls
  ON public.companion_legacy_purge_targets FOR SELECT
  USING (
    current_user = pg_get_userbyid((
      SELECT relation.relowner FROM pg_class relation
      WHERE relation.oid = 'public.companion_legacy_purge_targets'::regclass
    ))
  );
--> statement-breakpoint

DROP TRIGGER companion_reconcile_leases_delivery_compat_claim_guard
  ON public.companion_reconcile_leases;
--> statement-breakpoint
DROP FUNCTION public.companion_accept_delivery_lease(uuid,uuid,uuid,integer,integer);
--> statement-breakpoint
DROP FUNCTION public.companion_claim_delivery_lease(uuid,uuid,uuid,integer);
--> statement-breakpoint
DROP FUNCTION public.companion_release_delivery_lease(uuid,uuid,uuid);
--> statement-breakpoint
DROP FUNCTION public.companion_renew_delivery_lease(uuid,uuid,uuid,integer);
--> statement-breakpoint
DROP FUNCTION public.companion_refresh_delivery_compat_backfill(integer);
--> statement-breakpoint
DROP FUNCTION public.companion_delivery_read_fence(uuid,uuid,text);
--> statement-breakpoint
DROP FUNCTION public.companion_delivery_compat_deadline(uuid,uuid,timestamp with time zone);
--> statement-breakpoint
DROP FUNCTION public.companion_block_delivery_compat_claim();
--> statement-breakpoint
DROP FUNCTION public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone,integer,integer);
--> statement-breakpoint
DROP FUNCTION public.companion_claim_reconcile_candidates(text,integer,integer,integer,integer);
--> statement-breakpoint
DROP FUNCTION public.companion_settle_reconcile_lease(uuid,uuid,text,text,integer);
--> statement-breakpoint

-- The ledger remains as immutable cutover evidence, but its mutating finalizer cannot outlive the
-- tables it used to empty. All future Companion deletion is operation/lease driven.
DROP FUNCTION public.companion_finalize_legacy_purge();
--> statement-breakpoint
DROP TABLE public.companion_reconcile_leases;
--> statement-breakpoint
DROP TABLE public.companion_runtime_pools;
--> statement-breakpoint

ALTER TABLE public.companion_threads
  DROP COLUMN delivered_ordinal,
  DROP COLUMN accepted_delivery_ordinal,
  DROP COLUMN timeout_recovery_ordinal,
  DROP COLUMN timeout_restart_ordinal,
  DROP COLUMN timeout_delivery_ordinal,
  DROP COLUMN pi_log_offset;
--> statement-breakpoint

ALTER TABLE public.companions
  DROP COLUMN box_id,
  DROP COLUMN runtime_state,
  DROP COLUMN daemon_state,
  DROP COLUMN provider_credential_generation,
  DROP COLUMN skills_applied_revision,
  DROP COLUMN skills_applied_at,
  DROP COLUMN skills_last_error,
  DROP COLUMN disk_layout_version,
  DROP COLUMN desktop_available,
  DROP COLUMN last_error,
  DROP COLUMN last_observed_at,
  DROP COLUMN last_started_at,
  DROP COLUMN last_stopped_at;
--> statement-breakpoint

DROP TYPE public.companion_runtime_pool_scope;
--> statement-breakpoint
DROP TYPE public.companion_runtime_state;
--> statement-breakpoint
DROP TYPE public.companion_daemon_state;
--> statement-breakpoint

ALTER TABLE public.companions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_runtime_instances ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_runtime_instances FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_threads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_threads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_legacy_purge_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_legacy_purge_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_legacy_purge_targets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_legacy_purge_targets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

COMMENT ON TABLE public.companions IS
  'Runtime v2 Companion settings root; observed Box/Pi state lives only in companion_runtime_instances.';
--> statement-breakpoint
COMMENT ON TABLE public.companion_threads IS
  'One durable transcript sequence per Companion; delivery and event cursors live in Runtime v2 turns/attempts.';
