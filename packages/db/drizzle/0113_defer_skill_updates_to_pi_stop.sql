ALTER TABLE public.companions
  ADD COLUMN skills_available_revision integer;
--> statement-breakpoint
UPDATE public.companions
SET skills_available_revision = skills_revision;
--> statement-breakpoint
ALTER TABLE public.companions
  ALTER COLUMN skills_available_revision SET DEFAULT 1,
  ALTER COLUMN skills_available_revision SET NOT NULL,
  DROP CONSTRAINT IF EXISTS companions_skills_revision_check,
  ADD CONSTRAINT companions_skills_revision_check CHECK (
    skills_revision >= 1 AND skills_available_revision >= skills_revision
  );
--> statement-breakpoint

ALTER TABLE public.companion_runtime_instances
  ADD COLUMN applied_selected_skill_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN applied_skill_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN applied_skills_digest text,
  ADD COLUMN skills_update_error_code text,
  ADD COLUMN skills_update_error_message text;
--> statement-breakpoint
ALTER TABLE public.companion_runtime_instances
  DROP CONSTRAINT companion_runtime_instances_revision_check,
  ADD CONSTRAINT companion_runtime_instances_revision_check CHECK (
    generation BETWEEN 1 AND 2147483647
    AND disk_layout_version >= 0
    AND desired_settings_revision >= 1
    AND applied_settings_revision >= 0
    AND applied_settings_revision <= desired_settings_revision
    AND applied_skills_revision >= 0
    AND ((applied_settings_revision = 0) = (applied_client_surface IS NULL))
    AND jsonb_typeof(applied_selected_skill_ids) = 'array'
    AND jsonb_typeof(applied_skill_refs) = 'array'
    AND (applied_skills_digest IS NULL OR applied_skills_digest ~ '^[0-9a-f]{64}$')
    AND ((skills_update_error_code IS NULL) = (skills_update_error_message IS NULL))
    AND (skills_update_error_code IS NULL OR skills_update_error_code ~ '^[a-z][a-z0-9_]{0,63}$')
    AND (skills_update_error_message IS NULL OR (
      char_length(skills_update_error_message) <= 500
      AND skills_update_error_message !~ E'[\n\r]'
    ))
    AND next_turn_sequence >= 1
    AND next_operation_sequence >= 1
    AND last_write_epoch >= 0
  );
--> statement-breakpoint

ALTER TABLE public.companion_operations
  ADD COLUMN skill_update_selected_skill_ids jsonb,
  ADD COLUMN skill_update_refs jsonb;
--> statement-breakpoint
UPDATE public.companion_operations
SET skill_update_selected_skill_ids = selected_skill_ids,
    skill_update_refs = skill_refs,
    selected_skill_ids = CASE WHEN kind = 'stop' THEN NULL ELSE selected_skill_ids END,
    skill_refs = CASE WHEN kind = 'stop' THEN NULL ELSE skill_refs END
