import type { Sql } from "postgres";

export class RuntimeDatabaseRoleError extends Error {
  constructor() {
    super("Runtime database connection does not use the configured dedicated role");
    this.name = "RuntimeDatabaseRoleError";
  }
}

interface RuntimeRoleProfile {
  currentRole: string;
  canLogin: boolean;
  isSuperuser: boolean;
  bypassesRls: boolean;
  inheritsPrivileges: boolean;
  hasMemberships: boolean;
  hasDatabaseCreatePrivilege: boolean;
  hasPublicSchemaCreatePrivilege: boolean;
  ownsDatabaseOrSchema: boolean;
  ownsRelations: boolean;
  ownsFunctionsOrTypes: boolean;
  protectedRelationCount: number;
  hasPublicRelationPrivileges: boolean;
  requiredFunctionsReady: boolean;
  ownsRequiredFunctions: boolean;
  hasUnexpectedDefinerGrant: boolean;
}

const RUNTIME_ROLE_PROFILE_SQL = `
WITH runtime_role AS (
  SELECT oid, rolcanlogin, rolsuper, rolbypassrls, rolinherit
  FROM pg_catalog.pg_roles
  WHERE rolname = current_user
), required(signature) AS (
  VALUES
    ('public.companion_runtime_gate_status()'),
    ('public.companion_runtime_disable(bigint,text)'),
    ('public.companion_runtime_claim_work(text,integer,integer,bigint)'),
    ('public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,timestamp with time zone,integer,integer,integer)'),
    ('public.companion_runtime_observe_instance(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,bigint,text,public.companion_box_observed_state,public.companion_pi_observed_state,text,integer,bigint,integer,timestamp with time zone)'),
    ('public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_get_config_catalog(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)'),
    ('public.companion_runtime_get_attempt_terminal_projection(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)'),
    ('public.companion_runtime_project_event_batch(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer)'),
    ('public.companion_runtime_register_duplicate_cleanups(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text[])'),
    ('public.companion_runtime_checkpoint_duplicate_cleanup(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,bigint,public.companion_duplicate_cleanup_status,text)'),
    ('public.companion_runtime_cas_mcp_oauth(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text)'),
    ('public.companion_runtime_settle(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,text,text,public.companion_runtime_error_action)'),
    ('public.companion_runtime_release_lease(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)'),
    ('public.companion_runtime_authorize_desktop(uuid,uuid,text)'),
    ('public.companion_runtime_consume_desktop_request(text,bigint,integer)'),
    ('public.companion_runtime_record_attempt_outputs(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,jsonb,timestamp with time zone)')
), required_functions AS (
  SELECT signature, pg_catalog.to_regprocedure(signature) AS oid
  FROM required
), public_relations AS (
  SELECT relation.oid, relation.relkind
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
), protected_relations AS (
  SELECT relation.oid
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p')
    AND relation.relname = ANY (ARRAY[
      'companion_runtime_control',
      'companion_runtime_instances',
      'companion_turns',
      'companion_turn_attempts',
      'companion_operations',
      'companion_decision_deliveries',
      'companion_runtime_leases',
      'companion_runtime_duplicate_cleanups',
      'companion_runtime_event_projections',
      'companion_runtime_desktop_requests',
      'companion_message_attachments'
    ]::text[])
)
SELECT
  current_user::text AS "currentRole",
  role.rolcanlogin AS "canLogin",
  role.rolsuper AS "isSuperuser",
  role.rolbypassrls AS "bypassesRls",
  role.rolinherit AS "inheritsPrivileges",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members membership
    WHERE membership.member = role.oid OR membership.roleid = role.oid
  ) AS "hasMemberships",
  pg_catalog.has_database_privilege(role.oid, current_database(), 'CREATE')
    AS "hasDatabaseCreatePrivilege",
  pg_catalog.has_schema_privilege(role.oid, 'public', 'CREATE')
    AS "hasPublicSchemaCreatePrivilege",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_database database
    WHERE database.datname = current_database() AND database.datdba = role.oid
    UNION ALL
    SELECT 1 FROM pg_catalog.pg_namespace namespace WHERE namespace.nspowner = role.oid
  ) AS "ownsDatabaseOrSchema",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_class relation WHERE relation.relowner = role.oid
  ) AS "ownsRelations",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc procedure WHERE procedure.proowner = role.oid
    UNION ALL
    SELECT 1 FROM pg_catalog.pg_type type WHERE type.typowner = role.oid
  ) AS "ownsFunctionsOrTypes",
  (SELECT count(*)::int FROM protected_relations) AS "protectedRelationCount",
  EXISTS (
    SELECT 1
    FROM public_relations relation
    WHERE CASE relation.relkind
      WHEN 'S' THEN pg_catalog.has_sequence_privilege(role.oid, relation.oid, 'USAGE,SELECT,UPDATE')
      ELSE pg_catalog.has_table_privilege(
        role.oid,
        relation.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
    END
  ) AS "hasPublicRelationPrivileges",
  NOT EXISTS (
    SELECT 1
    FROM required_functions function
    LEFT JOIN pg_catalog.pg_proc procedure ON procedure.oid = function.oid
    WHERE function.oid IS NULL
      OR procedure.prosecdef IS NOT TRUE
      OR NOT pg_catalog.has_function_privilege(role.oid, function.oid, 'EXECUTE')
  ) AS "requiredFunctionsReady",
  EXISTS (
    SELECT 1
    FROM required_functions function
    JOIN pg_catalog.pg_proc procedure ON procedure.oid = function.oid
    WHERE procedure.proowner = role.oid
  ) AS "ownsRequiredFunctions",
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.prosecdef
      AND pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
      AND procedure.oid <> ALL (
        SELECT function.oid FROM required_functions function WHERE function.oid IS NOT NULL
      )
  ) AS "hasUnexpectedDefinerGrant"
FROM runtime_role role
`;

export async function verifyRuntimeDatabaseRole(
  sql: Pick<Sql, "unsafe">,
  expectedRole: string,
): Promise<void> {
  const rows = await sql.unsafe<RuntimeRoleProfile[]>(RUNTIME_ROLE_PROFILE_SQL);
  const profile = rows[0];
  if (
    rows.length !== 1
    || profile?.currentRole !== expectedRole
    || profile.canLogin !== true
    || profile.isSuperuser !== false
    || profile.bypassesRls !== false
    || profile.inheritsPrivileges !== false
    || profile.hasMemberships !== false
    || profile.hasDatabaseCreatePrivilege !== false
    || profile.hasPublicSchemaCreatePrivilege !== false
    || profile.ownsDatabaseOrSchema !== false
    || profile.ownsRelations !== false
    || profile.ownsFunctionsOrTypes !== false
    || profile.protectedRelationCount !== 11
    || profile.hasPublicRelationPrivileges !== false
    || profile.requiredFunctionsReady !== true
    || profile.ownsRequiredFunctions !== false
    || profile.hasUnexpectedDefinerGrant !== false
  ) {
    throw new RuntimeDatabaseRoleError();
  }
}
