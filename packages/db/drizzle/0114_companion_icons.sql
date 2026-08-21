-- THE-382: cosmetic Companion icons. Four small indexes into fixed client-side catalogs. Purely
-- presentational, so the update path treats them as cosmetic-only: no settings revision bump, no
-- checkpoint, never a reason to contact Box or Pi.
ALTER TABLE public.companions
  ADD COLUMN icon_shape smallint NOT NULL DEFAULT 1,
  ADD COLUMN icon_mouth smallint NOT NULL DEFAULT 1,
  ADD COLUMN icon_accessory smallint NOT NULL DEFAULT 1,
  ADD COLUMN icon_color smallint NOT NULL DEFAULT 2;
--> statement-breakpoint
ALTER TABLE public.companions
  ADD CONSTRAINT companions_icon_shape_check CHECK (icon_shape BETWEEN 0 AND 7),
  ADD CONSTRAINT companions_icon_mouth_check CHECK (icon_mouth BETWEEN 0 AND 4),
  ADD CONSTRAINT companions_icon_accessory_check CHECK (icon_accessory BETWEEN 0 AND 6),
  ADD CONSTRAINT companions_icon_color_check CHECK (icon_color BETWEEN 0 AND 10);
--> statement-breakpoint

-- Recreate with the four optional icon parameters appended. PostgreSQL identities functions by
-- name plus argument types, so this creates a new overload: drop the dead 9-arg object so grants
-- and callers can only resolve the granted 13-arg signature.
DROP FUNCTION IF EXISTS public.companion_api_create_companion(
  uuid, text, text, text, text, jsonb, boolean, jsonb, uuid
);
CREATE FUNCTION public.companion_api_create_companion(
  p_org_id uuid,
  p_name text,
  p_persona text,
  p_provider_id text,
  p_model_id text,
  p_selected_skill_ids jsonb,
  p_can_write_skills boolean,
  p_selected_mcp_account_ids jsonb,
  p_source_companion_id uuid DEFAULT NULL,
  p_icon_shape smallint DEFAULT 1,
  p_icon_mouth smallint DEFAULT 1,
  p_icon_accessory smallint DEFAULT 1,
  p_icon_color smallint DEFAULT 2
)
RETURNS TABLE (
  companion_id uuid,
  desired_settings_revision bigint,
  skills_revision integer,
  created_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_companion_id uuid := gen_random_uuid();
  v_created_at timestamp with time zone := clock_timestamp();
BEGIN
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 120
     OR p_persona IS NOT NULL AND char_length(p_persona) > 280
     OR p_provider_id IS NOT NULL AND p_provider_id !~ '^[a-z][a-z0-9-]{0,62}$'
     OR p_model_id IS NOT NULL AND (
       char_length(p_model_id) NOT BETWEEN 1 AND 200 OR p_model_id ~ E'[\n\r]'
     )
     OR p_can_write_skills IS NULL
     OR p_icon_shape IS NULL OR p_icon_shape NOT BETWEEN 0 AND 7
     OR p_icon_mouth IS NULL OR p_icon_mouth NOT BETWEEN 0 AND 4
     OR p_icon_accessory IS NULL OR p_icon_accessory NOT BETWEEN 0 AND 6
     OR p_icon_color IS NULL OR p_icon_color NOT BETWEEN 0 AND 10 THEN
    RAISE EXCEPTION 'invalid Companion create arguments' USING ERRCODE = '22023';
  END IF;
  IF p_provider_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.companion_provider_connections connection
    WHERE connection.org_id = p_org_id AND connection.provider_id = p_provider_id
  ) THEN
    RAISE EXCEPTION 'Companion provider is not connected' USING ERRCODE = '22023';
  END IF;
  IF p_source_companion_id IS NOT NULL THEN
    PERFORM public.companion_api_require_access(p_org_id, p_source_companion_id, 'owner');
  END IF;
  PERFORM public.companion_api_validate_resource_selection(
    p_org_id,
    COALESCE(p_selected_skill_ids, '[]'::jsonb),
    '[]'::jsonb,
    COALESCE(p_selected_mcp_account_ids, '[]'::jsonb),
    '[]'::jsonb
  );

  INSERT INTO public.companions(
    id, org_id, owner_id, name, persona, icon_shape, icon_mouth, icon_accessory, icon_color,
    model_id, selected_skill_ids,
    can_write_skills, selected_mcp_account_ids, provider_ids, created_at, updated_at
  ) VALUES (
    v_companion_id, p_org_id, v_actor_id, btrim(p_name), NULLIF(btrim(p_persona), ''),
    p_icon_shape, p_icon_mouth, p_icon_accessory, p_icon_color,
    p_model_id, COALESCE(p_selected_skill_ids, '[]'::jsonb), p_can_write_skills,
    COALESCE(p_selected_mcp_account_ids, '[]'::jsonb),
    CASE WHEN p_provider_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_provider_id) END,
    v_created_at, v_created_at
  );

  INSERT INTO public.companion_runtime_instances(
    org_id, companion_id, settings_actor_id, settings_available_at, created_at, updated_at
  ) VALUES (
    p_org_id, v_companion_id, v_actor_id, v_created_at, v_created_at, v_created_at
  );

  IF p_source_companion_id IS NOT NULL THEN
    INSERT INTO public.audit_log(
      org_id, actor_id, action, target_type, target_id, metadata
    ) VALUES (
      p_org_id,
      v_actor_id,
      'companion.duplicated',
      'companion',
      v_companion_id::text,
      jsonb_build_object('source_companion_id', p_source_companion_id)
    );
  END IF;

  RETURN QUERY SELECT v_companion_id, 1::bigint, 1, v_created_at;
