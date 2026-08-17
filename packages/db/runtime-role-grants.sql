\if :{?api_role}
SELECT set_config('companion.api_role', :'api_role', false);
\if :{?worker_role}
SELECT set_config('companion.worker_role', :'worker_role', false);
\if :{?companion_runtime_role}
SELECT set_config('companion.companion_runtime_role', :'companion_runtime_role', false);
\else
SELECT set_config('companion.companion_runtime_role', '', false);
\endif
\if :{?retired_runtime_role}
SELECT set_config('companion.retired_runtime_role', :'retired_runtime_role', false);
\endif
\else
  \echo 'worker_role psql variable is required when api_role is configured'
  \quit 1
\endif
\else
\if :{?companion_runtime_role}
  \echo 'companion_runtime_role requires api_role + worker_role and cannot accompany legacy runtime_role'
  \quit 1
\endif
\if :{?runtime_role}
-- Backward-compatible single-role mode for simple/local installations.
SELECT set_config('companion.companion_runtime_role', '', false);
SELECT set_config('companion.runtime_role', :'runtime_role', false);
\else
  \echo 'api_role + worker_role (or legacy runtime_role) psql variables are required'
  \quit 1
\endif
\endif

-- Run as the migration/table owner after every migration. The login role must already exist with
-- NOSUPERUSER, NOBYPASSRLS, NOINHERIT and no membership in the migration-owner role. Production
-- should provide distinct API and worker roles and may add a third, dedicated Companion runtime
-- role. The legacy runtime_role path intentionally grants the union of all three capability sets
-- to one role for backward-compatible simple/local installs, while retaining the v2 table fences.
-- The API migration runner executes the marked DO block directly; keep the markers and GUC hand-off.
-- companion-runtime-grants-begin
DO $companion_runtime_grants$
DECLARE
  legacy_role text := nullif(current_setting('companion.runtime_role', true), '');
  api_role text := coalesce(nullif(current_setting('companion.api_role', true), ''), legacy_role);
  worker_role text := coalesce(nullif(current_setting('companion.worker_role', true), ''), legacy_role);
  companion_runtime_role text := coalesce(
    nullif(current_setting('companion.companion_runtime_role', true), ''),
    legacy_role
  );
  retired_runtime_role text :=
    nullif(current_setting('companion.retired_runtime_role', true), '');
  configured_role text;
  function_grantee name;
  default_function_grantees name[] := ARRAY[]::name[];
  runtime_attributes record;
  runtime_membership record;
  protected_table regclass;
  protected_sequence regclass;
  active_roles text[] := array_remove(
    ARRAY[api_role, worker_role, companion_runtime_role],
    NULL
  );
  private_runtime_table_names text[] := ARRAY[
    'companion_runtime_control',
    'companion_runtime_instances',
    'companion_turns',
    'companion_turn_attempts',
    'companion_operations',
    'companion_decision_deliveries',
    'companion_runtime_leases',
    'companion_runtime_duplicate_cleanups',
    'companion_runtime_event_projections'
  ];
  legacy_companion_mutation_tables regclass[] := ARRAY[
    'public.companions'::regclass,
    'public.companion_runtime_pools'::regclass,
    'public.companion_workspace_access'::regclass,
    'public.companion_member_state'::regclass,
    'public.companion_threads'::regclass,
    'public.companion_transcript_entries'::regclass,
    'public.companion_reconcile_leases'::regclass
  ];
  api_unprotected_tables regclass[] := ARRAY[
    'public.account'::regclass,
    'public.agent'::regclass,
    'public.agent_auth_ephemeral'::regclass,
    'public.agent_capability_grant'::regclass,
    'public.agent_host'::regclass,
    'public.approval_request'::regclass,
    'public.profiles'::regclass,
    'public."session"'::regclass,
    'public."user"'::regclass,
    'public.verification'::regclass
  ];
  protected_function regprocedure;
  shared_functions regprocedure[] := ARRAY[
    'public.companion_secret_usage_count(uuid,uuid)'::regprocedure
  ];
  api_functions regprocedure[] := ARRAY[
    'public.companion_list_user_orgs(text)'::regprocedure,
    'public.companion_users_share_org(text,text)'::regprocedure,
    'public.companion_list_joinable_orgs(text)'::regprocedure,
    'public.companion_lock_invitation_for_actor(text,text)'::regprocedure,
    'public.companion_resolve_api_token(text)'::regprocedure,
    'public.companion_resolve_api_token(text,text)'::regprocedure,
    'public.companion_lock_api_token_for_refresh(text)'::regprocedure,
    'public.companion_public_skill_preview(text)'::regprocedure,
    'public.companion_authorize_public_skill_package(text,text,text)'::regprocedure,
    'public.companion_authorize_public_skill_package(text,text,text,text)'::regprocedure,
    'public.companion_issue_public_skill_transfer_ticket(text,text,text,text,text,text,timestamp with time zone)'::regprocedure,
    'public.companion_consume_public_skill_transfer_ticket(text,text,text)'::regprocedure,
    'public.companion_consume_agent_transfer_ticket(text,text,text,text,text,integer,text)'::regprocedure,
    'public.companion_preflight_agent_transfer_ticket(text,text,text,text)'::regprocedure,
    'public.companion_revalidate_agent_transfer_ticket(text)'::regprocedure,
    'public.companion_revoke_agent_transfer_tickets(text,text,text)'::regprocedure,
    'public.companion_skill_share_target(text,text)'::regprocedure,
    'public.companion_billing_org_for_stripe_event(text,text)'::regprocedure,
    'public.companion_revoke_inactive_skill_database_realm_shares(uuid,uuid)'::regprocedure,
    'public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone,integer,integer)'::regprocedure,
    'public.companion_delivery_read_fence(uuid,uuid,text)'::regprocedure,
    'public.companion_claim_delivery_lease(uuid,uuid,uuid,integer)'::regprocedure,
    'public.companion_release_delivery_lease(uuid,uuid,uuid)'::regprocedure,
    'public.companion_renew_delivery_lease(uuid,uuid,uuid,integer)'::regprocedure,
    'public.companion_accept_delivery_lease(uuid,uuid,uuid,integer,integer)'::regprocedure
  ];
  worker_functions regprocedure[] := ARRAY[
    'public.companion_claim_skill_database_object_deletions(integer,integer)'::regprocedure,
    'public.companion_complete_skill_database_object_deletion(text,uuid)'::regprocedure,
    'public.companion_defer_skill_database_object_deletion(text,uuid)'::regprocedure,
    'public.companion_list_billing_sync_candidates(timestamp with time zone,boolean,integer)'::regprocedure,
    'public.companion_claim_github_sync_destinations(text,integer,integer)'::regprocedure,
    'public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone,integer,integer)'::regprocedure,
    'public.companion_claim_reconcile_candidates(text,integer,integer,integer,integer)'::regprocedure,
    'public.companion_settle_reconcile_lease(uuid,uuid,text,text,integer)'::regprocedure
  ];
  -- The grants hook is also used by historical-migration tests and migration-first deploys. Keep
  -- the v2 lists empty until 0090's sentinel exists. Once it does, the exact casts below remain a
  -- fail-closed contract: a partial or drifted 0090 must fail instead of silently granting a subset.
  companion_runtime_functions regprocedure[] := ARRAY[]::regprocedure[];
  owner_only_runtime_functions regprocedure[] := ARRAY[]::regprocedure[];
  internal_runtime_functions regprocedure[] := ARRAY[]::regprocedure[];
  retired_companion_functions regprocedure[] := ARRAY[]::regprocedure[];