WHERE kind IN ('stop', 'restart_pi', 'restart_box', 'apply_settings');
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_keep_available_skill_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.skills_revision > OLD.skills_revision THEN
    NEW.skills_available_revision := GREATEST(NEW.skills_available_revision, NEW.skills_revision);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER companion_keep_available_skill_revision
  BEFORE UPDATE OF skills_revision ON public.companions
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_keep_available_skill_revision();
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
BEGIN
  IF p_skill_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.skills skill
    WHERE skill.org_id = p_org_id AND skill.id = p_skill_id
      AND (skill.scope = 'org' OR skill.creator_id = v_actor_id)
  ) THEN
    RAISE EXCEPTION 'Skill not found' USING ERRCODE = 'P0002';
  END IF;

  WITH targets AS MATERIALIZED (
    SELECT companion.id FROM public.companions companion
    WHERE companion.org_id = p_org_id
      AND companion.selected_skill_ids @> jsonb_build_array(p_skill_id::text)
  ), cleared AS (
    UPDATE public.companion_runtime_instances instance
    SET skills_update_error_code = NULL, skills_update_error_message = NULL,
        updated_at = clock_timestamp()
    WHERE instance.org_id = p_org_id
      AND instance.companion_id IN (SELECT targets.id FROM targets)
  )
  UPDATE public.companions companion
  SET skills_available_revision = companion.skills_available_revision + 1,
      updated_at = clock_timestamp()
  WHERE companion.org_id = p_org_id AND companion.id IN (SELECT targets.id FROM targets);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_require_skill_revision(
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
  ) THEN RAISE EXCEPTION 'Skill not found' USING ERRCODE = 'P0002'; END IF;

  WITH targets AS MATERIALIZED (
    SELECT companion.id FROM public.companions companion
    WHERE companion.org_id = p_org_id
      AND companion.selected_skill_ids @> jsonb_build_array(p_skill_id::text)
  ), marked AS (
    UPDATE public.companion_runtime_instances instance
    SET settings_checkpoint = 'pending', settings_available_at = v_now,
        last_error_code = NULL, last_error_message = NULL, last_error_action = NULL,
        skills_update_error_code = NULL, skills_update_error_message = NULL,
        updated_at = v_now
    WHERE instance.org_id = p_org_id
      AND instance.companion_id IN (SELECT targets.id FROM targets)
    RETURNING instance.companion_id
  )
  UPDATE public.companions companion
  SET skills_revision = companion.skills_available_revision + 1,
      skills_available_revision = companion.skills_available_revision + 1,
      updated_at = v_now
  WHERE companion.org_id = p_org_id
    AND companion.id IN (SELECT marked.companion_id FROM marked);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_require_skill_revision(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
DO $skill_required_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure('public.companion_api_bump_skill_revision(uuid,uuid)');
  v_role name;
BEGIN
  FOR v_role IN
    SELECT role.rolname
    FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
    ) acl
    JOIN pg_catalog.pg_roles role ON role.oid = acl.grantee
    WHERE source_proc.oid = v_source AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> source_proc.proowner AND acl.grantee <> 0
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_require_skill_revision(uuid,uuid) TO %I', v_role);
  END LOOP;
