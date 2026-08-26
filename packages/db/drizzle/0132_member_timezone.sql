-- A member's timezone is personal profile data shared across every workspace and first-party
-- client. Null preserves existing rows and means the runtime/client falls back to UTC/device time
-- until the member chooses a zone.
ALTER TABLE public.profiles ADD COLUMN timezone text;
--> statement-breakpoint
ALTER TABLE public.profiles ADD CONSTRAINT profiles_timezone_check CHECK (
  timezone IS NULL OR (
    char_length(timezone) BETWEEN 1 AND 64
    AND timezone !~ E'[\\n\\r]'
  )
);
--> statement-breakpoint
ALTER TABLE public.companion_turn_attempts ADD COLUMN member_timezone text;
--> statement-breakpoint
ALTER TABLE public.companion_turn_attempts
  ADD CONSTRAINT companion_turn_attempts_member_timezone_check CHECK (
    member_timezone IS NULL OR (
      char_length(member_timezone) BETWEEN 1 AND 64
      AND member_timezone !~ E'[\\n\\r]'
    )
  );
--> statement-breakpoint

-- Fetch the per-attempt timestamp and actor timezone through the same fenced authorization proof
-- as the rest of runtime material. Keeping this a separate additive definer avoids changing the
-- established material function's return type while still denying direct profile-table access to
-- the runtime role.
CREATE FUNCTION public.companion_runtime_get_turn_context(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_lease_seconds integer
)
RETURNS TABLE (
  turn_started_at timestamp with time zone,
  member_timezone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $function$
DECLARE
  v_authorization record;
BEGIN
  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN
    RETURN;
  END IF;

  IF p_work_kind IS DISTINCT FROM 'attempt' THEN
    RETURN QUERY SELECT NULL::timestamp with time zone, NULL::text;
    RETURN;
  END IF;

  -- Pin the current profile zone on the attempt before composing the prompt. A later settings
  -- change therefore affects future attempts without changing the broker fingerprint during
  -- dispatch resolution or executor takeover for this one.
  RETURN QUERY
  UPDATE public.companion_turn_attempts attempt
  SET member_timezone = COALESCE(attempt.member_timezone, profile.timezone, 'UTC')
  FROM public.companion_turns turn_row
  LEFT JOIN public.profiles profile ON profile.id = turn_row.actor_id
  WHERE attempt.org_id = p_org_id
    AND attempt.companion_id = p_companion_id
    AND attempt.id = p_work_id
    AND turn_row.org_id = attempt.org_id
    AND turn_row.companion_id = attempt.companion_id
    AND turn_row.id = attempt.turn_id
    AND attempt.turn_id = v_authorization.turn_id
    AND attempt.actor_id = turn_row.actor_id
    AND attempt.claim_epoch = p_claim_epoch
  RETURNING attempt.started_at, attempt.member_timezone;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_get_turn_context(
  uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer
) FROM PUBLIC;
--> statement-breakpoint

-- Preserve split-role least privilege on upgrades. Fresh installs receive the same exact grant
-- from runtime-role-grants.sql after migrations complete.
DO $companion_member_timezone_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure(
    'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,integer)'
  );
  v_grantees oid[];
  v_role name;
BEGIN
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Companion runtime material surface is missing' USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT acl.grantee), ARRAY[]::oid[])
  INTO v_grantees
  FROM pg_catalog.pg_proc source_proc
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(source_proc.proacl, pg_catalog.acldefault('f', source_proc.proowner))
  ) acl
  WHERE source_proc.oid = v_source
    AND acl.privilege_type = 'EXECUTE'
    AND acl.grantee <> source_proc.proowner
    AND acl.grantee <> 0;
  IF cardinality(v_grantees) = 0 THEN RETURN; END IF;
  IF cardinality(v_grantees) > 1 THEN
    RAISE EXCEPTION 'Companion runtime ACL must name exactly one executor'
      USING ERRCODE = '55000';
  END IF;
  SELECT executor_role.rolname INTO STRICT v_role
  FROM pg_catalog.pg_roles executor_role WHERE executor_role.oid = v_grantees[1];
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.companion_runtime_get_turn_context('
    || 'uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) TO %I',
    v_role
  );
END
$companion_member_timezone_acl$;
