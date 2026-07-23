\if :{?runtime_role}
SELECT set_config('companion.runtime_role', :'runtime_role', false);
\else
  \echo 'runtime_role psql variable is required'
  \quit 1
\endif

-- Run as the migration/table owner after every migration. The login role must already exist with
-- NOSUPERUSER, NOBYPASSRLS and no membership in the migration-owner role. The API migration runner
-- executes the marked DO block directly; keep the markers and companion.runtime_role hand-off.
-- companion-runtime-grants-begin
DO $companion_runtime_grants$
DECLARE
  runtime_role text := current_setting('companion.runtime_role', true);
  runtime_attributes record;
BEGIN
  IF runtime_role IS NULL OR runtime_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
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

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), runtime_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
    runtime_role
  );
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', runtime_role);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    runtime_role
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
    runtime_role
  );

  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION
      public.companion_heartbeat_skill_run_worker(text, integer),
      public.companion_heartbeat_skill_run_worker(text, integer, integer),
      public.companion_heartbeat_skill_run_worker(text, integer, integer, integer),
      public.companion_remove_skill_run_worker(text),
      public.companion_skill_run_worker_ready(),
      public.companion_skill_run_attachment_worker_ready(),
      public.companion_skill_run_attachment_worker_ready(uuid, uuid, text),
      public.companion_skill_run_turn_stop_worker_ready(),
      public.companion_skill_run_turn_stop_worker_ready(uuid, uuid, text),
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
      public.companion_claim_skill_run_prewarms(text, integer, integer),
      public.companion_claim_skill_run_prewarm_cleanups(text, integer, integer),
      public.companion_complete_skill_run_prewarm_cleanup(uuid, uuid, text),
      public.companion_purge_skill_run_prewarms(integer),
      public.companion_cleanup_skill_run_events(integer),
      public.companion_secret_usage_count(uuid, uuid),
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
      public.companion_list_billing_sync_candidates(timestamp with time zone, boolean, integer),
      public.companion_claim_github_sync_destinations(text, integer, integer)
     TO %I',
    runtime_role
  );
END
$companion_runtime_grants$;
-- companion-runtime-grants-end

RESET companion.runtime_role;
