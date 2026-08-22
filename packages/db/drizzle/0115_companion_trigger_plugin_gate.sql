-- Plugin-backed triggers: a linear or github trigger requires the matching MCP plugin attached to
-- the Companion (an account of that provider named by selected_mcp_account_ids). Enforced here so
-- every creation path — direct API, replayed intent, and approved propose_trigger decision — fails
-- closed even if a staged extension is stale. `custom` needs no plugin.

CREATE OR REPLACE FUNCTION public.companion_api_create_trigger(
  p_org_id uuid,
  p_companion_id uuid,
  p_id uuid,
  p_name text,
  p_prompt text,
  p_provider text,
  p_secret text,
  p_enabled boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_name text := btrim(p_name);
  v_prompt text := btrim(p_prompt);
  v_now timestamp with time zone := clock_timestamp();
  v_existing public.companion_triggers%ROWTYPE;
  v_companion public.companions%ROWTYPE;
  v_count integer;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_id IS NULL
     OR v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 80 OR v_name ~ E'[\n\r]'
     OR v_prompt IS NULL OR char_length(v_prompt) NOT BETWEEN 1 AND 16384
     OR p_provider IS NULL OR p_provider NOT IN ('linear', 'github', 'custom')
     OR p_secret IS NULL OR p_secret !~ '^[0-9a-f]{32,128}$'
     OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'invalid Companion trigger' USING ERRCODE = '22023';
  END IF;

  SELECT companion.* INTO v_companion
  FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_provider IN ('linear', 'github') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.companion_mcp_accounts account
      WHERE account.org_id = p_org_id
        AND account.provider = p_provider
        AND COALESCE(v_companion.selected_mcp_account_ids, '[]'::jsonb) ? account.id::text
    ) THEN
      RAISE EXCEPTION 'a % trigger requires the % plugin attached to the Companion', p_provider, p_provider
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT trigger_row.* INTO v_existing
  FROM public.companion_triggers trigger_row
  WHERE trigger_row.id = p_id
  FOR UPDATE;
  IF FOUND THEN
    -- The secret is deliberately outside the intent compare: a retried create carries a freshly
    -- generated secret, and the replay must return the stored one instead of conflicting on it.
    IF v_existing.org_id IS DISTINCT FROM p_org_id
       OR v_existing.companion_id IS DISTINCT FROM p_companion_id
       OR v_existing.name IS DISTINCT FROM v_name
       OR v_existing.prompt IS DISTINCT FROM v_prompt
       OR v_existing.provider IS DISTINCT FROM p_provider
       OR v_existing.enabled IS DISTINCT FROM p_enabled THEN
      RAISE EXCEPTION 'trigger id was reused with different trigger intent'
        USING ERRCODE = '23505';
    END IF;
    RETURN public.companion_api_trigger_json(p_org_id, p_companion_id, p_id, true);
  END IF;

  SELECT count(*)::integer INTO v_count
  FROM public.companion_triggers trigger_row
  WHERE trigger_row.org_id = p_org_id AND trigger_row.companion_id = p_companion_id;
  IF v_count >= 10 THEN
    RAISE EXCEPTION 'Companion trigger limit reached' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.companion_triggers(
    id, org_id, companion_id, name, prompt, provider, secret, enabled,
    created_by, created_at, updated_at
  ) VALUES (
    p_id, p_org_id, p_companion_id, v_name, v_prompt, p_provider, p_secret, p_enabled,
    v_actor_id, v_now, v_now
  );

  RETURN public.companion_api_trigger_json(p_org_id, p_companion_id, p_id, true);
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_update_trigger(
  p_org_id uuid,
  p_companion_id uuid,
  p_trigger_id uuid,
  p_name text,
  p_prompt text,
  p_provider text,
  p_enabled boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_name text := btrim(p_name);
  v_prompt text := btrim(p_prompt);
  v_now timestamp with time zone := clock_timestamp();
  v_trigger public.companion_triggers%ROWTYPE;
  v_companion public.companions%ROWTYPE;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_trigger_id IS NULL
     OR v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 80 OR v_name ~ E'[\n\r]'
     OR v_prompt IS NULL OR char_length(v_prompt) NOT BETWEEN 1 AND 16384
     OR p_provider IS NULL OR p_provider NOT IN ('linear', 'github', 'custom')
     OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'invalid Companion trigger' USING ERRCODE = '22023';
  END IF;

  SELECT companion.* INTO v_companion
  FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_provider IN ('linear', 'github') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.companion_mcp_accounts account
      WHERE account.org_id = p_org_id
        AND account.provider = p_provider
        AND COALESCE(v_companion.selected_mcp_account_ids, '[]'::jsonb) ? account.id::text
    ) THEN
      RAISE EXCEPTION 'a % trigger requires the % plugin attached to the Companion', p_provider, p_provider
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT trigger_row.* INTO v_trigger
  FROM public.companion_triggers trigger_row
  WHERE trigger_row.org_id = p_org_id
    AND trigger_row.companion_id = p_companion_id
    AND trigger_row.id = p_trigger_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion trigger not found' USING ERRCODE = 'P0002';
  END IF;

  -- The secret is never touched here; rotation is its own explicit capability.
  UPDATE public.companion_triggers trigger_row
  SET name = v_name,
      prompt = v_prompt,
      provider = p_provider,
      enabled = p_enabled,
      last_error_code = NULL,
      last_error_message = NULL,
      last_error_at = NULL,
      consecutive_failures = 0,
      updated_at = v_now
  WHERE trigger_row.id = p_trigger_id
    AND trigger_row.org_id = p_org_id
    AND trigger_row.companion_id = p_companion_id;

  RETURN public.companion_api_trigger_json(p_org_id, p_companion_id, p_trigger_id, true);
END
$$;