END
$skill_required_acl$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_read_skill_sync(p_org_id uuid, p_companion_id uuid)
RETURNS TABLE (skills_available_revision integer, skills_update_error_message text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE v_access text := public.companion_api_require_access(p_org_id, p_companion_id, 'read');
BEGIN
  RETURN QUERY
  SELECT companion.skills_available_revision,
    CASE WHEN v_access = 'viewer' AND instance.skills_update_error_message IS NOT NULL
      THEN 'The Skill update needs attention.' ELSE instance.skills_update_error_message END
  FROM public.companions companion
  JOIN public.companion_runtime_instances instance
    ON instance.org_id = companion.org_id AND instance.companion_id = companion.id
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id;
END
$$;
--> statement-breakpoint
CREATE FUNCTION public.companion_api_list_skill_sync(p_org_id uuid)
RETURNS TABLE (companion_id uuid, skills_available_revision integer, skills_update_error_message text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  RETURN QUERY
  SELECT runtime.companion_id, companion.skills_available_revision,
    CASE WHEN runtime.access_role = 'viewer' AND instance.skills_update_error_message IS NOT NULL
      THEN 'The Skill update needs attention.' ELSE instance.skills_update_error_message END
  FROM public.companion_api_list_runtime(p_org_id) runtime
  JOIN public.companions companion
    ON companion.org_id = p_org_id AND companion.id = runtime.companion_id
  JOIN public.companion_runtime_instances instance
    ON instance.org_id = companion.org_id AND instance.companion_id = companion.id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_api_read_skill_sync(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_list_skill_sync(uuid) FROM PUBLIC;
--> statement-breakpoint
DO $skill_sync_projection_acl$
DECLARE v_role name;
BEGIN
  FOR v_role IN
    SELECT DISTINCT role.rolname
    FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
    ) acl
    JOIN pg_catalog.pg_roles role ON role.oid = acl.grantee
    WHERE source_proc.oid = pg_catalog.to_regprocedure('public.companion_api_read_runtime(uuid,uuid)')
      AND acl.privilege_type = 'EXECUTE' AND acl.grantee <> source_proc.proowner AND acl.grantee <> 0
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_read_skill_sync(uuid,uuid) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_list_skill_sync(uuid) TO %I', v_role);
  END LOOP;
END
$skill_sync_projection_acl$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_assign_operation_intent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_applied_revision integer;
  v_applied_ids jsonb;
  v_applied_refs jsonb;
  v_applied_digest text;
  v_required_revision integer;
  v_available_revision integer;
BEGIN
  UPDATE public.companion_runtime_instances i
  SET next_operation_sequence = i.next_operation_sequence + 1,
      updated_at = statement_timestamp()
  WHERE i.org_id = NEW.org_id AND i.companion_id = NEW.companion_id
  RETURNING i.next_operation_sequence - 1, i.next_turn_sequence - 1,
    i.applied_skills_revision, i.applied_selected_skill_ids,
    i.applied_skill_refs, i.applied_skills_digest
  INTO NEW.queue_sequence, NEW.turn_queue_cutoff, v_applied_revision,
    v_applied_ids, v_applied_refs, v_applied_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation runtime instance does not exist' USING ERRCODE = '23503';
  END IF;

  IF NEW.kind IN ('start', 'restart_pi', 'restart_box', 'apply_settings', 'stop') THEN
    IF NEW.kind <> 'stop' THEN
      SELECT COALESCE(t.client_surface, NEW.client_surface, 'web'::public.companion_client_surface)
      INTO NEW.client_surface
      FROM (SELECT 1) singleton
      LEFT JOIN public.companion_turns t
        ON t.org_id = NEW.org_id AND t.companion_id = NEW.companion_id
       AND t.id = NEW.source_turn_id;
    ELSE
      NEW.client_surface := NULL;
    END IF;

    SELECT i.desired_settings_revision, c.skills_revision, c.skills_available_revision,
           c.model_id, c.persona, c.can_write_skills,
           c.provider_ids, c.selected_skill_ids, c.selected_mcp_account_ids
    INTO NEW.target_settings_revision, v_required_revision, v_available_revision,
         NEW.model_id, NEW.persona, NEW.can_write_skills,
         NEW.provider_ids, NEW.selected_skill_ids, NEW.selected_mcp_account_ids
    FROM public.companion_runtime_instances i
    JOIN public.companions c ON c.org_id = i.org_id AND c.id = i.companion_id
    WHERE i.org_id = NEW.org_id AND i.companion_id = NEW.companion_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'operation Companion does not exist' USING ERRCODE = '23503';
    END IF;

    IF NEW.kind = 'start' AND v_applied_digest IS NOT NULL
       AND v_applied_revision >= v_required_revision THEN
      NEW.target_skills_revision := v_applied_revision;
      NEW.selected_skill_ids := v_applied_ids;
      NEW.skill_refs := v_applied_refs;
    ELSE
      NEW.target_skills_revision := CASE
        WHEN NEW.client_surface = 'native_mobile' THEN v_required_revision
        ELSE v_available_revision
      END;
    END IF;

    IF NEW.client_surface = 'native_mobile' THEN
      NEW.can_write_skills := false;
      NEW.selected_skill_ids := '[]'::jsonb;
      NEW.selected_mcp_account_ids := '[]'::jsonb;
    END IF;

    IF NEW.skill_refs IS NULL THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'skill_id', s.id,
               'current_version_id', s.current_version_id
             ) ORDER BY s.id), '[]'::jsonb)
      INTO NEW.skill_refs
      FROM public.skills s
      WHERE s.org_id = NEW.org_id
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(NEW.selected_skill_ids) selected(skill_id)
          WHERE selected.skill_id = s.id::text
        );
    END IF;

    IF NEW.kind IN ('stop', 'restart_pi', 'restart_box', 'apply_settings') THEN
      NEW.skill_update_selected_skill_ids := NEW.selected_skill_ids;
      NEW.skill_update_refs := NEW.skill_refs;
      IF NEW.kind = 'stop' THEN
        NEW.selected_skill_ids := NULL;
        NEW.skill_refs := NULL;
      ELSIF v_applied_digest IS NOT NULL AND v_applied_revision >= v_required_revision THEN
        -- Resource-bearing lifecycle work only needs provider/MCP authority when it can preserve
        -- the proven installed tree. The separate update snapshot is authorized independently.
        NEW.selected_skill_ids := '[]'::jsonb;
        NEW.skill_refs := '[]'::jsonb;
      END IF;
    ELSE
      NEW.skill_update_selected_skill_ids := NULL;
      NEW.skill_update_refs := NULL;
    END IF;

    IF NEW.kind = 'stop' THEN
      NEW.target_settings_revision := NULL;
      NEW.model_id := NULL;
      NEW.persona := NULL;
      NEW.can_write_skills := NULL;
      NEW.provider_ids := NULL;
      NEW.selected_mcp_account_ids := NULL;
    END IF;
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
    NEW.skill_update_selected_skill_ids := NULL;
    NEW.skill_update_refs := NULL;
    NEW.selected_mcp_account_ids := NULL;
  END IF;

  IF NEW.kind = 'start' AND NEW.source_turn_id IS NOT NULL THEN
    UPDATE public.companion_turns t
    SET cold_start_deadline_at = COALESCE(t.cold_start_deadline_at, t.created_at + interval '3 minutes'),
        updated_at = statement_timestamp()
    WHERE t.org_id = NEW.org_id AND t.companion_id = NEW.companion_id
      AND t.id = NEW.source_turn_id AND t.status = 'queued';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cold-start source turn must be queued' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_assign_attempt_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_client_surface public.companion_client_surface;
  v_applied_ids jsonb;
  v_applied_refs jsonb;
  v_use_applied boolean;
