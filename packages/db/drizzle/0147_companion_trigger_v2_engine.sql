-- Trigger v2: autonomous definitions, shared provider credentials, isolated payload validation,
-- and read-only run history. Existing rows keep relay semantics and their current callback URL.

-- A trigger-provider connection is member-scoped authority, not a Companion MCP attachment.
-- OAuth rows reuse the encrypted MCP credential in place; API-key rows own a separate write-only
-- envelope. Soft disconnect keeps dependent triggers visible and retryable.
CREATE TABLE public.companion_trigger_provider_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  provider text NOT NULL,
  label text NOT NULL,
  credential_source text NOT NULL,
  mcp_account_id uuid REFERENCES public.companion_mcp_accounts(id) ON DELETE SET NULL,
  credential_generation uuid,
  ciphertext text,
  iv text,
  auth_tag text,
  wrapped_dek text,
  wrap_iv text,
  wrap_auth_tag text,
  key_id text,
  status text NOT NULL DEFAULT 'connected',
  disconnected_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companion_trigger_provider_accounts_owner_membership_fk
    FOREIGN KEY (org_id, owner_id) REFERENCES public.memberships(org_id, user_id) ON DELETE CASCADE,
  CONSTRAINT companion_trigger_provider_accounts_provider_check
    CHECK (provider IN ('github', 'linear', 'sentry')),
  CONSTRAINT companion_trigger_provider_accounts_label_check
    CHECK (char_length(label) BETWEEN 1 AND 40),
  CONSTRAINT companion_trigger_provider_accounts_status_check
    CHECK (status IN ('connected', 'disconnected')),
  CONSTRAINT companion_trigger_provider_accounts_credential_check CHECK (
    (credential_source = 'mcp_oauth'
      AND credential_generation IS NULL AND ciphertext IS NULL AND iv IS NULL AND auth_tag IS NULL
      AND wrapped_dek IS NULL AND wrap_iv IS NULL AND wrap_auth_tag IS NULL AND key_id IS NULL
      AND (status = 'disconnected' OR mcp_account_id IS NOT NULL))
    OR
    (credential_source = 'api_key' AND mcp_account_id IS NULL AND (
      (status = 'connected' AND credential_generation IS NOT NULL AND ciphertext IS NOT NULL
        AND iv IS NOT NULL AND auth_tag IS NOT NULL AND wrapped_dek IS NOT NULL
        AND wrap_iv IS NOT NULL AND wrap_auth_tag IS NOT NULL AND key_id IS NOT NULL)
      OR
      (status = 'disconnected' AND credential_generation IS NULL AND ciphertext IS NULL
        AND iv IS NULL AND auth_tag IS NULL AND wrapped_dek IS NULL
        AND wrap_iv IS NULL AND wrap_auth_tag IS NULL AND key_id IS NULL)
    ))
  ),
  CONSTRAINT companion_trigger_provider_accounts_disconnected_check
    CHECK ((status = 'disconnected') = (disconnected_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX companion_trigger_provider_accounts_provider_label_uq
  ON public.companion_trigger_provider_accounts(org_id, owner_id, provider, lower(label));
--> statement-breakpoint
CREATE INDEX companion_trigger_provider_accounts_owner_idx
  ON public.companion_trigger_provider_accounts(org_id, owner_id, updated_at);
--> statement-breakpoint
ALTER TABLE public.companion_trigger_provider_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_trigger_provider_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY companion_trigger_provider_accounts_owner_select_rls
  ON public.companion_trigger_provider_accounts FOR SELECT
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND owner_id = NULLIF(current_setting('app.user_id', true), ''));
--> statement-breakpoint
CREATE POLICY companion_trigger_provider_accounts_owner_insert_rls
  ON public.companion_trigger_provider_accounts FOR INSERT
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND owner_id = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM public.memberships m
      WHERE m.org_id = companion_trigger_provider_accounts.org_id
        AND m.user_id = companion_trigger_provider_accounts.owner_id));
--> statement-breakpoint
CREATE POLICY companion_trigger_provider_accounts_owner_update_rls
  ON public.companion_trigger_provider_accounts FOR UPDATE
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND owner_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND owner_id = NULLIF(current_setting('app.user_id', true), ''));
--> statement-breakpoint
CREATE POLICY companion_trigger_provider_accounts_owner_delete_rls
  ON public.companion_trigger_provider_accounts FOR DELETE
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND owner_id = NULLIF(current_setting('app.user_id', true), ''));
--> statement-breakpoint

CREATE FUNCTION public.companion_degrade_trigger_provider_account()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$
BEGIN
  IF NEW.status = 'disconnected' OR (NEW.credential_source = 'mcp_oauth' AND NEW.mcp_account_id IS NULL) THEN
    UPDATE public.companion_triggers trigger_row
    SET registration_status = 'unregistered',
        last_registration_error = 'Provider account disconnected. Reconnect it, then retry registration.',
        updated_at = clock_timestamp()
    WHERE trigger_row.org_id = NEW.org_id
      AND trigger_row.provider_account_id = NEW.id
      AND trigger_row.registration_status <> 'manual';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER companion_trigger_provider_accounts_degrade_dependents
AFTER UPDATE OF status, mcp_account_id ON public.companion_trigger_provider_accounts
FOR EACH ROW EXECUTE FUNCTION public.companion_degrade_trigger_provider_account();
--> statement-breakpoint

CREATE FUNCTION public.companion_disconnect_trigger_provider_for_mcp()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$
BEGIN
  UPDATE public.companion_trigger_provider_accounts provider_account
  SET status = 'disconnected', disconnected_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE provider_account.mcp_account_id = OLD.id;
  RETURN OLD;
END
$$;
--> statement-breakpoint
CREATE TRIGGER companion_mcp_accounts_disconnect_trigger_provider
BEFORE DELETE ON public.companion_mcp_accounts
FOR EACH ROW EXECUTE FUNCTION public.companion_disconnect_trigger_provider_for_mcp();
--> statement-breakpoint

