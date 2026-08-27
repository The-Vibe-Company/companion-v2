-- Wave A iOS organization: owner-scoped roster sections. These are control-plane metadata only;
-- assigning a Companion never advances a runtime revision or contacts Box/Pi.
CREATE TABLE public.companion_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  name text NOT NULL,
  position integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT companion_sections_org_owner_id_uq UNIQUE (org_id, owner_id, id),
  CONSTRAINT companion_sections_owner_membership_fk
    FOREIGN KEY (org_id, owner_id) REFERENCES public.memberships(org_id, user_id),
  CONSTRAINT companion_sections_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 80 AND name !~ E'[\n\r]'),
  CONSTRAINT companion_sections_position_check CHECK (position >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX companion_sections_owner_name_uq
  ON public.companion_sections (org_id, owner_id, lower(name));
--> statement-breakpoint
CREATE INDEX companion_sections_owner_position_idx
  ON public.companion_sections (org_id, owner_id, position);
--> statement-breakpoint
ALTER TABLE public.companion_sections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_sections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "companion_sections_function_owner_rls"
  ON public.companion_sections FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT procedure.proowner FROM pg_proc procedure
    WHERE procedure.oid = 'public.companion_api_actor(uuid)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT procedure.proowner FROM pg_proc procedure
    WHERE procedure.oid = 'public.companion_api_actor(uuid)'::regprocedure
  )));
--> statement-breakpoint
REVOKE ALL ON TABLE public.companion_sections FROM PUBLIC;
--> statement-breakpoint

