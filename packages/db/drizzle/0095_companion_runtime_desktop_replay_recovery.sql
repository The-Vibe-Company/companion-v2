-- Forward recovery for databases whose Drizzle ledger already recorded the former 0093 cutover
-- timestamp before the desktop replay objects existed. Drizzle skips every migration with an older
-- timestamp, so the pre-cutover 0093 repair alone cannot reach that state. Keep this migration
-- idempotent: fresh and ordinary upgrade paths have already installed these objects in 0093.

CREATE TABLE IF NOT EXISTS public.companion_runtime_desktop_requests (
  request_id text PRIMARY KEY,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT companion_runtime_desktop_requests_id_check
    CHECK (request_id ~ '^[A-Za-z0-9._:-]{16,128}$'),
  CONSTRAINT companion_runtime_desktop_requests_expiry_check
    CHECK (expires_at > created_at - interval '5 minutes')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS companion_runtime_desktop_requests_expiry_idx
  ON public.companion_runtime_desktop_requests(expires_at);
--> statement-breakpoint

ALTER TABLE public.companion_runtime_desktop_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_runtime_desktop_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS companion_runtime_desktop_requests_function_owner_rls
  ON public.companion_runtime_desktop_requests;
--> statement-breakpoint
CREATE POLICY companion_runtime_desktop_requests_function_owner_rls
  ON public.companion_runtime_desktop_requests FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.companion_runtime_consume_desktop_request(
  p_request_id text,
  p_timestamp bigint,
  p_max_skew_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_now_seconds bigint;
BEGIN
  IF p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9._:-]{16,128}$'
     OR p_timestamp IS NULL OR p_timestamp NOT BETWEEN 0 AND 253402300799
     OR p_max_skew_seconds IS NULL OR p_max_skew_seconds NOT BETWEEN 1 AND 300 THEN
    RETURN false;
  END IF;
  v_now_seconds := floor(extract(epoch FROM v_now))::bigint;
  IF abs(v_now_seconds - p_timestamp) > p_max_skew_seconds THEN
    RETURN false;
  END IF;

  DELETE FROM public.companion_runtime_desktop_requests request
  WHERE request.expires_at <= v_now;
  INSERT INTO public.companion_runtime_desktop_requests(request_id, expires_at, created_at)
  VALUES (
    p_request_id,
    GREATEST(
      to_timestamp(p_timestamp + p_max_skew_seconds),
      v_now + interval '1 second'
    ),
    v_now
  )
  ON CONFLICT (request_id) DO NOTHING;
  RETURN FOUND;
END
$$;
--> statement-breakpoint

REVOKE ALL ON TABLE public.companion_runtime_desktop_requests FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_consume_desktop_request(text, bigint, integer)
  FROM PUBLIC;
--> statement-breakpoint

-- The broad split-role grant pass is deliberately never replayed after cutover. Recover only this
-- new function's EXECUTE ACL from two adjacent, already-audited runtime capabilities. Fail closed
-- unless both independently identify the same unprivileged executor and every recovered object is
-- still owned by the migration owner.
DO $companion_runtime_desktop_replay_acl$
DECLARE
  v_authorize_source regprocedure := pg_catalog.to_regprocedure(
    'public.companion_runtime_authorize_desktop(uuid,uuid,text)'
  );
  v_claim_source regprocedure := pg_catalog.to_regprocedure(
    'public.companion_runtime_claim_work(text,integer,integer,bigint)'
  );
  v_target regprocedure := pg_catalog.to_regprocedure(
    'public.companion_runtime_consume_desktop_request(text,bigint,integer)'
  );
  v_table regclass := pg_catalog.to_regclass('public.companion_runtime_desktop_requests');
  v_source regprocedure;
  v_source_owner oid;
  v_target_owner oid;
  v_table_owner oid;
  v_source_executor_oids oid[];
  v_executor_oid oid;
  v_executor_name name;
  v_can_login boolean;
  v_is_superuser boolean;
  v_bypass_rls boolean;
  v_inherits boolean;
  v_membership record;
  v_grantee name;
  v_column_grant record;
BEGIN
  IF v_authorize_source IS NULL OR v_claim_source IS NULL OR v_target IS NULL OR v_table IS NULL THEN
    RAISE EXCEPTION 'desktop replay ACL recovery requires the replay table and all runtime source functions'
      USING ERRCODE = '55000';
  END IF;

  SELECT target_proc.proowner INTO STRICT v_target_owner
  FROM pg_catalog.pg_proc target_proc WHERE target_proc.oid = v_target;
  SELECT table_class.relowner INTO STRICT v_table_owner
  FROM pg_catalog.pg_class table_class WHERE table_class.oid = v_table;
  IF v_target_owner <> current_user::regrole OR v_table_owner <> current_user::regrole THEN
    RAISE EXCEPTION 'desktop replay ACL recovery requires the migration owner to own the target function and table'
      USING ERRCODE = '55000';
  END IF;

  FOREACH v_source IN ARRAY ARRAY[v_authorize_source, v_claim_source]
  LOOP
    SELECT source_proc.proowner INTO STRICT v_source_owner
    FROM pg_catalog.pg_proc source_proc WHERE source_proc.oid = v_source;
    IF v_source_owner <> v_target_owner THEN
      RAISE EXCEPTION 'desktop replay ACL recovery requires one migration owner for every runtime function'
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc source_proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
      ) acl
      WHERE source_proc.oid = v_source
        AND acl.privilege_type = 'EXECUTE'
        AND (
          acl.grantee = 0
          OR (acl.grantee <> source_proc.proowner AND acl.is_grantable)
        )
    ) THEN
      RAISE EXCEPTION 'runtime source ACL is public or delegates grant authority: %', v_source
        USING ERRCODE = '55000';
    END IF;

    SELECT COALESCE(array_agg(DISTINCT acl.grantee ORDER BY acl.grantee), ARRAY[]::oid[])
    INTO v_source_executor_oids
    FROM pg_catalog.pg_proc source_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
    ) acl
    WHERE source_proc.oid = v_source
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> source_proc.proowner
      AND acl.grantee <> 0;
    IF cardinality(v_source_executor_oids) <> 1 THEN
      RAISE EXCEPTION 'runtime source ACL must name exactly one executor: %', v_source
        USING ERRCODE = '55000';
    END IF;
    IF v_executor_oid IS NULL THEN
      v_executor_oid := v_source_executor_oids[1];
    ELSIF v_executor_oid <> v_source_executor_oids[1] THEN
      RAISE EXCEPTION 'runtime source ACLs disagree on the executor'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  SELECT executor_role.rolname, executor_role.rolcanlogin, executor_role.rolsuper,
         executor_role.rolbypassrls, executor_role.rolinherit
  INTO STRICT v_executor_name, v_can_login, v_is_superuser, v_bypass_rls, v_inherits
  FROM pg_catalog.pg_roles executor_role WHERE executor_role.oid = v_executor_oid;
  IF NOT v_can_login OR v_is_superuser OR v_bypass_rls OR v_inherits THEN
    RAISE EXCEPTION 'desktop authorization executor must be LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT'
      USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.has_database_privilege(v_executor_name, current_database(), 'CREATE')
     OR pg_catalog.has_schema_privilege(v_executor_name, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'desktop authorization executor must not have database or public schema CREATE'
      USING ERRCODE = '55000';
  END IF;

  SELECT parent.rolname AS parent_role, member.rolname AS member_role
  INTO v_membership
  FROM pg_catalog.pg_auth_members membership
  JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
  JOIN pg_catalog.pg_roles member ON member.oid = membership.member
  WHERE membership.roleid = v_executor_oid OR membership.member = v_executor_oid
  ORDER BY parent.rolname, member.rolname
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'desktop authorization executor must have no role memberships'
      USING ERRCODE = '55000',
            DETAIL = format(
              'role membership %s -> %s would permit inherited privileges or SET ROLE',
              v_membership.member_role,
              v_membership.parent_role
            );
  END IF;

  FOR v_grantee IN
    SELECT DISTINCT grantee.rolname
    FROM pg_catalog.pg_class table_class
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(table_class.relacl, pg_catalog.acldefault('r', table_class.relowner))
    ) acl
    JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
    WHERE table_class.oid = 'public.companion_runtime_desktop_requests'::regclass
      AND acl.grantee <> table_class.relowner
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.companion_runtime_desktop_requests FROM %I',
      v_grantee
    );
  END LOOP;

  FOR v_column_grant IN
    SELECT attribute.attname AS column_name, acl.grantee, grantee.rolname AS grantee_name
    FROM pg_catalog.pg_attribute attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) acl
    LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
    WHERE attribute.attrelid = v_table
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl.grantee <> v_table_owner
    ORDER BY attribute.attnum, acl.grantee
  LOOP
    IF v_column_grant.grantee = 0 THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES (%I) ON TABLE public.companion_runtime_desktop_requests FROM PUBLIC',
        v_column_grant.column_name
      );
    ELSE
      EXECUTE format(
        'REVOKE ALL PRIVILEGES (%I) ON TABLE public.companion_runtime_desktop_requests FROM %I',
        v_column_grant.column_name,
        v_column_grant.grantee_name
      );
    END IF;
  END LOOP;

  FOR v_grantee IN
    SELECT DISTINCT grantee.rolname
    FROM pg_catalog.pg_proc target_proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(target_proc.proacl, pg_catalog.acldefault('f', target_proc.proowner))
    ) acl
    JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
    WHERE target_proc.oid = v_target
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> target_proc.proowner
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION public.companion_runtime_consume_desktop_request(text,bigint,integer) FROM %I',
      v_grantee
    );
  END LOOP;
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_consume_desktop_request(text,bigint,integer) TO %I',
    v_executor_name
  );
END
$companion_runtime_desktop_replay_acl$;
--> statement-breakpoint