BEGIN
  SELECT c.persona, t.client_surface,
         i.applied_selected_skill_ids, i.applied_skill_refs,
         i.applied_skills_digest IS NOT NULL AND i.applied_skills_revision >= c.skills_revision
  INTO NEW.persona, v_client_surface, v_applied_ids, v_applied_refs, v_use_applied
  FROM public.companions c
  JOIN public.companion_turns t
    ON t.org_id = c.org_id AND t.companion_id = c.id AND t.id = NEW.turn_id
  JOIN public.companion_runtime_instances i
    ON i.org_id = c.org_id AND i.companion_id = c.id
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
    FROM public.companions c WHERE c.org_id = NEW.org_id AND c.id = NEW.companion_id;
    IF v_use_applied THEN
      NEW.selected_skill_ids := v_applied_ids;
      NEW.skill_refs := v_applied_refs;
    ELSE
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'skill_id', s.id,
               'current_version_id', s.current_version_id
             ) ORDER BY s.id), '[]'::jsonb)
      INTO NEW.skill_refs
      FROM public.skills s
      WHERE s.org_id = NEW.org_id
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(NEW.selected_skill_ids) selected(skill_id)
          WHERE selected.skill_id = s.id::text
        );
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Published versions must not turn an otherwise valid installed snapshot into a wake-time gate.
-- Rewrite the three current claim/authorization functions in place so their existing fencing,
-- priority, RLS, and grant behavior stays byte-for-byte identical outside this comparison.
DO $deferred_skill_gates$
DECLARE
  v_rule record;
  v_definition text;
  v_rewritten text;
