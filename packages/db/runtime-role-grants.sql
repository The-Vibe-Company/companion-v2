\if :{?api_role}
SELECT set_config('companion.api_role', :'api_role', false);
\if :{?worker_role}
SELECT set_config('companion.worker_role', :'worker_role', false);
\if :{?retired_runtime_role}
SELECT set_config('companion.retired_runtime_role', :'retired_runtime_role', false);
\endif
\else
  \echo 'worker_role psql variable is required when api_role is configured'
  \quit 1
\endif
\else
\if :{?runtime_role}
-- Backward-compatible single-role mode for simple/local installations.
SELECT set_config('companion.runtime_role', :'runtime_role', false);
\else
  \echo 'api_role + worker_role (or legacy runtime_role) psql variables are required'
  \quit 1
\endif
\endif

-- Run as the migration/table owner after every migration. The login role must already exist with
-- NOSUPERUSER, NOBYPASSRLS, NOINHERIT and no membership in the migration-owner role. Production
-- should provide distinct API and worker roles. The legacy runtime_role path intentionally grants
-- the union of both capability sets to one role for backward-compatible simple/local installs.
-- The API migration runner executes the marked DO block directly; keep the markers and GUC hand-off.
-- companion-runtime-grants-begin
DO $companion_runtime_grants$
DECLARE
  legacy_role text := nullif(current_setting('companion.runtime_role', true), '');
  api_role text := coalesce(nullif(current_setting('companion.api_role', true), ''), legacy_role);
  worker_role text := coalesce(nullif(current_setting('companion.worker_role', true), ''), legacy_role);
  retired_runtime_role text :=
    nullif(current_setting('companion.retired_runtime_role', true), '');
  runtime_role text;
  runtime_attributes record;
  protected_table regclass;
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
    'public.companion_secret_usage_count(uuid,uuid)'::regprocedure,
    'public.companion_skill_run_worker_ready()'::regprocedure,
    'public.companion_skill_run_attachment_worker_ready()'::regprocedure,
    'public.companion_skill_run_attachment_worker_ready(uuid,uuid,text)'::regprocedure,
    'public.companion_skill_run_turn_stop_worker_ready()'::regprocedure,
    'public.companion_skill_run_turn_stop_worker_ready(uuid,uuid,text)'::regprocedure,
    'public.companion_project_policy_definer()'::regprocedure,
    'public.companion_project_exact_lease_visible(uuid,uuid,text)'::regprocedure,
    'public.companion_project_row_visible(uuid,uuid,text)'::regprocedure,
    'public.companion_project_worker_ready()'::regprocedure,
    'public.companion_sandbox_usage_totals(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)'::regprocedure
  ];
  api_functions regprocedure[] := ARRAY[
    'public.companion_list_user_orgs(text)'::regprocedure,
    'public.companion_users_share_org(text,text)'::regprocedure,
    'public.companion_list_joinable_orgs(text)'::regprocedure,
    'public.companion_lock_invitation_for_actor(text,text)'::regprocedure,
    'public.companion_resolve_api_token(text)'::regprocedure,
    'public.companion_lock_api_token_for_refresh(text)'::regprocedure,
    'public.companion_public_skill_preview(text)'::regprocedure,
    'public.companion_authorize_public_skill_package(text,text,text)'::regprocedure,
    'public.companion_issue_public_skill_transfer_ticket(text,text,text,text,text,text,timestamp with time zone)'::regprocedure,
    'public.companion_consume_public_skill_transfer_ticket(text,text,text)'::regprocedure,
    'public.companion_consume_agent_transfer_ticket(text,text,text,text,text,integer,text)'::regprocedure,
    'public.companion_preflight_agent_transfer_ticket(text,text,text,text)'::regprocedure,
    'public.companion_revalidate_agent_transfer_ticket(text)'::regprocedure,
    'public.companion_revoke_agent_transfer_tickets(text,text,text)'::regprocedure,
    'public.companion_skill_share_target(text,text)'::regprocedure,
    'public.companion_billing_org_for_stripe_event(text,text)'::regprocedure,
    'public.companion_request_member_project_deletion(uuid,text)'::regprocedure,
    'public.companion_project_skill_refresh_targets(uuid,uuid)'::regprocedure,
    'public.companion_signal_project_secret_change(uuid,uuid,text,text,text,public.secret_audience,text[])'::regprocedure,
    'public.companion_signal_project_provider_change(uuid,text,uuid,public.model_provider_connection_scope,text,text)'::regprocedure
  ];
  worker_functions regprocedure[] := ARRAY[
    'public.companion_heartbeat_skill_run_worker(text,integer)'::regprocedure,
    'public.companion_heartbeat_skill_run_worker(text,integer,integer)'::regprocedure,
    'public.companion_heartbeat_skill_run_worker(text,integer,integer,integer)'::regprocedure,
    'public.companion_remove_skill_run_worker(text)'::regprocedure,
    'public.companion_lock_skill_run_attachment_orphan(text,timestamp with time zone)'::regprocedure,
    'public.companion_complete_skill_run_attachment_orphan(text)'::regprocedure,
    'public.companion_defer_skill_run_attachment_orphan(text,timestamp with time zone)'::regprocedure,
    'public.companion_list_skill_run_attachment_orphans(timestamp with time zone,integer)'::regprocedure,
    'public.companion_put_skill_run_artifact_metadata(uuid,uuid,text,text,uuid,text,text,text,integer,boolean,text,boolean,timestamp with time zone)'::regprocedure,
    'public.companion_put_skill_run_artifact_metadata_v2(uuid,uuid,text,text,uuid,text,text,text,integer,boolean,text,boolean,timestamp with time zone,text)'::regprocedure,
    'public.companion_reconcile_skill_run_artifact_paths(uuid,uuid,text,text,text[])'::regprocedure,
    'public.companion_list_expired_skill_run_artifacts(timestamp with time zone,integer)'::regprocedure,
    'public.companion_lock_expired_skill_run_artifact(uuid,text,timestamp with time zone)'::regprocedure,
    'public.companion_complete_expired_skill_run_artifact(uuid,text)'::regprocedure,
    'public.companion_claim_skill_run_jobs(text,integer,integer)'::regprocedure,
    'public.companion_get_skill_run_worker_control(uuid,uuid,text,text)'::regprocedure,
    'public.companion_terminalize_revoked_skill_run(uuid,uuid,text,text,boolean)'::regprocedure,
    'public.companion_claim_skill_run_cleanups(text,integer,integer)'::regprocedure,
    'public.companion_complete_skill_run_cleanup(uuid,uuid,text)'::regprocedure,
    'public.companion_claim_skill_run_runtime_reconciliations(text,integer,integer,text)'::regprocedure,
    'public.companion_complete_skill_run_runtime_reconciliation(uuid,uuid,text,integer,integer,public.sandbox_provider_state,timestamp with time zone)'::regprocedure,
    'public.companion_settle_terminal_skill_run_usage(integer)'::regprocedure,
    'public.companion_claim_skill_run_prewarms(text,integer,integer)'::regprocedure,
    'public.companion_claim_skill_run_prewarm_cleanups(text,integer,integer)'::regprocedure,
    'public.companion_complete_skill_run_prewarm_cleanup(uuid,uuid,text)'::regprocedure,
    'public.companion_purge_skill_run_prewarms(integer)'::regprocedure,
    'public.companion_cleanup_skill_run_events(integer)'::regprocedure,
    'public.companion_list_billing_sync_candidates(timestamp with time zone,boolean,integer)'::regprocedure,
    'public.companion_claim_github_sync_destinations(text,integer,integer)'::regprocedure,
    'public.companion_claim_project_workspaces(text,integer,integer)'::regprocedure,
    'public.companion_enter_project_worker_lease(uuid,uuid,text,text,integer)'::regprocedure,
    'public.companion_heartbeat_project_worker(text,integer,integer)'::regprocedure,
    'public.companion_remove_project_worker(text)'::regprocedure,
    'public.companion_lock_project_attachment_orphan(text,timestamp with time zone)'::regprocedure,
    'public.companion_complete_project_attachment_orphan(text)'::regprocedure,
    'public.companion_defer_project_attachment_orphan(text,timestamp with time zone)'::regprocedure,
    'public.companion_list_project_attachment_orphans(timestamp with time zone,integer)'::regprocedure
  ];
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

  FOR runtime_role IN
    SELECT DISTINCT role_name
    FROM unnest(ARRAY[api_role, worker_role]) AS configured_roles(role_name)
  LOOP
    IF runtime_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
      RAISE EXCEPTION 'invalid companion runtime role';
    END IF;

    SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolinherit
    INTO runtime_attributes
    FROM pg_catalog.pg_roles r
    WHERE r.rolname = runtime_role;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'companion runtime role % does not exist', runtime_role;
    END IF;
    IF NOT runtime_attributes.rolcanlogin
      OR runtime_attributes.rolsuper
      OR runtime_attributes.rolbypassrls
      OR runtime_attributes.rolinherit THEN
      RAISE EXCEPTION 'companion runtime role % must be LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT', runtime_role;
    END IF;
    IF pg_catalog.pg_has_role(runtime_role, current_user, 'member') THEN
      RAISE EXCEPTION 'companion runtime role % must not inherit the migration-owner role', runtime_role;
    END IF;
  END LOOP;

  IF api_role <> worker_role THEN
    IF pg_catalog.pg_has_role(api_role, worker_role, 'MEMBER')
      OR pg_catalog.pg_has_role(api_role, worker_role, 'SET')
      OR pg_catalog.pg_has_role(worker_role, api_role, 'MEMBER')
      OR pg_catalog.pg_has_role(worker_role, api_role, 'SET') THEN
      RAISE EXCEPTION 'companion API and worker roles must not have cross-role membership';
    END IF;

    -- A split-role application is also a downgrade pass for names reused from the legacy union
    -- topology. Clear every direct/current and future table or sequence grant first. The migration
    -- hook is rerun after each schema migration, so future tables fail closed until they either
    -- enable RLS or are deliberately added to a process-specific unprotected-table list.
    FOREACH runtime_role IN ARRAY ARRAY[api_role, worker_role]
    LOOP
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), runtime_role);
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM %I',
        runtime_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE USAGE, SELECT ON SEQUENCES FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
        runtime_role
      );

      FOR protected_table IN
        SELECT table_class.oid::regclass
        FROM pg_catalog.pg_class table_class
        JOIN pg_catalog.pg_namespace table_namespace
          ON table_namespace.oid = table_class.relnamespace
        WHERE table_namespace.nspname = 'public'
          AND table_class.relkind IN ('r', 'p')
          AND table_class.relrowsecurity
        ORDER BY table_class.oid
      LOOP
        EXECUTE format(
          'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO %I',
          protected_table,
          runtime_role
        );
      END LOOP;
    END LOOP;

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
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        protected_function,
        api_role
      );
    END LOOP;
    FOREACH protected_function IN ARRAY api_functions
    LOOP
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I',
        protected_function,
        worker_role
      );
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

  IF retired_runtime_role IS NOT NULL
    AND retired_runtime_role <> api_role
    AND retired_runtime_role <> worker_role THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = retired_runtime_role
    ) THEN
      RAISE EXCEPTION 'retired companion runtime role % does not exist', retired_runtime_role;
    END IF;
    IF pg_catalog.pg_has_role(retired_runtime_role, api_role, 'MEMBER')
      OR pg_catalog.pg_has_role(retired_runtime_role, api_role, 'SET')
      OR pg_catalog.pg_has_role(retired_runtime_role, worker_role, 'MEMBER')
      OR pg_catalog.pg_has_role(retired_runtime_role, worker_role, 'SET') THEN
      RAISE EXCEPTION 'retired companion runtime role must not inherit an active runtime role';
    END IF;

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

  -- Read-only creator-scoped projection, readiness and policy helpers are needed by both process
  -- roles. Keep this list separate from the mutually-exclusive capability sets above: Project
  -- activation enumerates the creator's accessible secrets and therefore calls the usage helper
  -- while materializing the worker-owned environment.
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
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION
      public.companion_list_user_orgs(text),
      public.companion_users_share_org(text, text),
      public.companion_list_joinable_orgs(text),
      public.companion_lock_invitation_for_actor(text, text),
      public.companion_resolve_api_token(text),
      public.companion_lock_api_token_for_refresh(text),
      public.companion_public_skill_preview(text),
      public.companion_authorize_public_skill_package(text, text, text),
      public.companion_issue_public_skill_transfer_ticket(text, text, text, text, text, text, timestamp with time zone),
      public.companion_consume_public_skill_transfer_ticket(text, text, text),
      public.companion_consume_agent_transfer_ticket(text, text, text, text, text, integer, text),
      public.companion_preflight_agent_transfer_ticket(text, text, text, text),
      public.companion_revalidate_agent_transfer_ticket(text),
      public.companion_revoke_agent_transfer_tickets(text, text, text),
      public.companion_skill_share_target(text, text),
      public.companion_billing_org_for_stripe_event(text, text),
      public.companion_request_member_project_deletion(uuid, text),
      public.companion_project_skill_refresh_targets(uuid, uuid),
      public.companion_signal_project_secret_change(uuid, uuid, text, text, text, public.secret_audience, text[]),
      public.companion_signal_project_provider_change(uuid, text, uuid, model_provider_connection_scope, text, text)
     TO %I',
    api_role
  );

  -- Claims, exact-lease admission, heartbeats, cleanup and discovery belong only to the worker.
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION
      public.companion_heartbeat_skill_run_worker(text, integer),
      public.companion_heartbeat_skill_run_worker(text, integer, integer),
      public.companion_heartbeat_skill_run_worker(text, integer, integer, integer),
      public.companion_remove_skill_run_worker(text),
      public.companion_lock_skill_run_attachment_orphan(text, timestamp with time zone),
      public.companion_complete_skill_run_attachment_orphan(text),
      public.companion_defer_skill_run_attachment_orphan(text, timestamp with time zone),
      public.companion_list_skill_run_attachment_orphans(timestamp with time zone, integer),
      public.companion_put_skill_run_artifact_metadata(uuid, uuid, text, text, uuid, text, text, text, integer, boolean, text, boolean, timestamp with time zone),
      public.companion_put_skill_run_artifact_metadata_v2(uuid, uuid, text, text, uuid, text, text, text, integer, boolean, text, boolean, timestamp with time zone, text),
      public.companion_reconcile_skill_run_artifact_paths(uuid, uuid, text, text, text[]),
      public.companion_list_expired_skill_run_artifacts(timestamp with time zone, integer),
      public.companion_lock_expired_skill_run_artifact(uuid, text, timestamp with time zone),
      public.companion_complete_expired_skill_run_artifact(uuid, text),
      public.companion_claim_skill_run_jobs(text, integer, integer),
      public.companion_get_skill_run_worker_control(uuid, uuid, text, text),
      public.companion_terminalize_revoked_skill_run(uuid, uuid, text, text, boolean),
      public.companion_claim_skill_run_cleanups(text, integer, integer),
      public.companion_complete_skill_run_cleanup(uuid, uuid, text),
      public.companion_claim_skill_run_runtime_reconciliations(text, integer, integer, text),
      public.companion_complete_skill_run_runtime_reconciliation(uuid, uuid, text, integer, integer, sandbox_provider_state, timestamp with time zone),
      public.companion_settle_terminal_skill_run_usage(integer),
      public.companion_claim_skill_run_prewarms(text, integer, integer),
      public.companion_claim_skill_run_prewarm_cleanups(text, integer, integer),
      public.companion_complete_skill_run_prewarm_cleanup(uuid, uuid, text),
      public.companion_purge_skill_run_prewarms(integer),
      public.companion_cleanup_skill_run_events(integer),
      public.companion_list_billing_sync_candidates(timestamp with time zone, boolean, integer),
      public.companion_claim_github_sync_destinations(text, integer, integer),
      public.companion_claim_project_workspaces(text, integer, integer),
      public.companion_enter_project_worker_lease(uuid, uuid, text, text, integer),
      public.companion_heartbeat_project_worker(text, integer, integer),
      public.companion_remove_project_worker(text),
      public.companion_lock_project_attachment_orphan(text, timestamp with time zone),
      public.companion_complete_project_attachment_orphan(text),
      public.companion_defer_project_attachment_orphan(text, timestamp with time zone),
      public.companion_list_project_attachment_orphans(timestamp with time zone, integer)
     TO %I',
    worker_role
  );
END
$companion_runtime_grants$;
-- companion-runtime-grants-end

RESET companion.api_role;
RESET companion.worker_role;
RESET companion.retired_runtime_role;
RESET companion.runtime_role;
