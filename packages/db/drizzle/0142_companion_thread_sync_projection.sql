-- Background revalidation and transcript prefetch must not mark a Companion thread as read. Clone
-- the canonical thread projection so future projection fields stay identical while replacing only
-- the member-watermark mutation with a side-effect-free lookup.
DO $companion_thread_sync_projection$
DECLARE
  v_source_signature text := 'public.companion_api_read_thread(uuid,uuid)';
  v_definition text := pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(v_source_signature)
  );
  v_old_name text := 'CREATE OR REPLACE FUNCTION public.companion_api_read_thread(';
  v_new_name text := 'CREATE OR REPLACE FUNCTION public.companion_api_sync_thread(';
  v_old_read text := $body$  SELECT marked.previous_last_read_ordinal, marked.last_read_ordinal
  INTO v_previous, v_marked
  FROM public.companion_api_mark_thread_read(p_org_id, p_companion_id) marked;$body$;
  v_new_read text := $body$  SELECT member_state.last_read_ordinal, member_state.last_read_ordinal
  INTO v_previous, v_marked
  FROM public.companion_member_state member_state
  WHERE member_state.org_id = p_org_id
    AND member_state.companion_id = p_companion_id
    AND member_state.user_id = public.companion_api_actor(p_org_id);$body$;
  v_name_count integer;
  v_read_count integer;
BEGIN
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Companion API thread surface is missing' USING ERRCODE = '55000';
  END IF;
  v_name_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old_name, ''))
  ) / char_length(v_old_name);
  v_read_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old_read, ''))
  ) / char_length(v_old_read);
  IF v_name_count <> 1 OR v_read_count <> 1 THEN
    RAISE EXCEPTION 'thread sync projection rewrite matched name %, read %, expected 1 each',
      v_name_count, v_read_count
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(replace(v_definition, v_old_name, v_new_name), v_old_read, v_new_read);
END
$companion_thread_sync_projection$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_sync_thread(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint

-- Mirror only explicit non-owner callers of the existing projection. runtime-role-grants.sql
-- separately reasserts the deployment-role split on every setup.
DO $companion_thread_sync_projection_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure('public.companion_api_read_thread(uuid,uuid)');
  v_grantee oid;
  v_role name;
BEGIN
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Companion API thread surface is missing' USING ERRCODE = '55000';
  END IF;
  FOR v_grantee IN
    SELECT DISTINCT acl.grantee
    FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
    ) acl
    WHERE source_proc.oid = v_source
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> source_proc.proowner
  LOOP
    SELECT rolname INTO v_role FROM pg_catalog.pg_roles WHERE oid = v_grantee;
    IF v_role IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.companion_api_sync_thread(uuid,uuid) TO %I',
        v_role
      );
    END IF;
  END LOOP;
END
$companion_thread_sync_projection_acl$;