BEGIN
  FOR v_rule IN
    SELECT * FROM (VALUES
      (
        'public.companion_runtime_prepare_queued_turn_material(bigint)',
        'queued_companion.skills_revision = instance.applied_skills_revision',
        'instance.applied_skills_revision >= queued_companion.skills_revision'
      ),
      (
        'public.companion_runtime_claim_work_without_material_guard(text,integer,integer,bigint)',
        'queue_companion.skills_revision = queue_instance.applied_skills_revision',
        'queue_instance.applied_skills_revision >= queue_companion.skills_revision'
      ),
      (
        'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)',
        'queue_companion.skills_revision = queue_instance.applied_skills_revision',
        'queue_instance.applied_skills_revision >= queue_companion.skills_revision'
      ),
      (
        'public.companion_runtime_authorize_desktop(uuid,uuid,text)',
        'v_applied_skills_revision IS DISTINCT FROM v_skills_revision',
        'v_applied_skills_revision < v_skills_revision'
      ),
      (
        'public.companion_runtime_observe_instance(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,bigint,text,public.companion_box_observed_state,public.companion_pi_observed_state,text,integer,bigint,integer,timestamp with time zone)',
        'i.applied_skills_revision, c.skills_revision, i.last_observed_at',
        'i.applied_skills_revision, c.skills_available_revision, i.last_observed_at'
      )
    ) AS rules(signature, old_gate, new_gate)
  LOOP
    v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_rule.signature));
    v_rewritten := replace(v_definition, v_rule.old_gate, v_rule.new_gate);
    IF v_rewritten = v_definition THEN
      RAISE EXCEPTION 'deferred Skill gate was not found in %', v_rule.signature;
    END IF;
    EXECUTE v_rewritten;
  END LOOP;
END
$deferred_skill_gates$;
--> statement-breakpoint