-- Existing OAuth-capable MCP connections become trigger authority without a second consent or key.
INSERT INTO public.companion_trigger_provider_accounts(
  org_id, owner_id, provider, label, credential_source, mcp_account_id
)
SELECT account.org_id, account.owner_id, account.provider, account.label, 'mcp_oauth', account.id
FROM public.companion_mcp_accounts account
WHERE account.provider IN ('github', 'sentry');
--> statement-breakpoint

-- Preserve the historical Linear registration key as a member-scoped API-key connection.
INSERT INTO public.companion_trigger_provider_accounts(
  org_id, owner_id, provider, label, credential_source, credential_generation,
  ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id
)
SELECT key_row.org_id, account.owner_id, key_row.provider, account.label, 'api_key',
  key_row.credential_generation, key_row.ciphertext, key_row.iv, key_row.auth_tag,
  key_row.wrapped_dek, key_row.wrap_iv, key_row.wrap_auth_tag, key_row.key_id
FROM public.companion_plugin_trigger_keys key_row
JOIN public.companion_mcp_accounts account ON account.id = key_row.account_id;
--> statement-breakpoint

ALTER TABLE public.companion_triggers
  ADD COLUMN mode text NOT NULL DEFAULT 'relay',
  ADD COLUMN provider_account_id uuid
    REFERENCES public.companion_trigger_provider_accounts(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE public.companion_triggers
  DROP CONSTRAINT IF EXISTS companion_triggers_remote_hook_account_id_fkey;
--> statement-breakpoint
-- Remap existing GitHub registrations to the member-scoped account and preserve the new primary
-- provider reference used by webhook authorization.
UPDATE public.companion_triggers trigger_row
SET provider_account_id = provider_account.id,
    remote_hook_account_id = provider_account.id
FROM public.companion_trigger_provider_accounts provider_account
WHERE trigger_row.provider = 'github'
  AND provider_account.mcp_account_id = trigger_row.remote_hook_account_id;
--> statement-breakpoint
-- Historical Linear registrations recorded the MCP account which owned the separate trigger key.
-- Translate that legacy account through the key row to its new API-key provider account before the
-- remote-hook foreign key changes target.
UPDATE public.companion_triggers trigger_row
SET provider_account_id = provider_account.id,
    remote_hook_account_id = provider_account.id
FROM public.companion_plugin_trigger_keys key_row
JOIN public.companion_mcp_accounts legacy_account
  ON legacy_account.org_id = key_row.org_id AND legacy_account.id = key_row.account_id
JOIN public.companion_trigger_provider_accounts provider_account
  ON provider_account.org_id = key_row.org_id
 AND provider_account.owner_id = legacy_account.owner_id
 AND provider_account.provider = key_row.provider
 AND provider_account.credential_source = 'api_key'
 AND provider_account.credential_generation = key_row.credential_generation
WHERE trigger_row.provider = 'linear'
  AND trigger_row.org_id = key_row.org_id
  AND trigger_row.remote_hook_account_id = key_row.account_id;
--> statement-breakpoint
ALTER TABLE public.companion_triggers
  ADD CONSTRAINT companion_triggers_remote_hook_account_id_companion_trigger_provider_accounts_id_fk
  FOREIGN KEY (remote_hook_account_id)
  REFERENCES public.companion_trigger_provider_accounts(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE public.companion_triggers
  ADD CONSTRAINT companion_triggers_mode_check CHECK (mode IN ('notify', 'relay'));
--> statement-breakpoint
ALTER TABLE public.companion_triggers
  DROP CONSTRAINT companion_triggers_provider_check,
  ADD CONSTRAINT companion_triggers_provider_check
    CHECK (provider IN ('webhook', 'linear', 'github', 'sentry', 'custom'));
--> statement-breakpoint
ALTER TABLE public.companion_triggers
  DROP CONSTRAINT companion_triggers_registration_status_check,
  ADD CONSTRAINT companion_triggers_registration_status_check
    CHECK (registration_status IN ('manual', 'unregistered', 'registered', 'failed'));
--> statement-breakpoint

ALTER TABLE public.companion_turns ADD COLUMN trigger_mode text;
--> statement-breakpoint
ALTER TABLE public.companion_turns
  DROP CONSTRAINT companion_turns_trigger_origin_check,
  DROP CONSTRAINT companion_turns_routine_snapshot_check,
  ADD CONSTRAINT companion_turns_routine_snapshot_check CHECK (
    routine_snapshot_id IS NULL OR routine_name IS NOT NULL OR trigger_name IS NOT NULL
  ),
  ADD CONSTRAINT companion_turns_trigger_mode_check CHECK (
    (trigger_name IS NULL AND trigger_mode IS NULL)
    OR (trigger_name IS NOT NULL AND trigger_mode IN ('notify', 'relay'))
  ),
  ADD CONSTRAINT companion_turns_trigger_origin_check CHECK (
    (trigger_id IS NULL OR trigger_name IS NOT NULL)
    AND (trigger_name IS NULL OR (char_length(trigger_name) BETWEEN 1 AND 80 AND trigger_name !~ E'[\n\r]'))
    AND (trigger_name IS NULL OR routine_id IS NULL)
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_trigger_json(
  p_org_id uuid, p_companion_id uuid, p_trigger_id uuid, p_include_secret boolean
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on
AS $$
  SELECT jsonb_build_object(
    'id', t.id, 'companion_id', t.companion_id, 'name', t.name, 'prompt', t.prompt,
    'mode', t.mode, 'provider', t.provider, 'provider_account_id', t.provider_account_id,
    'target', NULLIF(t.target, '{}'::jsonb), 'registration_status', t.registration_status,
    'remote_hook_account_id', t.remote_hook_account_id, 'remote_hook_id', t.remote_hook_id,
    'last_registration_error', t.last_registration_error, 'enabled', t.enabled,
    'secret', CASE WHEN p_include_secret THEN t.secret ELSE NULL END,
    'last_fired_at', CASE WHEN t.last_fired_at IS NULL THEN NULL ELSE to_char(t.last_fired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
    'last_error_code', t.last_error_code, 'last_error_message', t.last_error_message,
    'last_error_at', CASE WHEN t.last_error_at IS NULL THEN NULL ELSE to_char(t.last_error_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
    'consecutive_failures', t.consecutive_failures,
    'created_at', to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updated_at', to_char(t.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ) FROM public.companion_triggers t
  WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id AND t.id = p_trigger_id
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_set_trigger_registration(
  p_org_id uuid, p_companion_id uuid, p_trigger_id uuid,
  p_remote_hook_account_id uuid, p_remote_hook_id text,
  p_registration_status text, p_last_registration_error text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on
AS $$
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  IF p_trigger_id IS NULL
     OR p_registration_status NOT IN ('manual','unregistered','registered','failed')
     OR (p_registration_status='registered' AND (p_remote_hook_id IS NULL OR p_remote_hook_account_id IS NULL))
     OR char_length(COALESCE(p_last_registration_error,''))>500 THEN
    RAISE EXCEPTION 'invalid Companion trigger registration' USING ERRCODE='22023';
  END IF;
  UPDATE public.companion_triggers trigger_row
  SET remote_hook_id=p_remote_hook_id, remote_hook_account_id=p_remote_hook_account_id,
      registration_status=p_registration_status,
      last_registration_error=p_last_registration_error, updated_at=clock_timestamp()
  WHERE trigger_row.org_id=p_org_id AND trigger_row.companion_id=p_companion_id
    AND trigger_row.id=p_trigger_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Companion trigger not found' USING ERRCODE='P0002'; END IF;
  RETURN public.companion_api_trigger_json(p_org_id,p_companion_id,p_trigger_id,true);
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_create_trigger(
  p_org_id uuid, p_companion_id uuid, p_id uuid, p_name text, p_prompt text,
  p_mode text, p_provider text, p_provider_account_id uuid, p_target jsonb,
  p_secret text, p_enabled boolean
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_name text := btrim(p_name); v_prompt text := btrim(p_prompt);
  v_now timestamptz := clock_timestamp(); v_existing public.companion_triggers%ROWTYPE;
  v_account_id uuid := p_provider_account_id; v_count integer;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_id IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 80 OR v_name ~ E'[\n\r]'
     OR char_length(v_prompt) NOT BETWEEN 1 AND 16384 OR p_mode NOT IN ('notify','relay')
     OR p_provider NOT IN ('webhook','linear','github','sentry','custom')
     OR p_target IS NULL OR jsonb_typeof(p_target) <> 'object'
     OR p_secret !~ '^[0-9a-f]{32,128}$' OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'invalid Companion trigger' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.companions c
   WHERE c.org_id=p_org_id AND c.id=p_companion_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Companion not found' USING ERRCODE='P0002'; END IF;

  IF p_provider IN ('github','linear','sentry') AND v_account_id IS NULL THEN
    SELECT CASE WHEN count(*) = 1 THEN min(a.id::text)::uuid ELSE NULL END, count(*)::integer
      INTO v_account_id, v_count
    FROM public.companion_trigger_provider_accounts a
    WHERE a.org_id=p_org_id AND a.owner_id=v_actor_id AND a.provider=p_provider
      AND a.status='connected';
    IF v_count > 1 THEN
      RAISE EXCEPTION 'multiple trigger provider accounts are eligible; choose provider_account_id'
        USING ERRCODE='22023';
    END IF;
  END IF;
  IF v_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.companion_trigger_provider_accounts a
    WHERE a.org_id=p_org_id AND a.owner_id=v_actor_id AND a.id=v_account_id
      AND a.provider=p_provider AND a.status='connected'
  ) THEN
    RAISE EXCEPTION 'trigger provider account is not connected for this member' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_existing FROM public.companion_triggers WHERE id=p_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.org_id IS DISTINCT FROM p_org_id OR v_existing.companion_id IS DISTINCT FROM p_companion_id
      OR v_existing.name IS DISTINCT FROM v_name OR v_existing.prompt IS DISTINCT FROM v_prompt
      OR v_existing.mode IS DISTINCT FROM p_mode OR v_existing.provider IS DISTINCT FROM p_provider
      OR v_existing.provider_account_id IS DISTINCT FROM v_account_id
      OR v_existing.target IS DISTINCT FROM p_target OR v_existing.enabled IS DISTINCT FROM p_enabled THEN
      RAISE EXCEPTION 'trigger id was reused with different trigger intent' USING ERRCODE='23505';
    END IF;
    RETURN public.companion_api_trigger_json(p_org_id,p_companion_id,p_id,true);
  END IF;
  SELECT count(*)::integer INTO v_count FROM public.companion_triggers
   WHERE org_id=p_org_id AND companion_id=p_companion_id;
  IF v_count >= 10 THEN RAISE EXCEPTION 'Companion trigger limit reached' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.companion_triggers(
    id,org_id,companion_id,name,prompt,mode,provider,provider_account_id,target,secret,enabled,
    created_by,created_at,updated_at
  ) VALUES (
    p_id,p_org_id,p_companion_id,v_name,v_prompt,p_mode,p_provider,v_account_id,p_target,p_secret,p_enabled,
    v_actor_id,v_now,v_now
  );
  RETURN public.companion_api_trigger_json(p_org_id,p_companion_id,p_id,true);
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_trigger_run_json(
  p_org_id uuid,p_companion_id uuid,p_run_id uuid,p_viewer boolean DEFAULT false,
  p_entry_cursor integer DEFAULT NULL,p_entry_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on
AS $$
  SELECT jsonb_build_object(
    'run_id',t.id,'companion_id',t.companion_id,
    'trigger',jsonb_build_object('id',COALESCE(t.routine_snapshot_id,t.trigger_id),'name',t.trigger_name),
    'status',t.status,'mode',t.trigger_mode,
    'outcome',CASE WHEN r.run_id IS NOT NULL THEN 'surfaced'
      WHEN t.status IN ('failed','interrupted','cancelled') THEN 'error'
      WHEN t.status='succeeded' THEN 'no_output' ELSE 'pending' END,
    'surface_mode',r.mode,'main_entry_event_id',r.main_entry_event_id,'relay_turn_id',r.relay_turn_id,
    'created_at',t.created_at,'started_at',a.started_at,'settled_at',t.settled_at,
    'error',CASE WHEN p_viewer AND t.last_error_code IS NOT NULL
      THEN public.companion_api_safe_error('runtime_unavailable','Companion runtime needs attention.','none'::public.companion_runtime_error_action)
      ELSE public.companion_api_safe_error(t.last_error_code,t.last_error_message,t.last_error_action) END,
    'internal_entries',COALESCE(h.entries,'[]'::jsonb),'next_entry_cursor',h.next_cursor
  )
  FROM public.companion_turns t
  LEFT JOIN public.companion_routine_returns r
    ON r.org_id=t.org_id AND r.companion_id=t.companion_id AND r.run_id=t.id
  LEFT JOIN LATERAL (
    SELECT x.started_at FROM public.companion_turn_attempts x
    WHERE x.org_id=t.org_id AND x.companion_id=t.companion_id AND x.turn_id=t.id
    ORDER BY x.attempt_number DESC,x.id DESC LIMIT 1
  ) a ON true
  LEFT JOIN LATERAL (
    WITH ranked AS (
      SELECT e.*,row_number() OVER(ORDER BY e.ordinal,e.event_id) n
      FROM public.companion_routine_run_entries e
      WHERE e.org_id=t.org_id AND e.companion_id=t.companion_id AND e.run_id=t.id
        AND (p_entry_cursor IS NULL OR e.ordinal>p_entry_cursor)
    ), page AS (
      SELECT * FROM ranked WHERE n<=greatest(1,least(COALESCE(p_entry_limit,50),100))
      ORDER BY ordinal,event_id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'event_id',e.event_id,'ordinal',e.ordinal,'role',e.role,'content',e.content,
      'reasoning',e.reasoning,'tool',e.tool,'decision',e.decision,'created_at',e.created_at
    ) ORDER BY e.ordinal,e.event_id),'[]'::jsonb) entries,
    CASE WHEN count(*)<(SELECT count(*) FROM ranked) THEN max(e.ordinal) ELSE NULL END next_cursor
    FROM page e
  ) h ON COALESCE(p_entry_limit,50)>0
  WHERE t.org_id=p_org_id AND t.companion_id=p_companion_id AND t.id=p_run_id
    AND t.trigger_name IS NOT NULL
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_trigger_run_summary_json(
  p_org_id uuid,p_companion_id uuid,p_run_id uuid,p_viewer boolean DEFAULT false
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on
AS $$ SELECT public.companion_api_trigger_run_json(
  p_org_id,p_companion_id,p_run_id,p_viewer,NULL,0
) - ARRAY['internal_entries','next_entry_cursor'] $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_list_trigger_runs(
  p_org_id uuid,p_companion_id uuid,p_trigger_id uuid,p_cursor uuid DEFAULT NULL,p_limit integer DEFAULT 50
)
RETURNS TABLE(run jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on
AS $$
DECLARE v_access text;
BEGIN
  v_access:=public.companion_api_require_access(p_org_id,p_companion_id,'read');
  RETURN QUERY SELECT public.companion_api_trigger_run_summary_json(
    t.org_id,t.companion_id,t.id,v_access='viewer'
  ) FROM public.companion_turns t
  WHERE t.org_id=p_org_id AND t.companion_id=p_companion_id AND t.trigger_name IS NOT NULL
    AND COALESCE(t.routine_snapshot_id,t.trigger_id)=p_trigger_id
    AND (p_cursor IS NULL OR t.queue_sequence < (
      SELECT c.queue_sequence FROM public.companion_turns c
      WHERE c.org_id=p_org_id AND c.companion_id=p_companion_id AND c.id=p_cursor
        AND c.trigger_name IS NOT NULL AND COALESCE(c.routine_snapshot_id,c.trigger_id)=p_trigger_id
    ))
  ORDER BY t.queue_sequence DESC,t.id DESC
  LIMIT greatest(1,least(COALESCE(p_limit,50),101));
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_get_trigger_run(
  p_org_id uuid,p_companion_id uuid,p_run_id uuid,p_entry_cursor integer DEFAULT NULL,p_entry_limit integer DEFAULT 50
)
RETURNS TABLE(run jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on
AS $$
DECLARE v_access text; v_run jsonb;
BEGIN
  v_access:=public.companion_api_require_access(p_org_id,p_companion_id,'read');
  v_run:=public.companion_api_trigger_run_json(
    p_org_id,p_companion_id,p_run_id,v_access='viewer',p_entry_cursor,
    greatest(1,least(COALESCE(p_entry_limit,50),100))
  );
  IF v_run IS NOT NULL THEN RETURN QUERY SELECT v_run; END IF;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_webhook_get_trigger(p_trigger_id uuid)
RETURNS TABLE(org_id uuid,companion_id uuid,name text,prompt text,provider text,secret text,enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on
AS $$
  SELECT t.org_id,t.companion_id,t.name,t.prompt,t.provider,t.secret,
    t.enabled AND (
      t.provider IN ('webhook','custom')
      OR (t.registration_status='registered' AND provider_account.status='connected')
    )
  FROM public.companion_triggers t
  LEFT JOIN public.companion_trigger_provider_accounts provider_account
    ON provider_account.org_id=t.org_id AND provider_account.id=t.provider_account_id
  WHERE t.id=p_trigger_id
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_fire_trigger(
  p_org_id uuid,p_trigger_id uuid,p_client_message_id uuid,p_content text
)
RETURNS TABLE(outcome text,turn jsonb,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on
AS $$
DECLARE
  v_trigger public.companion_triggers%ROWTYPE; v_owner_id text;
  v_turn jsonb; v_turn_id uuid; v_replayed boolean:=false; v_replay boolean:=false;
BEGIN
  IF p_org_id IS NULL OR p_trigger_id IS NULL OR p_client_message_id IS NULL
    OR p_content IS NULL OR char_length(btrim(p_content)) NOT BETWEEN 1 AND 16384 THEN
    RAISE EXCEPTION 'invalid Companion trigger fire' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_trigger FROM public.companion_triggers
   WHERE org_id=p_org_id AND id=p_trigger_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Companion trigger not found' USING ERRCODE='P0002'; END IF;
  SELECT EXISTS(SELECT 1 FROM public.companion_turns
    WHERE org_id=p_org_id AND companion_id=v_trigger.companion_id
      AND client_message_id=p_client_message_id) INTO v_replay;
  IF NOT v_replay THEN
    IF NOT v_trigger.enabled THEN RETURN QUERY SELECT 'skipped_disabled',NULL::jsonb,false; RETURN; END IF;
    IF v_trigger.last_fired_at IS NOT NULL
       AND v_trigger.last_fired_at > statement_timestamp()-interval '60 seconds' THEN
      RETURN QUERY SELECT 'skipped_throttled',NULL::jsonb,false; RETURN;
    END IF;
    IF EXISTS(SELECT 1 FROM public.companion_turns q
      WHERE q.org_id=p_org_id AND q.companion_id=v_trigger.companion_id
        AND q.trigger_id=p_trigger_id AND q.status IN ('queued','starting','dispatching','running','needs_input')) THEN
      RETURN QUERY SELECT 'skipped_pileup',NULL::jsonb,false; RETURN;
    END IF;
  END IF;
  SELECT owner_id INTO STRICT v_owner_id FROM public.companions
   WHERE org_id=p_org_id AND id=v_trigger.companion_id;
  PERFORM set_config('app.org_id',p_org_id::text,true);
  PERFORM set_config('app.user_id',v_owner_id,true);
  SELECT q.turn,q.replayed INTO v_turn,v_replayed FROM public.companion_api_enqueue_turn(
    p_org_id,v_trigger.companion_id,p_client_message_id,p_content,
    'web'::public.companion_client_surface,'[]'::jsonb,NULL::uuid,NULL::text,
    v_trigger.id,v_trigger.name
  ) q;
  v_turn_id := (v_turn->>'id')::uuid;
  IF NOT v_replayed THEN
    UPDATE public.companion_turns SET
      routine_snapshot_id=v_trigger.id,
      routine_snapshot_created_at=v_trigger.created_at,
      trigger_mode=v_trigger.mode,
      updated_at=clock_timestamp()
    WHERE org_id=p_org_id AND companion_id=v_trigger.companion_id AND id=v_turn_id;
  END IF;
  UPDATE public.companion_triggers SET
    last_fired_at=CASE WHEN v_replayed THEN last_fired_at ELSE statement_timestamp() END,
    last_error_code=NULL,last_error_message=NULL,last_error_at=NULL,updated_at=clock_timestamp()
  WHERE id=p_trigger_id;
  RETURN QUERY SELECT CASE WHEN v_replayed THEN 'replayed' ELSE 'fired' END,v_turn,v_replayed;
END $$;
--> statement-breakpoint

-- Reuse the proven routine context builder without copying its 200-line renderer. The wrapper
-- temporarily supplies the legacy lane label inside this transaction, calls the old implementation,
-- then removes it before any other transaction can observe the trigger as a routine.
ALTER FUNCTION public.companion_runtime_prepare_routine_run(
  uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,boolean
) RENAME TO companion_runtime_prepare_isolated_run_internal;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_prepare_routine_run(
  p_org_id uuid,p_companion_id uuid,p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,
  p_executor_id text,p_work_kind public.companion_runtime_work_kind,p_work_id uuid,
  p_enable_new_isolation boolean
)
RETURNS TABLE(isolated boolean,context_id uuid,context_sha256 text,context_content text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on
AS $$
DECLARE v_turn_id uuid; v_trigger_name text; v_row record;
BEGIN
  IF p_work_kind='attempt' THEN
    SELECT t.id,t.trigger_name INTO v_turn_id,v_trigger_name
    FROM public.companion_runtime_leases l
    JOIN public.companion_runtime_control c ON c.id='runtime-v2'
    JOIN public.companion_turn_attempts a
      ON a.org_id=l.org_id AND a.companion_id=l.companion_id AND a.id=p_work_id
    JOIN public.companion_turns t
      ON t.org_id=a.org_id AND t.companion_id=a.companion_id AND t.id=a.turn_id
    WHERE l.org_id=p_org_id AND l.companion_id=p_companion_id
      AND l.claim_token=p_claim_token AND l.claim_epoch=p_claim_epoch AND l.gate_epoch=p_gate_epoch
      AND l.executor_id=p_executor_id AND l.work_kind=p_work_kind AND l.work_id=p_work_id
      AND l.expires_at>clock_timestamp() AND c.enabled AND c.gate_epoch=p_gate_epoch
      AND a.claim_epoch=p_claim_epoch AND a.status IN ('starting','dispatching','running','needs_input')
    FOR UPDATE OF l,a,t;
    IF v_trigger_name IS NOT NULL THEN
      UPDATE public.companion_turns SET routine_name=v_trigger_name
      WHERE id=v_turn_id AND org_id=p_org_id AND companion_id=p_companion_id AND routine_name IS NULL;
    END IF;
  END IF;
  SELECT * INTO v_row FROM public.companion_runtime_prepare_isolated_run_internal(
    p_org_id,p_companion_id,p_claim_token,p_claim_epoch,p_gate_epoch,p_executor_id,
    p_work_kind,p_work_id,p_enable_new_isolation
  );
  IF v_trigger_name IS NOT NULL THEN
    UPDATE public.companion_turns SET routine_name=NULL
    WHERE id=v_turn_id AND org_id=p_org_id AND companion_id=p_companion_id AND trigger_name IS NOT NULL;
  END IF;
  IF v_row IS NOT NULL THEN
    RETURN QUERY SELECT v_row.isolated,v_row.context_id,v_row.context_sha256,v_row.context_content;
  END IF;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_record_trigger_run_outcome()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on
AS $$
DECLARE v_now timestamptz:=COALESCE(NEW.settled_at,clock_timestamp());
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status OR NEW.trigger_name IS NULL
    OR NEW.status NOT IN ('succeeded','failed','interrupted','cancelled') THEN RETURN NULL; END IF;
  IF NEW.status='succeeded' THEN
    UPDATE public.companion_triggers SET consecutive_failures=0,last_error_code=NULL,
      last_error_message=NULL,last_error_at=NULL,updated_at=v_now
    WHERE org_id=NEW.org_id AND companion_id=NEW.companion_id
      AND id=NEW.routine_snapshot_id AND created_at=NEW.routine_snapshot_created_at;
  ELSIF NEW.status='failed' THEN
    UPDATE public.companion_triggers SET consecutive_failures=consecutive_failures+1,
      last_error_code=NEW.last_error_code,last_error_message=NEW.last_error_message,last_error_at=v_now,
      enabled=CASE WHEN consecutive_failures+1>=5 THEN false ELSE enabled END,updated_at=v_now
    WHERE org_id=NEW.org_id AND companion_id=NEW.companion_id
      AND id=NEW.routine_snapshot_id AND created_at=NEW.routine_snapshot_created_at;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

DO $exclude_triggers_from_routine_accounting$
DECLARE v_definition text; v_old text:='     OR NEW.routine_snapshot_id IS NULL';
  v_new text:=E'     OR NEW.routine_snapshot_id IS NULL\n     OR NEW.trigger_name IS NOT NULL';
BEGIN
  v_definition:=pg_get_functiondef(to_regprocedure('public.companion_record_routine_run_outcome()'));
  IF v_definition IS NULL OR strpos(v_definition,v_old)=0 THEN
    RAISE EXCEPTION 'routine outcome accounting shape changed' USING ERRCODE='55000';
  END IF;
  EXECUTE replace(v_definition,v_old,v_new);
END $exclude_triggers_from_routine_accounting$;
--> statement-breakpoint

DO $exclude_triggers_from_routine_history$
DECLARE v_sig text; v_definition text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.companion_api_routine_run_json(uuid,uuid,uuid,boolean,integer,integer)',
    'public.companion_api_list_routine_runs(uuid,uuid,uuid,uuid,integer)'
  ] LOOP
    v_definition:=pg_get_functiondef(to_regprocedure(v_sig));
    IF v_definition IS NULL OR strpos(v_definition,'turn_row.routine_name IS NOT NULL')=0 THEN
      RAISE EXCEPTION 'routine history shape changed for %',v_sig USING ERRCODE='55000';
    END IF;
    EXECUTE replace(v_definition,'turn_row.routine_name IS NOT NULL',
      'turn_row.routine_name IS NOT NULL AND turn_row.trigger_name IS NULL');
  END LOOP;
END $exclude_triggers_from_routine_history$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_record_trigger_run_outcome() FROM PUBLIC;
CREATE TRIGGER companion_turns_record_trigger_run_outcome
AFTER UPDATE OF status ON public.companion_turns
FOR EACH ROW EXECUTE FUNCTION public.companion_record_trigger_run_outcome();
--> statement-breakpoint

ALTER FUNCTION public.companion_runtime_surface_routine_return(
  uuid,uuid,uuid,public.companion_routine_surface_mode,text
) RENAME TO companion_runtime_surface_isolated_return_internal;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_surface_routine_return(
  p_org_id uuid,p_companion_id uuid,p_run_id uuid,
  p_mode public.companion_routine_surface_mode,p_message text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on
AS $$
DECLARE v_trigger_name text; v_trigger_mode text; v_result boolean; v_relay_turn_id uuid;
BEGIN
  SELECT trigger_name,trigger_mode INTO v_trigger_name,v_trigger_mode
  FROM public.companion_turns
  WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_run_id;
  IF v_trigger_name IS NOT NULL AND v_trigger_mode IS DISTINCT FROM p_mode::text THEN
    RAISE EXCEPTION 'trigger surface mode does not match its configured mode' USING ERRCODE='22023';
  END IF;
  v_result:=public.companion_runtime_surface_isolated_return_internal(
    p_org_id,p_companion_id,p_run_id,p_mode,p_message
  );
  IF v_result AND v_trigger_name IS NOT NULL AND p_mode='relay' THEN
    SELECT relay_turn_id INTO v_relay_turn_id FROM public.companion_routine_returns
    WHERE org_id=p_org_id AND companion_id=p_companion_id AND run_id=p_run_id;
    UPDATE public.companion_transcript_entries e
    SET content='A webhook trigger surfaced the next Companion entry. Read it and respond to that entry.'
    FROM public.companion_turns t
    WHERE t.org_id=p_org_id AND t.companion_id=p_companion_id AND t.id=v_relay_turn_id
      AND e.org_id=t.org_id AND e.companion_id=t.companion_id AND e.event_id=t.message_event_id;
  END IF;
  RETURN v_result;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_runtime_get_trigger_material(
  p_org_id uuid,p_companion_id uuid,p_claim_token uuid,p_claim_epoch bigint,p_gate_epoch bigint,
  p_executor_id text,p_work_kind public.companion_runtime_work_kind,p_work_id uuid,p_lease_seconds integer
)
RETURNS TABLE(trigger_name text,trigger_mode text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on
AS $$
DECLARE v_authorization record; v_turn_id uuid;
BEGIN
  SELECT * INTO v_authorization FROM public.companion_runtime_renew_and_authorize(
    p_org_id,p_companion_id,p_claim_token,p_claim_epoch,p_gate_epoch,p_executor_id,p_work_kind,p_work_id,p_lease_seconds
  );
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized,false) THEN RETURN; END IF;
  v_turn_id:=v_authorization.turn_id;
  RETURN QUERY SELECT t.trigger_name,t.trigger_mode
  FROM (SELECT 1) a
  LEFT JOIN public.companion_turns t
    ON t.org_id=p_org_id AND t.companion_id=p_companion_id AND t.id=v_turn_id;
END $$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_update_trigger(
  p_org_id uuid, p_companion_id uuid, p_trigger_id uuid, p_name text, p_prompt text,
  p_mode text, p_provider text, p_provider_account_id uuid, p_target jsonb, p_enabled boolean
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = on
AS $$
DECLARE
  v_name text:=btrim(p_name); v_prompt text:=btrim(p_prompt);
  v_trigger public.companion_triggers%ROWTYPE; v_account_id uuid:=p_provider_account_id;
  v_changed boolean; v_count integer;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  IF p_trigger_id IS NULL OR char_length(v_name) NOT BETWEEN 1 AND 80 OR v_name ~ E'[\n\r]'
     OR char_length(v_prompt) NOT BETWEEN 1 AND 16384 OR p_mode NOT IN ('notify','relay')
     OR p_provider NOT IN ('webhook','linear','github','sentry','custom')
     OR p_target IS NULL OR jsonb_typeof(p_target)<>'object' OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'invalid Companion trigger' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_trigger FROM public.companion_triggers
   WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_trigger_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Companion trigger not found' USING ERRCODE='P0002'; END IF;
  IF p_provider IN ('github','linear','sentry') AND v_account_id IS NULL THEN
    SELECT CASE WHEN count(*)=1 THEN min(a.id::text)::uuid ELSE NULL END, count(*)::integer
      INTO v_account_id, v_count
    FROM public.companion_trigger_provider_accounts a
    WHERE a.org_id=p_org_id AND a.owner_id=public.companion_api_actor(p_org_id)
      AND a.provider=p_provider AND a.status='connected';
    IF v_count > 1 THEN
      RAISE EXCEPTION 'multiple trigger provider accounts are eligible; choose provider_account_id'
        USING ERRCODE='22023';
    END IF;
  END IF;
  IF v_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.companion_trigger_provider_accounts a
    WHERE a.org_id=p_org_id AND a.owner_id=public.companion_api_actor(p_org_id)
      AND a.id=v_account_id AND a.provider=p_provider AND a.status='connected'
  ) THEN RAISE EXCEPTION 'trigger provider account is not connected for this member' USING ERRCODE='42501'; END IF;
  v_changed := v_trigger.provider IS DISTINCT FROM p_provider
    OR v_trigger.provider_account_id IS DISTINCT FROM v_account_id
    OR v_trigger.target IS DISTINCT FROM p_target;
  UPDATE public.companion_triggers SET name=v_name,prompt=v_prompt,mode=p_mode,provider=p_provider,
    provider_account_id=v_account_id,target=p_target,enabled=p_enabled,
    remote_hook_id=CASE WHEN v_changed THEN NULL ELSE remote_hook_id END,
    remote_hook_account_id=CASE WHEN v_changed THEN NULL ELSE remote_hook_account_id END,
    registration_status=CASE WHEN v_changed AND p_provider IN ('github','linear','sentry')
      THEN 'unregistered' WHEN v_changed THEN 'manual' ELSE registration_status END,
    last_registration_error=CASE WHEN v_changed THEN NULL ELSE last_registration_error END,
    last_error_code=NULL,last_error_message=NULL,last_error_at=NULL,consecutive_failures=0,
    updated_at=clock_timestamp()
  WHERE org_id=p_org_id AND companion_id=p_companion_id AND id=p_trigger_id;
  RETURN public.companion_api_trigger_json(p_org_id,p_companion_id,p_trigger_id,true);
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_api_answer_trigger_decision(
  p_org_id uuid,p_companion_id uuid,p_request_key text,p_action text,p_trigger_id uuid,p_secret text
)
RETURNS TABLE(delivery_id uuid,turn_id uuid,decision_status public.companion_decision_status,
  delivery_state public.companion_decision_delivery_state,responded_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET row_security=on
AS $$
DECLARE
  v_actor_id text:=public.companion_api_actor(p_org_id); v_actor_name text;
  v_delivery public.companion_decision_deliveries%ROWTYPE;
  v_status public.companion_decision_status; v_event_id text; v_now timestamptz:=clock_timestamp();
  v_proposal jsonb; v_name text; v_prompt text; v_mode text; v_provider text; v_account_id uuid;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id,p_companion_id,'editor');
  IF p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 1 AND 200
    OR p_request_key~E'[\n\r]' OR p_action NOT IN ('allow','deny')
    OR (p_action='allow' AND (p_trigger_id IS NULL OR p_secret !~ '^[0-9a-f]{32,128}$')) THEN
    RAISE EXCEPTION 'invalid Companion trigger proposal' USING ERRCODE='22023';
  END IF;
  SELECT d.* INTO v_delivery FROM public.companion_decision_deliveries d
  JOIN public.companion_turn_attempts a ON a.org_id=d.org_id AND a.companion_id=d.companion_id AND a.id=d.attempt_id
  WHERE d.org_id=p_org_id AND d.companion_id=p_companion_id AND d.request_key=p_request_key
    AND d.decision_status='pending' AND a.status='needs_input'
  ORDER BY d.created_at DESC,d.id DESC LIMIT 1 FOR UPDATE OF d;
  IF NOT FOUND THEN
    SELECT * INTO v_delivery FROM public.companion_decision_deliveries d
    WHERE d.org_id=p_org_id AND d.companion_id=p_companion_id AND d.request_key=p_request_key
      AND d.actor_id=v_actor_id ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
    IF NOT FOUND OR v_delivery.request_kind<>'trigger_proposal' OR NOT (
      (p_action='allow' AND v_delivery.decision_status='allowed') OR
      (p_action='deny' AND v_delivery.decision_status='denied')) THEN
      RAISE EXCEPTION 'Companion decision is not pending' USING ERRCODE='55000';
    END IF;
    RETURN QUERY SELECT v_delivery.id,v_delivery.turn_id,v_delivery.decision_status,
      v_delivery.delivery_state,v_delivery.responded_at; RETURN;
  END IF;
  IF v_delivery.request_kind<>'trigger_proposal' OR v_delivery.expires_at<=v_now THEN
    RAISE EXCEPTION 'Companion trigger proposal is not answerable' USING ERRCODE='55000';
  END IF;
  v_proposal:=v_delivery.proposal;
  IF v_proposal IS NULL OR jsonb_typeof(v_proposal)<>'object' OR v_proposal->>'kind'<>'trigger'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_proposal) k
      WHERE k NOT IN ('kind','name','prompt','mode','provider','provider_account_id','target')) THEN
    RAISE EXCEPTION 'invalid Companion trigger proposal' USING ERRCODE='22023';
  END IF;
  v_name:=btrim(v_proposal->>'name'); v_prompt:=btrim(v_proposal->>'prompt');
  v_mode:=COALESCE(v_proposal->>'mode','relay'); v_provider:=COALESCE(v_proposal->>'provider','webhook');
  BEGIN v_account_id:=NULLIF(v_proposal->>'provider_account_id','')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid Companion trigger proposal' USING ERRCODE='22023'; END;
  IF char_length(v_name) NOT BETWEEN 1 AND 80 OR v_name~E'[\n\r]'
    OR char_length(v_prompt) NOT BETWEEN 1 AND 16384 OR v_mode NOT IN ('notify','relay')
    OR v_provider NOT IN ('webhook','linear','github','sentry','custom') THEN
    RAISE EXCEPTION 'invalid Companion trigger proposal' USING ERRCODE='22023';
  END IF;
  IF p_action='allow' THEN
    PERFORM public.companion_api_create_trigger(p_org_id,p_companion_id,p_trigger_id,v_name,v_prompt,
      v_mode,v_provider,v_account_id,COALESCE(v_proposal->'target','{}'::jsonb),p_secret,true);
  END IF;
  v_status:=CASE p_action WHEN 'allow' THEN 'allowed'::public.companion_decision_status
    ELSE 'denied'::public.companion_decision_status END;
  UPDATE public.companion_decision_deliveries d SET decision_status=v_status,actor_id=v_actor_id,
    response_text=NULL,responded_at=v_now,updated_at=v_now
  WHERE d.id=v_delivery.id AND d.org_id=p_org_id AND d.companion_id=p_companion_id
    AND d.decision_status='pending' RETURNING d.* INTO v_delivery;
  IF NOT FOUND THEN RAISE EXCEPTION 'Companion decision changed concurrently' USING ERRCODE='40001'; END IF;
  SELECT COALESCE(p.name,u.name,u.email) INTO v_actor_name FROM public."user" u
    LEFT JOIN public.profiles p ON p.id=u.id WHERE u.id=v_actor_id;
  SELECT e.event_id INTO v_event_id FROM public.companion_transcript_entries e
  WHERE e.org_id=p_org_id AND e.companion_id=p_companion_id AND e.role='decision'
    AND e.decision->>'request_id'=p_request_key AND e.decision->>'status'='pending'
  ORDER BY e.ordinal DESC LIMIT 1 FOR UPDATE;
  IF v_event_id IS NULL THEN RAISE EXCEPTION 'Companion decision transcript projection is missing' USING ERRCODE='55000'; END IF;
  UPDATE public.companion_transcript_entries e SET decision=e.decision||jsonb_build_object(
    'status',v_status,'answer',NULL,'decided_by_id',v_actor_id,'decided_by_name',v_actor_name,
    'decided_at',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
  WHERE e.org_id=p_org_id AND e.companion_id=p_companion_id AND e.event_id=v_event_id;
  RETURN QUERY SELECT v_delivery.id,v_delivery.turn_id,v_delivery.decision_status,
    v_delivery.delivery_state,v_delivery.responded_at;
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_create_trigger(uuid,uuid,uuid,text,text,text,text,uuid,jsonb,text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_update_trigger(uuid,uuid,uuid,text,text,text,text,uuid,jsonb,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_trigger_run_json(uuid,uuid,uuid,boolean,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_trigger_run_summary_json(uuid,uuid,uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_list_trigger_runs(uuid,uuid,uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_get_trigger_run(uuid,uuid,uuid,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_runtime_get_trigger_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) FROM PUBLIC;
--> statement-breakpoint

DO $trigger_v2_api_acl$
DECLARE v_source oid:=to_regprocedure('public.companion_api_read_thread(uuid,uuid)'); v_grantee oid; v_role name;
BEGIN
  FOR v_grantee IN SELECT DISTINCT acl.grantee FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.oid=v_source AND acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner
  LOOP
    SELECT rolname INTO v_role FROM pg_roles WHERE oid=v_grantee;
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_create_trigger(uuid,uuid,uuid,text,text,text,text,uuid,jsonb,text,boolean) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_update_trigger(uuid,uuid,uuid,text,text,text,text,uuid,jsonb,boolean) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_list_trigger_runs(uuid,uuid,uuid,uuid,integer) TO %I',v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_get_trigger_run(uuid,uuid,uuid,integer,integer) TO %I',v_role);
  END LOOP;
END $trigger_v2_api_acl$;
--> statement-breakpoint

DO $trigger_v2_runtime_acl$
DECLARE v_source oid:=to_regprocedure('public.companion_runtime_get_routine_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'); v_grantee oid; v_role name;
BEGIN
  FOR v_grantee IN SELECT DISTINCT acl.grantee FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.oid=v_source AND acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner
  LOOP
    SELECT rolname INTO v_role FROM pg_roles WHERE oid=v_grantee;
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_runtime_get_trigger_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) TO %I',v_role);
  END LOOP;
END $trigger_v2_runtime_acl$;