ALTER TABLE public.companions ADD COLUMN section_id uuid;
--> statement-breakpoint
ALTER TABLE public.companion_member_state
  ADD COLUMN muted boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE public.companions
  ADD CONSTRAINT companions_section_fk
  FOREIGN KEY (org_id, owner_id, section_id)
  REFERENCES public.companion_sections(org_id, owner_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX companions_section_idx ON public.companions (org_id, section_id);
--> statement-breakpoint

CREATE FUNCTION public.companion_api_list_sections(p_org_id uuid)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  owner_id text,
  name text,
  "position" integer,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
BEGIN
  RETURN QUERY
  SELECT section.id, section.org_id, section.owner_id, section.name, section.position,
    section.created_at, section.updated_at
  FROM public.companion_sections section
  WHERE section.org_id = p_org_id
    AND (
      section.owner_id = v_actor_id
      OR EXISTS (
        SELECT 1
        FROM public.companions companion
        LEFT JOIN public.companion_workspace_access access
          ON access.org_id = companion.org_id AND access.companion_id = companion.id
        WHERE companion.org_id = p_org_id
          AND companion.section_id = section.id
          AND (companion.owner_id = v_actor_id OR access.role IS NOT NULL)
      )
    )
  ORDER BY section.owner_id = v_actor_id DESC, section.position, lower(section.name), section.id;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_create_section(p_org_id uuid, p_name text)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  owner_id text,
  name text,
  "position" integer,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_id uuid := gen_random_uuid();
  v_position integer;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 80 OR p_name ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid Companion section name' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(max(section.position) + 1, 0) INTO v_position
  FROM public.companion_sections section
  WHERE section.org_id = p_org_id AND section.owner_id = v_actor_id;

  INSERT INTO public.companion_sections(
    id, org_id, owner_id, name, position, created_at, updated_at
  ) VALUES (
    v_id, p_org_id, v_actor_id, btrim(p_name), v_position, v_now, v_now
  );
  INSERT INTO public.audit_log(org_id, actor_id, action, target_type, target_id, metadata)
  VALUES (p_org_id, v_actor_id, 'companion.section.created', 'companion_section', v_id::text,
    jsonb_build_object('name', btrim(p_name)));
  RETURN QUERY SELECT v_id, p_org_id, v_actor_id, btrim(p_name), v_position, v_now, v_now;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_update_section(
  p_org_id uuid,
  p_section_id uuid,
  p_name text
)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  owner_id text,
  name text,
  "position" integer,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_section public.companion_sections%ROWTYPE;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 80 OR p_name ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid Companion section name' USING ERRCODE = '22023';
  END IF;
  UPDATE public.companion_sections section
  SET name = btrim(p_name), updated_at = v_now
  WHERE section.id = p_section_id AND section.org_id = p_org_id AND section.owner_id = v_actor_id
  RETURNING section.* INTO v_section;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Companion section not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.audit_log(org_id, actor_id, action, target_type, target_id, metadata)
  VALUES (p_org_id, v_actor_id, 'companion.section.updated', 'companion_section', p_section_id::text,
    jsonb_build_object('name', v_section.name));
  RETURN QUERY SELECT v_section.id, v_section.org_id, v_section.owner_id, v_section.name,
    v_section.position, v_section.created_at, v_section.updated_at;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_delete_section(p_org_id uuid, p_section_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_unassigned integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.companion_sections section
    WHERE section.id = p_section_id AND section.org_id = p_org_id AND section.owner_id = v_actor_id
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'Companion section not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.companions companion
  SET section_id = NULL
  WHERE companion.org_id = p_org_id AND companion.owner_id = v_actor_id
    AND companion.section_id = p_section_id;
  GET DIAGNOSTICS v_unassigned = ROW_COUNT;
  DELETE FROM public.companion_sections section
  WHERE section.id = p_section_id AND section.org_id = p_org_id AND section.owner_id = v_actor_id;
  INSERT INTO public.audit_log(org_id, actor_id, action, target_type, target_id, metadata)
  VALUES (p_org_id, v_actor_id, 'companion.section.deleted', 'companion_section', p_section_id::text,
    jsonb_build_object('unassigned_companions', v_unassigned));
  RETURN v_unassigned;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_reorder_sections(p_org_id uuid, p_section_ids jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_owned_count integer;
  v_input_count integer;
BEGIN
  IF p_section_ids IS NULL OR jsonb_typeof(p_section_ids) <> 'array'
     OR jsonb_array_length(p_section_ids) > 100 THEN
    RAISE EXCEPTION 'invalid Companion section order' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_owned_count FROM public.companion_sections section
  WHERE section.org_id = p_org_id AND section.owner_id = v_actor_id;
  SELECT count(DISTINCT value) INTO v_input_count FROM jsonb_array_elements_text(p_section_ids);
  IF v_input_count <> v_owned_count OR jsonb_array_length(p_section_ids) <> v_owned_count
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(p_section_ids) value
       WHERE NOT EXISTS (
         SELECT 1 FROM public.companion_sections section
         WHERE section.id = value::uuid AND section.org_id = p_org_id
           AND section.owner_id = v_actor_id
       )
     ) THEN
    RAISE EXCEPTION 'section order must contain every owned section exactly once'
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.companion_sections section
  SET position = ordered.ordinality - 1, updated_at = clock_timestamp()
  FROM jsonb_array_elements_text(p_section_ids) WITH ORDINALITY ordered(id, ordinality)
  WHERE section.id = ordered.id::uuid AND section.org_id = p_org_id
    AND section.owner_id = v_actor_id;
  INSERT INTO public.audit_log(org_id, actor_id, action, target_type, target_id, metadata)
  VALUES (p_org_id, v_actor_id, 'companion.sections.reordered', 'companion_section', v_actor_id,
    jsonb_build_object('section_ids', p_section_ids));
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_assign_section(
  p_org_id uuid,
  p_companion_id uuid,
  p_section_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_owner_id text;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'owner');
  SELECT companion.owner_id INTO STRICT v_owner_id
  FROM public.companions companion
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id;
  IF v_owner_id <> v_actor_id OR (p_section_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.companion_sections section
    WHERE section.id = p_section_id AND section.org_id = p_org_id
      AND section.owner_id = v_owner_id
  )) THEN
    RAISE EXCEPTION 'Companion section not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.companions companion
  SET section_id = p_section_id
  WHERE companion.org_id = p_org_id AND companion.id = p_companion_id;
  INSERT INTO public.audit_log(org_id, actor_id, action, target_type, target_id, metadata)
  VALUES (p_org_id, v_actor_id, 'companion.section.assigned', 'companion', p_companion_id::text,
    jsonb_build_object('section_id', p_section_id));
  RETURN p_section_id;
END
$$;
--> statement-breakpoint

-- Preserve the established member-state function for rolling clients while adding the Wave A
-- mute preference. Mute is member-private and suppresses future APNs deliveries only; it does not
-- alter the thread, unread watermark, runtime state, or another member's notifications.
CREATE FUNCTION public.companion_api_update_member_state_v2(
  p_org_id uuid,
  p_companion_id uuid,
  p_pinned boolean,
  p_hidden boolean,
  p_muted boolean,
  p_unread boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'read');
  IF p_pinned IS NULL AND p_hidden IS NULL AND p_muted IS NULL AND p_unread IS NULL THEN
    RAISE EXCEPTION 'at least one member-state setting is required' USING ERRCODE = '22023';
  END IF;

  IF p_pinned IS NOT NULL OR p_hidden IS NOT NULL OR p_unread IS NOT NULL THEN
    PERFORM 1 FROM public.companion_api_update_member_state(
      p_org_id, p_companion_id, p_pinned, p_hidden, p_unread
    );
  END IF;

  IF p_muted IS NOT NULL THEN
    -- Enqueue takes the same transaction-scoped lock before it checks mute state. This makes the
    -- state update plus queued-delivery cleanup linearizable with concurrent notification inserts:
    -- an enqueue either commits before this delete or observes the committed muted row afterward.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'companion-notification:member:' || p_org_id::text || ':' || p_companion_id::text || ':' ||
        v_actor_id,
      0
    ));

    INSERT INTO public.companion_member_state(
      org_id, companion_id, user_id, muted, created_at, updated_at
    ) VALUES (
      p_org_id, p_companion_id, v_actor_id, p_muted, v_now, v_now
    )
    ON CONFLICT (companion_id, user_id) DO UPDATE
    SET muted = EXCLUDED.muted, updated_at = EXCLUDED.updated_at
    WHERE companion_member_state.org_id = EXCLUDED.org_id;

    IF p_muted THEN
      DELETE FROM public.companion_notification_deliveries delivery
      WHERE delivery.org_id = p_org_id
        AND delivery.companion_id = p_companion_id
        AND delivery.recipient_user_id = v_actor_id;
    END IF;
  END IF;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_notification_enqueue(
  p_org_id uuid,
  p_companion_id uuid,
  p_recipient_user_id text,
  p_event_key text,
  p_event public.companion_notification_event,
  p_title text,
  p_body text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_title text := left(btrim(regexp_replace(COALESCE(p_title, ''), E'[\\s]+', ' ', 'g')), 180);
  v_body text := left(btrim(regexp_replace(COALESCE(p_body, ''), E'[\\s]+', ' ', 'g')), 180);
  v_now timestamp with time zone := clock_timestamp();
  v_inserted integer;
BEGIN
  IF p_event_key IS NULL OR char_length(p_event_key) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid notification event key' USING ERRCODE = '22023';
  END IF;
  IF v_title = '' THEN v_title := 'Companion update'; END IF;
  IF v_body = '' THEN v_body := 'Open the conversation for details.'; END IF;

  -- Serialize with member mute changes so an enqueue cannot snapshot the old preference and then
  -- commit a delivery after the mute transaction has already deleted its visible queue entries.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'companion-notification:member:' || p_org_id::text || ':' || p_companion_id::text || ':' ||
      p_recipient_user_id,
    0
  ));

  INSERT INTO public.companion_notification_deliveries(
    org_id, device_id, companion_id, recipient_user_id, event_key, event,
    title, body, available_at, expires_at, created_at, updated_at
  )
  SELECT device.org_id, device.id, p_companion_id, p_recipient_user_id, p_event_key,
         p_event, v_title, v_body, v_now, v_now + interval '24 hours', v_now, v_now
  FROM public.companion_notification_devices device
  WHERE device.org_id = p_org_id
    AND device.user_id = p_recipient_user_id
    AND device.disabled_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.companion_member_state state
      WHERE state.org_id = p_org_id
        AND state.companion_id = p_companion_id
        AND state.user_id = p_recipient_user_id
        AND state.muted
    )
  ON CONFLICT (device_id, event_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_list_sections(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_create_section(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_update_section(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_delete_section(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_reorder_sections(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_assign_section(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_update_member_state_v2(
  uuid,uuid,boolean,boolean,boolean,boolean
) FROM PUBLIC;
--> statement-breakpoint

DO $grant_companion_sections$
DECLARE
  v_api_role text := current_setting('app.companion_api_role', true);
BEGIN
  IF v_api_role IS NOT NULL AND v_api_role <> '' THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_list_sections(uuid) TO %I', v_api_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_create_section(uuid,text) TO %I', v_api_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_update_section(uuid,uuid,text) TO %I', v_api_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_delete_section(uuid,uuid) TO %I', v_api_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_reorder_sections(uuid,jsonb) TO %I', v_api_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.companion_api_assign_section(uuid,uuid,uuid) TO %I', v_api_role);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.companion_api_update_member_state_v2('
      || 'uuid,uuid,boolean,boolean,boolean,boolean) TO %I',
      v_api_role
    );
  END IF;
END
$grant_companion_sections$;