ALTER TABLE public.companion_operations
  DROP CONSTRAINT companion_operations_checkpoint_check,
  ADD CONSTRAINT companion_operations_checkpoint_check CHECK (
    checkpoint IN (
      'pending', 'resolving_box', 'box_resolved', 'box_absence_observed', 'creating_box',
      'box_created', 'waiting_ready', 'box_ready_observed', 'installing_layout',
      'starting_pi', 'pi_observed', 'pi_ready', 'stopping_pi',
      'skills_updated', 'provider_stop_requested', 'waiting_archived', 'box_archived',
      'restarting_pi', 'restarting_box', 'applying_settings', 'settings_applied',
      'provider_delete_requested', 'waiting_deleted', 'provider_deleted', 'box_absent', 'completed'
    ) AND checkpoint_sequence >= 0 AND attempt_count >= 0
  ),
  DROP CONSTRAINT companion_operations_target_revision_check,
  ADD CONSTRAINT companion_operations_target_revision_check CHECK (
    (target_settings_revision IS NULL OR target_settings_revision >= 1)
    AND (target_skills_revision IS NULL OR target_skills_revision >= 1)
    AND (
      (kind IN ('start', 'restart_pi', 'restart_box', 'apply_settings')
        AND target_settings_revision IS NOT NULL AND target_skills_revision IS NOT NULL)
      OR (kind = 'stop' AND target_settings_revision IS NULL AND target_skills_revision IS NOT NULL)
      OR (kind = 'delete' AND target_settings_revision IS NULL AND target_skills_revision IS NULL)
    )
  ),
  DROP CONSTRAINT companion_operations_resource_snapshot_check,
  ADD CONSTRAINT companion_operations_resource_snapshot_check CHECK (
    (kind = 'start'
      AND client_surface IS NOT NULL
      AND (model_id IS NULL OR (char_length(model_id) BETWEEN 1 AND 200 AND model_id !~ E'[\n\r]'))
      AND (persona IS NULL OR char_length(persona) <= 280)
      AND can_write_skills IS NOT NULL
      AND jsonb_typeof(provider_ids) = 'array'
      AND jsonb_typeof(selected_skill_ids) = 'array'
      AND jsonb_typeof(skill_refs) = 'array'
      AND skill_update_selected_skill_ids IS NULL AND skill_update_refs IS NULL
      AND jsonb_typeof(selected_mcp_account_ids) = 'array')
    OR (kind IN ('restart_pi', 'restart_box', 'apply_settings')
      AND client_surface IS NOT NULL
      AND (model_id IS NULL OR (char_length(model_id) BETWEEN 1 AND 200 AND model_id !~ E'[\n\r]'))
      AND (persona IS NULL OR char_length(persona) <= 280)
      AND can_write_skills IS NOT NULL
      AND jsonb_typeof(provider_ids) = 'array'
      AND jsonb_typeof(selected_skill_ids) = 'array'
      AND jsonb_typeof(skill_refs) = 'array'
      AND jsonb_typeof(skill_update_selected_skill_ids) = 'array'
      AND jsonb_typeof(skill_update_refs) = 'array'
      AND jsonb_typeof(selected_mcp_account_ids) = 'array')
    OR (kind = 'stop' AND client_surface IS NULL AND model_id IS NULL AND persona IS NULL
      AND can_write_skills IS NULL AND provider_ids IS NULL
      AND selected_skill_ids IS NULL AND skill_refs IS NULL
      AND jsonb_typeof(skill_update_selected_skill_ids) = 'array'
      AND jsonb_typeof(skill_update_refs) = 'array' AND selected_mcp_account_ids IS NULL)
    OR (kind = 'delete' AND client_surface IS NULL AND model_id IS NULL AND persona IS NULL
      AND can_write_skills IS NULL AND provider_ids IS NULL AND selected_skill_ids IS NULL
      AND skill_refs IS NULL AND skill_update_selected_skill_ids IS NULL
      AND skill_update_refs IS NULL AND selected_mcp_account_ids IS NULL)
  );
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_get_skill_update_material(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_executor_id text, p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid, p_lease_seconds integer
)
RETURNS TABLE (target_skills_revision integer, required_skills_revision integer,
  selected_skill_ids jsonb, skill_refs jsonb, skill_material jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_authorization record;
  v_actor_id text;
  v_target integer;
  v_ids jsonb;
  v_refs jsonb;
  v_material jsonb;
BEGIN
  IF p_work_kind <> 'operation' THEN RETURN; END IF;
  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN RETURN; END IF;

  SELECT operation.actor_id, operation.target_skills_revision,
         operation.skill_update_selected_skill_ids, operation.skill_update_refs
  INTO v_actor_id, v_target, v_ids, v_refs
  FROM public.companion_operations operation
  WHERE operation.org_id = p_org_id AND operation.companion_id = p_companion_id
    AND operation.id = p_work_id AND operation.status = 'running'
    AND operation.claim_epoch = p_claim_epoch
    AND operation.kind IN ('stop', 'restart_pi', 'restart_box', 'apply_settings');
  IF NOT FOUND OR v_target IS NULL OR v_ids IS NULL OR v_refs IS NULL THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_refs) ref
    LEFT JOIN public.skills skill
      ON skill.org_id = p_org_id AND skill.id = (ref ->> 'skill_id')::uuid
    LEFT JOIN public.skill_versions version
      ON version.org_id = skill.org_id AND version.skill_id = skill.id
     AND version.id = (ref ->> 'current_version_id')::uuid
    WHERE skill.id IS NULL OR version.id IS NULL OR skill.archived_at IS NOT NULL
      OR NOT (skill.scope = 'org' OR skill.creator_id = v_actor_id)
  ) THEN RETURN; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'skill_id', skill.id, 'slug', skill.slug, 'version_id', version.id,
      'version', version.version, 'checksum', version.checksum,
      'size_bytes', version.size_bytes, 'storage_path', version.storage_path
    ) ORDER BY skill.id), '[]'::jsonb)
  INTO v_material
  FROM public.skills skill
  JOIN public.skill_versions version ON version.org_id = skill.org_id AND version.skill_id = skill.id
  WHERE skill.org_id = p_org_id AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_refs) ref
    WHERE ref ->> 'skill_id' = skill.id::text AND ref ->> 'current_version_id' = version.id::text
  );
  IF jsonb_array_length(v_material) <> jsonb_array_length(v_refs) THEN RETURN; END IF;
  RETURN QUERY SELECT v_target,
    (SELECT companion.skills_revision FROM public.companions companion
      WHERE companion.org_id = p_org_id AND companion.id = p_companion_id),
    v_ids, v_refs, v_material;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_commit_skill_update(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_executor_id text, p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid, p_lease_seconds integer,
  p_target_skills_revision integer, p_selected_skill_ids jsonb, p_skill_refs jsonb,
  p_skills_digest text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_authorization record;
  v_selected_skill_ids jsonb;
  v_skill_refs jsonb;
BEGIN
  IF p_work_kind <> 'operation' THEN RETURN NULL; END IF;
  IF p_skills_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid Skills digest' USING ERRCODE = '22023';
  END IF;
  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN RETURN NULL; END IF;
  SELECT CASE WHEN operation.kind = 'start'
           THEN operation.selected_skill_ids ELSE operation.skill_update_selected_skill_ids END,
         CASE WHEN operation.kind = 'start'
           THEN operation.skill_refs ELSE operation.skill_update_refs END
  INTO v_selected_skill_ids, v_skill_refs
  FROM public.companion_operations operation
    WHERE operation.org_id = p_org_id AND operation.companion_id = p_companion_id
      AND operation.id = p_work_id AND operation.status = 'running'
      AND operation.claim_epoch = p_claim_epoch
      AND operation.target_skills_revision = p_target_skills_revision;
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE public.companion_runtime_instances instance
  SET applied_skills_revision = p_target_skills_revision,
      applied_selected_skill_ids = v_selected_skill_ids,
      applied_skill_refs = v_skill_refs,
      applied_skills_digest = p_skills_digest,
      skills_update_error_code = NULL,
      skills_update_error_message = NULL,
      updated_at = clock_timestamp()
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
    AND EXISTS (
      SELECT 1 FROM public.companions companion
      WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
        AND companion.skills_available_revision >= p_target_skills_revision
    );
  RETURN CASE WHEN FOUND THEN true ELSE NULL END;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_record_skill_update_error(
  p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint,
  p_gate_epoch bigint, p_executor_id text, p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid, p_lease_seconds integer,
  p_code text, p_message text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE v_authorization record;
BEGIN
  IF p_work_kind <> 'operation' THEN RETURN NULL; END IF;
  IF p_code !~ '^[a-z][a-z0-9_]{0,63}$' OR char_length(p_message) > 500 OR p_message ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid safe Skills update error' USING ERRCODE = '22023';
  END IF;
  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN RETURN NULL; END IF;
  UPDATE public.companion_runtime_instances instance
  SET skills_update_error_code = p_code, skills_update_error_message = p_message,
      updated_at = clock_timestamp()
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;
  RETURN FOUND;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_runtime_get_skill_update_material(
  uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_commit_skill_update(
  uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer,integer,jsonb,jsonb,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_record_skill_update_error(
  uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer,text,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_keep_available_skill_revision() FROM PUBLIC;
--> statement-breakpoint

DO $skill_update_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure(
    'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,integer)'
  );
  v_role name;
BEGIN
  SELECT role.rolname INTO v_role
  FROM pg_catalog.pg_proc source_proc
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
  ) acl
  JOIN pg_catalog.pg_roles role ON role.oid = acl.grantee
  WHERE source_proc.oid = v_source AND acl.privilege_type = 'EXECUTE'
    AND acl.grantee <> source_proc.proowner AND acl.grantee <> 0;
  IF v_role IS NULL THEN RETURN; END IF;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_runtime_get_skill_update_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) TO %I', v_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_runtime_commit_skill_update(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer,integer,jsonb,jsonb,text) TO %I', v_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_runtime_record_skill_update_error(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer,text,text) TO %I', v_role);
END
$skill_update_acl$;