END
$$;
--> statement-breakpoint

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
  v_icon_shape public.companions.icon_shape%TYPE;
  v_icon_mouth public.companions.icon_mouth%TYPE;
  v_icon_accessory public.companions.icon_accessory%TYPE;
  v_icon_color public.companions.icon_color%TYPE;
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
         'can_write_skills', 'selected_mcp_account_ids', 'icon'
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
  -- Icon indexes are cosmetic (THE-382): validated in place, but never treated as a runtime
  -- settings change, so an icon save neither checkpoints a Box nor wakes anything.
  IF p_patch ? 'icon' THEN
    IF jsonb_typeof(p_patch -> 'icon') <> 'object'
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(p_patch -> 'icon') icon_key
         WHERE icon_key NOT IN ('shape', 'mouth', 'accessory', 'color')
       )
       OR (
         NOT (p_patch -> 'icon') ? 'shape' AND NOT (p_patch -> 'icon') ? 'mouth'
         AND NOT (p_patch -> 'icon') ? 'accessory' AND NOT (p_patch -> 'icon') ? 'color'
       ) THEN
      RAISE EXCEPTION 'invalid Companion icon patch' USING ERRCODE = '22023';
    END IF;
    IF (p_patch -> 'icon') ? 'shape' AND (
      jsonb_typeof(p_patch -> 'icon' -> 'shape') <> 'number'
      OR (p_patch -> 'icon' ->> 'shape') !~ '^[0-9]+$'
      OR (p_patch -> 'icon' ->> 'shape')::numeric NOT BETWEEN 0 AND 7
    ) THEN
      RAISE EXCEPTION 'invalid Companion icon shape' USING ERRCODE = '22023';
    END IF;
    IF (p_patch -> 'icon') ? 'mouth' AND (
      jsonb_typeof(p_patch -> 'icon' -> 'mouth') <> 'number'
      OR (p_patch -> 'icon' ->> 'mouth') !~ '^[0-9]+$'
      OR (p_patch -> 'icon' ->> 'mouth')::numeric NOT BETWEEN 0 AND 4
    ) THEN
      RAISE EXCEPTION 'invalid Companion icon mouth' USING ERRCODE = '22023';
    END IF;
    IF (p_patch -> 'icon') ? 'accessory' AND (
      jsonb_typeof(p_patch -> 'icon' -> 'accessory') <> 'number'
      OR (p_patch -> 'icon' ->> 'accessory') !~ '^[0-9]+$'
      OR (p_patch -> 'icon' ->> 'accessory')::numeric NOT BETWEEN 0 AND 6
    ) THEN
      RAISE EXCEPTION 'invalid Companion icon accessory' USING ERRCODE = '22023';
    END IF;
    IF (p_patch -> 'icon') ? 'color' AND (
      jsonb_typeof(p_patch -> 'icon' -> 'color') <> 'number'
      OR (p_patch -> 'icon' ->> 'color') !~ '^[0-9]+$'
      OR (p_patch -> 'icon' ->> 'color')::numeric NOT BETWEEN 0 AND 10
    ) THEN
      RAISE EXCEPTION 'invalid Companion icon color' USING ERRCODE = '22023';
    END IF;
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
  v_icon_shape := CASE WHEN p_patch -> 'icon' ? 'shape'
    THEN (p_patch -> 'icon' ->> 'shape')::smallint ELSE v_companion.icon_shape END;
  v_icon_mouth := CASE WHEN p_patch -> 'icon' ? 'mouth'
    THEN (p_patch -> 'icon' ->> 'mouth')::smallint ELSE v_companion.icon_mouth END;
  v_icon_accessory := CASE WHEN p_patch -> 'icon' ? 'accessory'
    THEN (p_patch -> 'icon' ->> 'accessory')::smallint ELSE v_companion.icon_accessory END;
  v_icon_color := CASE WHEN p_patch -> 'icon' ? 'color'
    THEN (p_patch -> 'icon' ->> 'color')::smallint ELSE v_companion.icon_color END;

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
      icon_shape = v_icon_shape,
      icon_mouth = v_icon_mouth,
      icon_accessory = v_icon_accessory,
      icon_color = v_icon_color,
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
      'selected_mcp_accounts', p_patch ? 'selected_mcp_account_ids',
      'icon', p_patch ? 'icon'
    )
  );

  RETURN QUERY SELECT p_companion_id, v_instance.desired_settings_revision,
    v_companion.skills_revision, v_settings_changed, v_skills_changed, v_updated_at;
END
$$;
--> statement-breakpoint
-- The recreated create function is a new object, so 0092's PUBLIC revoke no longer applies. Keep
-- the API-login grant gate: only roles explicitly granted EXECUTE (runtime-role-grants.sql) may
-- call this SECURITY DEFINER function.
REVOKE ALL ON FUNCTION public.companion_api_create_companion(
  uuid, text, text, text, text, jsonb, boolean, jsonb, uuid, smallint, smallint, smallint, smallint
) FROM PUBLIC;
