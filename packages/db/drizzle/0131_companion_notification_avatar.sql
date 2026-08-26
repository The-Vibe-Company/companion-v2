-- Keep the original claim function available during a rolling worker deploy. The v2 projection
-- adds only the current cosmetic Companion identity; durable notification rows and their bounded
-- title/body contract remain unchanged.
CREATE FUNCTION public.companion_claim_notification_deliveries_v2(
  p_worker_id text,
  p_limit integer DEFAULT 100,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  "deliveryId" uuid,
  "claimToken" uuid,
  "deviceId" uuid,
  "deviceToken" text,
  "environment" public.companion_notification_environment,
  "bundleId" text,
  "orgId" uuid,
  "companionId" uuid,
  "companionName" text,
  "iconShape" smallint,
  "iconMouth" smallint,
  "iconAccessory" smallint,
  "iconColor" smallint,
  "event" public.companion_notification_event,
  "eventKey" text,
  "title" text,
  "body" text,
  "expiresAt" timestamp with time zone,
  "attemptCount" integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF p_worker_id IS NULL OR char_length(p_worker_id) NOT BETWEEN 1 AND 200
     OR p_worker_id ~ E'[\n\r]'
     OR p_limit NOT BETWEEN 1 AND 1000
     OR p_lease_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'invalid notification delivery claim' USING ERRCODE = '22023';
  END IF;

  -- Bound both maintenance scans so an APNs outage cannot turn one worker tick into an
  -- unbounded transaction.
  WITH expired AS (
    SELECT delivery.id
    FROM public.companion_notification_deliveries delivery
    WHERE delivery.expires_at <= clock_timestamp()
    ORDER BY delivery.expires_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.companion_notification_deliveries delivery
  USING expired
  WHERE delivery.id = expired.id;

  WITH unauthorized AS (
    SELECT delivery.id
    FROM public.companion_notification_deliveries delivery
    WHERE delivery.available_at <= clock_timestamp()
      AND (delivery.claim_token IS NULL OR delivery.claim_expires_at <= clock_timestamp())
      AND NOT EXISTS (
        SELECT 1
        FROM public.companion_notification_devices device
        JOIN public.memberships membership
          ON membership.org_id = delivery.org_id
         AND membership.user_id = delivery.recipient_user_id
        JOIN public.companions companion
          ON companion.org_id = delivery.org_id
         AND companion.id = delivery.companion_id
        LEFT JOIN public.companion_workspace_access access
          ON access.org_id = companion.org_id
         AND access.companion_id = companion.id
        WHERE device.id = delivery.device_id
          AND device.org_id = delivery.org_id
          AND device.user_id = delivery.recipient_user_id
          AND device.disabled_at IS NULL
          AND (companion.owner_id = delivery.recipient_user_id OR access.role IS NOT NULL)
      )
    ORDER BY delivery.available_at, delivery.created_at
    LIMIT p_limit
    FOR UPDATE OF delivery SKIP LOCKED
  )
  DELETE FROM public.companion_notification_deliveries delivery
  USING unauthorized
  WHERE delivery.id = unauthorized.id;

  RETURN QUERY
  WITH candidates AS (
    SELECT delivery.id
    FROM public.companion_notification_deliveries delivery
    JOIN public.companion_notification_devices device
      ON device.id = delivery.device_id
     AND device.org_id = delivery.org_id
     AND device.user_id = delivery.recipient_user_id
    JOIN public.memberships membership
      ON membership.org_id = delivery.org_id
     AND membership.user_id = delivery.recipient_user_id
    JOIN public.companions companion
      ON companion.org_id = delivery.org_id
     AND companion.id = delivery.companion_id
    LEFT JOIN public.companion_workspace_access access
      ON access.org_id = companion.org_id
     AND access.companion_id = companion.id
    WHERE delivery.available_at <= clock_timestamp()
      AND delivery.expires_at > clock_timestamp()
      AND (delivery.claim_token IS NULL OR delivery.claim_expires_at <= clock_timestamp())
      AND device.disabled_at IS NULL
      AND (companion.owner_id = delivery.recipient_user_id OR access.role IS NOT NULL)
    ORDER BY delivery.available_at, delivery.created_at
    LIMIT p_limit
    FOR UPDATE OF delivery SKIP LOCKED
  ), claimed AS (
    UPDATE public.companion_notification_deliveries delivery
    SET claim_token = gen_random_uuid(),
        claim_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
        attempt_count = delivery.attempt_count + 1,
        updated_at = clock_timestamp()
    FROM candidates
    WHERE delivery.id = candidates.id
    RETURNING delivery.*
  )
  SELECT claimed.id, claimed.claim_token, claimed.device_id, device.device_token,
         device.environment, device.bundle_id, claimed.org_id, claimed.companion_id,
         companion.name, companion.icon_shape, companion.icon_mouth,
         companion.icon_accessory, companion.icon_color, claimed.event, claimed.event_key,
         claimed.title, claimed.body, claimed.expires_at, claimed.attempt_count
  FROM claimed
  JOIN public.companion_notification_devices device ON device.id = claimed.device_id
  JOIN public.companions companion
    ON companion.org_id = claimed.org_id AND companion.id = claimed.companion_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_claim_notification_deliveries_v2(
  text,integer,integer
) FROM PUBLIC;
--> statement-breakpoint
-- Copy the established worker login's narrow EXECUTE grant when roles already exist. Fresh
-- installs receive the same grant from runtime-role-grants.sql after migrations finish.
DO $companion_notification_avatar_acl$
DECLARE
  v_source oid := pg_catalog.to_regprocedure(
    'public.companion_claim_notification_deliveries(text,integer,integer)'
  );
  v_grantees oid[];
  v_role name;
BEGIN
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Companion notification claim surface is missing' USING ERRCODE = '55000';
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
    RAISE EXCEPTION 'Companion notification ACL must name exactly one worker role'
      USING ERRCODE = '55000';
  END IF;
  SELECT worker_role.rolname INTO STRICT v_role
  FROM pg_catalog.pg_roles worker_role WHERE worker_role.oid = v_grantees[1];
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.companion_claim_notification_deliveries_v2('
    || 'text,integer,integer) TO %I',
    v_role
  );
END
$companion_notification_avatar_acl$;