BEGIN
  IF api_role IS NULL OR worker_role IS NULL THEN
    RAISE EXCEPTION 'companion API and worker roles are required';
  END IF;
  IF legacy_role IS NULL AND api_role = worker_role THEN
    RAISE EXCEPTION 'companion API and worker roles must be distinct';
  END IF;
  IF retired_runtime_role IS NOT NULL
    AND retired_runtime_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'invalid retired companion runtime role';
  END IF;

  IF legacy_role IS NULL
    AND companion_runtime_role IS NOT NULL
    AND (companion_runtime_role = api_role OR companion_runtime_role = worker_role) THEN
    RAISE EXCEPTION 'companion API, worker, and dedicated runtime roles must be distinct';
  END IF;
  IF retired_runtime_role IS NOT NULL
    AND retired_runtime_role = ANY(active_roles) THEN
    RAISE EXCEPTION 'retired companion runtime role must be distinct from every active role';
  END IF;

  IF pg_catalog.to_regprocedure('public.companion_runtime_gate_status()') IS NOT NULL THEN
    companion_runtime_functions := ARRAY[
      'public.companion_runtime_gate_status()'::regprocedure,
      'public.companion_runtime_disable(bigint,text)'::regprocedure,
      'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure,
      'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure,
      'public.companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,timestamp with time zone,integer,integer,integer)'::regprocedure,
      'public.companion_runtime_observe_instance(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,bigint,text,public.companion_box_observed_state,public.companion_pi_observed_state,text,integer,bigint,integer,timestamp with time zone)'::regprocedure,
      'public.companion_runtime_settle(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,text,text,public.companion_runtime_error_action)'::regprocedure,
      'public.companion_runtime_release_lease(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)'::regprocedure
    ];
    owner_only_runtime_functions := ARRAY[
      'public.companion_runtime_enable(bigint,text)'::regprocedure
    ];
    internal_runtime_functions := ARRAY[
      'public.companion_runtime_create_lease_row()'::regprocedure,
      'public.companion_runtime_assert_v2_mutation()'::regprocedure,
      'public.companion_runtime_require_v2_mutation()'::regprocedure,
      'public.companion_runtime_fence_legacy_token()'::regprocedure,
      'public.companion_runtime_require_instance_at_commit()'::regprocedure,
      'public.companion_runtime_assign_turn_sequence()'::regprocedure,
      'public.companion_runtime_assign_operation_intent()'::regprocedure,
      'public.companion_runtime_assign_attempt_snapshot()'::regprocedure,
      'public.companion_runtime_reject_actor_change()'::regprocedure,
      'public.companion_runtime_reject_turn_surface_change()'::regprocedure,
      'public.companion_runtime_reject_attempt_snapshot_change()'::regprocedure,
      'public.companion_runtime_reject_operation_snapshot_change()'::regprocedure,
      'public.companion_runtime_reject_responder_change()'::regprocedure,
      'public.companion_runtime_close_attempt_decisions(uuid,uuid,uuid,text,text,public.companion_runtime_error_action,uuid)'::regprocedure
    ];
    retired_companion_functions := ARRAY[
      'public.companion_claim_delivery_lease(uuid,uuid,uuid,integer)'::regprocedure,
      'public.companion_release_delivery_lease(uuid,uuid,uuid)'::regprocedure,
      'public.companion_renew_delivery_lease(uuid,uuid,uuid,integer)'::regprocedure,
      'public.companion_accept_delivery_lease(uuid,uuid,uuid,integer,integer)'::regprocedure,
      'public.companion_expire_tool_runs(uuid,uuid,timestamp with time zone,integer,integer)'::regprocedure,
      'public.companion_claim_reconcile_candidates(text,integer,integer,integer,integer)'::regprocedure,
      'public.companion_settle_reconcile_lease(uuid,uuid,text,text,integer)'::regprocedure
    ];

    -- 0091 is additive and the hook is also replayed by historical-migration tests. Resolve its
    -- exact surface only when the migration sentinel exists; a partial 0091 remains fail closed.
    IF pg_catalog.to_regprocedure(
      'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'
    ) IS NOT NULL THEN
      companion_runtime_functions := companion_runtime_functions || ARRAY[
        'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'::regprocedure,
        'public.companion_runtime_get_attempt_terminal_projection(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)'::regprocedure,
        'public.companion_runtime_cas_mcp_oauth(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text)'::regprocedure,
        'public.companion_runtime_register_duplicate_cleanups(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text[])'::regprocedure,
        'public.companion_runtime_checkpoint_duplicate_cleanup(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,bigint,public.companion_duplicate_cleanup_status,text)'::regprocedure,
        'public.companion_runtime_authorize_desktop(uuid,uuid,text)'::regprocedure,
        'public.companion_runtime_project_event_batch(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer)'::regprocedure
      ];
      internal_runtime_functions := internal_runtime_functions || ARRAY[
        'public.companion_runtime_guard_duplicate_cleanup()'::regprocedure
      ];
    END IF;

    -- A migration owner can carry arbitrary ALTER DEFAULT PRIVILEGES grants installed by an
    -- earlier operator. Runtime v2 never relies on default function EXECUTE: erase every named
    -- non-owner grantee and PUBLIC before granting the exact executor surface below.
    SELECT COALESCE(array_agg(DISTINCT grantee.rolname), ARRAY[]::name[])
    INTO default_function_grantees
    FROM pg_catalog.pg_default_acl defaults
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) acl
    JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
    WHERE defaults.defaclrole = (
        SELECT owner.oid FROM pg_catalog.pg_roles owner WHERE owner.rolname = current_user
      )
      AND defaults.defaclnamespace IN (0, 'public'::regnamespace)
      AND defaults.defaclobjtype = 'f'
      AND acl.privilege_type = 'EXECUTE'
      AND grantee.rolname <> current_user;

    EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
    EXECUTE
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
    FOREACH function_grantee IN ARRAY default_function_grantees
    LOOP
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM %I',
        function_grantee
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
           REVOKE EXECUTE ON FUNCTIONS FROM %I',
        function_grantee
      );
    END LOOP;
  END IF;

  FOR configured_role IN
    SELECT DISTINCT role_name
    FROM unnest(active_roles) AS configured_roles(role_name)
  LOOP
    IF configured_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
      RAISE EXCEPTION 'invalid companion runtime role';
    END IF;

    SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolinherit
    INTO runtime_attributes
    FROM pg_catalog.pg_roles r
    WHERE r.rolname = configured_role;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'companion runtime role % does not exist', configured_role;
    END IF;
    IF NOT runtime_attributes.rolcanlogin
      OR runtime_attributes.rolsuper
      OR runtime_attributes.rolbypassrls
      OR runtime_attributes.rolinherit THEN
      RAISE EXCEPTION 'companion runtime role % must be LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT', configured_role;
    END IF;
    IF pg_catalog.pg_has_role(configured_role, current_user, 'member') THEN
      RAISE EXCEPTION 'companion runtime role % must not inherit the migration-owner role', configured_role;
    END IF;
  END LOOP;

  -- NOINHERIT does not prevent SET ROLE. Any direct edge in either direction lets an active login
  -- reach privileges that this grant pass cannot audit (or lets another login assume the active
  -- process role). Reject the whole role graph edge, not only memberships between the three named
  -- process roles. With no direct edge touching a process login, no transitive SET ROLE path can
  -- start from or terminate at that login.
  FOR configured_role IN
    SELECT DISTINCT role_name
    FROM unnest(active_roles) AS configured_roles(role_name)
  LOOP
    SELECT parent.rolname AS parent_role, member.rolname AS member_role
    INTO runtime_membership
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = membership.member
    WHERE membership.roleid = configured_role::regrole
       OR membership.member = configured_role::regrole
    ORDER BY parent.rolname, member.rolname
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'active companion database role % must have no role memberships', configured_role
        USING DETAIL = format(
          'role membership %s -> %s would permit inherited privileges or SET ROLE',
          runtime_membership.member_role,
          runtime_membership.parent_role
        );
    END IF;
  END LOOP;

  IF retired_runtime_role IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = retired_runtime_role
    ) THEN
      RAISE EXCEPTION 'retired companion runtime role % does not exist', retired_runtime_role;
    END IF;
    FOR configured_role IN
      SELECT DISTINCT role_name
      FROM unnest(active_roles) AS configured_roles(role_name)
    LOOP
      IF pg_catalog.pg_has_role(retired_runtime_role, configured_role, 'MEMBER')
        OR pg_catalog.pg_has_role(retired_runtime_role, configured_role, 'SET')
        OR pg_catalog.pg_has_role(configured_role, retired_runtime_role, 'MEMBER')
        OR pg_catalog.pg_has_role(configured_role, retired_runtime_role, 'SET') THEN
        RAISE EXCEPTION 'retired and active companion database roles must not have cross-role membership';
      END IF;
    END LOOP;
  END IF;

  IF api_role <> worker_role THEN

    -- A split-role application is also a downgrade pass for names reused from the legacy union
    -- topology. Clear every direct/current and future table or sequence grant first. The migration
    -- hook is rerun after each schema migration, so future tables fail closed until they either
    -- enable RLS or are deliberately added to a process-specific unprotected-table list.
    FOREACH configured_role IN ARRAY ARRAY[api_role, worker_role]
    LOOP
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), configured_role);
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', configured_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM %I',
        configured_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE USAGE, SELECT ON SEQUENCES FROM %I',
        configured_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
        configured_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
        configured_role
      );

      FOR protected_table IN
        SELECT table_class.oid::regclass
        FROM pg_catalog.pg_class table_class
        JOIN pg_catalog.pg_namespace table_namespace
          ON table_namespace.oid = table_class.relnamespace
        WHERE table_namespace.nspname = 'public'
          AND table_class.relkind IN ('r', 'p')
          AND table_class.relrowsecurity
          AND NOT (table_class.relname::text = ANY(private_runtime_table_names))
        ORDER BY table_class.oid
      LOOP
        EXECUTE format(
          'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO %I',
          protected_table,
          configured_role
        );
      END LOOP;
    END LOOP;

    IF companion_runtime_role IS NOT NULL THEN
      -- The dedicated executor reaches tenant/runtime state only through the fenced v2 functions.
      -- Clear capabilities first so reusing a former application login is a safe downgrade.
      EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO %I',
        current_database(),
        companion_runtime_role
      );
      EXECUTE format(
        'REVOKE CREATE ON DATABASE %I FROM %I',
        current_database(),
        companion_runtime_role
      );
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', companion_runtime_role);
      EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', companion_runtime_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM %I',
        companion_runtime_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE USAGE, SELECT ON SEQUENCES FROM %I',
        companion_runtime_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE EXECUTE ON FUNCTIONS FROM %I',
        companion_runtime_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
        companion_runtime_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
        companion_runtime_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I',
        companion_runtime_role
      );
    END IF;

    -- Better Auth, user profiles and Agent Auth are API-owned surfaces without RLS. Worker
    -- heartbeat tables are intentionally absent: both processes reach them only through the
    -- narrow SECURITY DEFINER readiness/heartbeat functions.
    FOREACH protected_table IN ARRAY api_unprotected_tables
    LOOP
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO %I',
        protected_table,
        api_role
      );
    END LOOP;

    -- Re-applying the split must also remove opposite-process SECURITY DEFINER capabilities.
    FOREACH protected_function IN ARRAY worker_functions
    LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', protected_function);
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        protected_function,
        api_role
      );
      IF companion_runtime_role IS NOT NULL THEN
        EXECUTE format(
          'REVOKE EXECUTE ON FUNCTION %s FROM %I',
          protected_function,
          companion_runtime_role
        );
      END IF;
    END LOOP;
    FOREACH protected_function IN ARRAY api_functions
    LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', protected_function);
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        protected_function,
        worker_role
      );
      IF companion_runtime_role IS NOT NULL THEN
        EXECUTE format(
          'REVOKE EXECUTE ON FUNCTION %s FROM %I',
          protected_function,
          companion_runtime_role
        );
      END IF;
    END LOOP;
  ELSE
    -- Backward-compatible simple installs deliberately retain one union role, including defaults.
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), api_role);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', api_role);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
      api_role
    );
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', api_role);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
      api_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT USAGE, SELECT ON SEQUENCES TO %I',
      api_role
    );
  END IF;

  -- No process role, including the local union fallback, receives direct access to Runtime v2
  -- state or to an identity/queue sequence owned by one of those tables. All mutations and reads
  -- cross a SECURITY DEFINER function that validates the lease epoch and current authority.
  FOR protected_table IN
    SELECT table_class.oid::regclass
    FROM pg_catalog.pg_class table_class
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_class.relnamespace
    WHERE table_namespace.nspname = 'public'
      AND table_class.relkind IN ('r', 'p')
      AND table_class.relname::text = ANY(private_runtime_table_names)
    ORDER BY table_class.oid
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC', protected_table);
    FOR configured_role IN
      SELECT DISTINCT role_name
      FROM unnest(active_roles) AS configured_roles(role_name)
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE %s FROM %I',
        protected_table,
        configured_role
      );
    END LOOP;
  END LOOP;

  FOR protected_sequence IN
    SELECT sequence_class.oid::regclass
    FROM pg_catalog.pg_class sequence_class
    JOIN pg_catalog.pg_namespace sequence_namespace
      ON sequence_namespace.oid = sequence_class.relnamespace
    JOIN pg_catalog.pg_depend sequence_dependency
      ON sequence_dependency.classid = 'pg_catalog.pg_class'::regclass
      AND sequence_dependency.refclassid = 'pg_catalog.pg_class'::regclass
      AND sequence_dependency.objid = sequence_class.oid
      AND sequence_dependency.deptype IN ('a', 'i')
    JOIN pg_catalog.pg_class owning_table
      ON owning_table.oid = sequence_dependency.refobjid
    JOIN pg_catalog.pg_namespace owning_namespace
      ON owning_namespace.oid = owning_table.relnamespace
    WHERE sequence_namespace.nspname = 'public'
      AND owning_namespace.nspname = 'public'
      AND sequence_class.relkind = 'S'
      AND owning_table.relname::text = ANY(private_runtime_table_names)
    ORDER BY sequence_class.oid
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM PUBLIC', protected_sequence);
    FOR configured_role IN
      SELECT DISTINCT role_name
      FROM unnest(active_roles) AS configured_roles(role_name)
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM %I',
        protected_sequence,
        configured_role
      );
    END LOOP;
  END LOOP;

  IF retired_runtime_role IS NOT NULL THEN
    -- This is intentionally explicit and one-way. It removes the old union login's current and
    -- future object capabilities; operators may ALTER ROLE ... NOLOGIN or DROP ROLE afterwards.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public
       REVOKE USAGE, SELECT ON SEQUENCES FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
      retired_runtime_role
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
      retired_runtime_role
    );
    EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', retired_runtime_role);
    EXECUTE format(
      'REVOKE CONNECT ON DATABASE %I FROM %I',
      current_database(),
      retired_runtime_role
    );
  END IF;

  -- Runtime v2 functions are private by construction. Scrub every directly recorded non-owner
  -- grantee, including roles unknown to this deployment configuration, before installing the one
  -- exact executor grant. This closes inherited migration-owner default ACLs as well as stale
  -- grants from an earlier operator. The legacy union role remains the executor only in the
  -- backward-compatible single-role mode.
  FOREACH protected_function IN ARRAY companion_runtime_functions
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', protected_function);
    FOR function_grantee IN
      SELECT DISTINCT grantee.rolname
      FROM pg_catalog.pg_proc protected_proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(protected_proc.proacl, pg_catalog.acldefault('f', protected_proc.proowner))
      ) acl
      JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
      WHERE protected_proc.oid = protected_function
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee <> protected_proc.proowner
    LOOP
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        protected_function,
        function_grantee
      );
    END LOOP;
    IF companion_runtime_role IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %s TO %I',
        protected_function,
        companion_runtime_role
      );
    END IF;
  END LOOP;

  -- Re-enable and trigger/helper functions are owner-only. They never receive an application-role
  -- grant; generic revocation prevents an unconfigured default grantee from reaching them.
  FOREACH protected_function IN ARRAY owner_only_runtime_functions || internal_runtime_functions
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', protected_function);
    FOR function_grantee IN
      SELECT DISTINCT grantee.rolname
      FROM pg_catalog.pg_proc protected_proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(protected_proc.proacl, pg_catalog.acldefault('f', protected_proc.proowner))
      ) acl
      JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
      WHERE protected_proc.oid = protected_function
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee <> protected_proc.proowner
    LOOP
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        protected_function,
        function_grantee
      );
    END LOOP;
  END LOOP;

  -- The skill-secret usage helper is needed by both process roles.
  FOREACH protected_function IN ARRAY shared_functions
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO %I',
      protected_function,
      api_role
    );
    IF worker_role <> api_role THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %s TO %I',
        protected_function,
        worker_role
      );
    END IF;
  END LOOP;

  -- Creator-scoped and pre-tenant service functions belong to the API role.
  -- companion_delivery_read_fence remains PUBLIC only across the migration-first compatibility
  -- handoff so old API transactions can evaluate the newly committed restrictive RLS policy. Move
  -- it to the configured API role in this same DO transaction; there is no permission-denied gap.
  REVOKE EXECUTE ON FUNCTION public.companion_delivery_read_fence(uuid, uuid, text)
    FROM PUBLIC;
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION
      public.companion_list_user_orgs(text),
      public.companion_users_share_org(text, text),
      public.companion_list_joinable_orgs(text),
      public.companion_lock_invitation_for_actor(text, text),
      public.companion_resolve_api_token(text),
      public.companion_resolve_api_token(text, text),
      public.companion_lock_api_token_for_refresh(text),
      public.companion_public_skill_preview(text),
      public.companion_authorize_public_skill_package(text, text, text),
      public.companion_authorize_public_skill_package(text, text, text, text),
      public.companion_issue_public_skill_transfer_ticket(text, text, text, text, text, text, timestamp with time zone),
      public.companion_consume_public_skill_transfer_ticket(text, text, text),
      public.companion_consume_agent_transfer_ticket(text, text, text, text, text, integer, text),
      public.companion_preflight_agent_transfer_ticket(text, text, text, text),
      public.companion_revalidate_agent_transfer_ticket(text),
      public.companion_revoke_agent_transfer_tickets(text, text, text),
      public.companion_skill_share_target(text, text),
      public.companion_billing_org_for_stripe_event(text, text),
      public.companion_revoke_inactive_skill_database_realm_shares(uuid, uuid),
      public.companion_expire_tool_runs(uuid, uuid, timestamp with time zone, integer, integer),
      public.companion_delivery_read_fence(uuid, uuid, text),
      public.companion_claim_delivery_lease(uuid, uuid, uuid, integer),
      public.companion_release_delivery_lease(uuid, uuid, uuid),
      public.companion_renew_delivery_lease(uuid, uuid, uuid, integer),
      public.companion_accept_delivery_lease(uuid, uuid, uuid, integer, integer)
     TO %I',
    api_role
  );

  -- Claims, exact-lease admission, heartbeats, cleanup and discovery belong only to the worker.
  -- Tool-run deadline settlement is additionally worker-callable so unattended threads are swept.
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION
      public.companion_claim_skill_database_object_deletions(integer, integer),
      public.companion_complete_skill_database_object_deletion(text, uuid),
      public.companion_defer_skill_database_object_deletion(text, uuid),
      public.companion_list_billing_sync_candidates(timestamp with time zone, boolean, integer),
      public.companion_claim_github_sync_destinations(text, integer, integer),
      public.companion_expire_tool_runs(uuid, uuid, timestamp with time zone, integer, integer),
      public.companion_claim_reconcile_candidates(text, integer, integer, integer, integer),
      public.companion_settle_reconcile_lease(uuid, uuid, text, text, integer)
     TO %I',
    worker_role
  );

  -- Runtime v2 is a one-way cutover. Once its sentinel exists, no application login may mutate
  -- the legacy Companion aggregate directly, including the local union fallback. Future API
  -- writes cross narrow v2 SECURITY DEFINER entry points; the isolated executor only receives the
  -- lease-fenced functions above. This explicit downgrade is the real privilege boundary: custom
  -- PostgreSQL GUCs are useful protocol markers, but an unprivileged login can spoof their value.
  IF pg_catalog.to_regprocedure('public.companion_runtime_gate_status()') IS NOT NULL THEN
    FOR configured_role IN
      SELECT DISTINCT role_name
      FROM unnest(active_roles) AS configured_roles(role_name)
    LOOP
      -- The legacy union branch above intentionally supports pre-0090 installations and therefore
      -- reinstalls broad defaults. Cancel those defaults after the v2 sentinel in this same grant
      -- transaction; current non-runtime tables were granted explicitly and remain available.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM %I',
        configured_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE USAGE, SELECT ON SEQUENCES FROM %I',
        configured_role
      );
    END LOOP;

    FOREACH protected_table IN ARRAY legacy_companion_mutation_tables
    LOOP
      EXECUTE format(
        'REVOKE INSERT, UPDATE, DELETE ON TABLE %s FROM PUBLIC',
        protected_table
      );
      FOR configured_role IN
        SELECT DISTINCT role_name
        FROM unnest(active_roles) AS configured_roles(role_name)
      LOOP
        EXECUTE format(
          'REVOKE INSERT, UPDATE, DELETE ON TABLE %s FROM %I',
          protected_table,
          configured_role
        );
      END LOOP;
    END LOOP;

    -- These functions are the retired request-driven executor. Revoke them after the legacy API
    -- and worker grants above so a repeated grants pass cannot accidentally resurrect execution.
    FOREACH protected_function IN ARRAY retired_companion_functions
    LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', protected_function);
      FOR configured_role IN
        SELECT DISTINCT role_name
        FROM unnest(active_roles) AS configured_roles(role_name)
      LOOP
        EXECUTE format(
          'REVOKE EXECUTE ON FUNCTION %s FROM %I',
          protected_function,
          configured_role
        );
      END LOOP;
      IF retired_runtime_role IS NOT NULL THEN
        EXECUTE format(
          'REVOKE EXECUTE ON FUNCTION %s FROM %I',
          protected_function,
          retired_runtime_role
        );
      END IF;
    END LOOP;
  END IF;
END
$companion_runtime_grants$;
-- companion-runtime-grants-end

RESET companion.api_role;
RESET companion.worker_role;
RESET companion.companion_runtime_role;
RESET companion.retired_runtime_role;
RESET companion.runtime_role;
