CREATE TYPE public.companion_notification_environment AS ENUM ('sandbox', 'production');
--> statement-breakpoint
CREATE TYPE public.companion_notification_event AS ENUM (
  'reply', 'input_required', 'failed', 'interrupted'
);
--> statement-breakpoint

CREATE TABLE public.companion_notification_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  platform text DEFAULT 'ios' NOT NULL,
  device_token text NOT NULL,
  environment public.companion_notification_environment NOT NULL,
  bundle_id text NOT NULL,
  disabled_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT companion_notification_devices_installation_uq UNIQUE (installation_id),
  CONSTRAINT companion_notification_devices_token_uq UNIQUE (environment, bundle_id, device_token),
  CONSTRAINT companion_notification_devices_membership_fk
    FOREIGN KEY (org_id, user_id) REFERENCES public.memberships(org_id, user_id) ON DELETE CASCADE,
  CONSTRAINT companion_notification_devices_platform_check CHECK (platform = 'ios'),
  CONSTRAINT companion_notification_devices_token_check CHECK (
    char_length(device_token) BETWEEN 64 AND 512 AND device_token ~ '^[a-f0-9]+$'
  ),
  CONSTRAINT companion_notification_devices_target_check CHECK (
    (environment = 'sandbox' AND bundle_id = 'dev.companion.mobile.dev')
    OR (environment = 'production' AND bundle_id = 'dev.companion.mobile')
  )
);
--> statement-breakpoint

CREATE TABLE public.companion_notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.companion_notification_devices(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL REFERENCES public.companions(id) ON DELETE CASCADE,
  recipient_user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  event public.companion_notification_event NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  available_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  claim_token uuid,
  claim_expires_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT companion_notification_deliveries_device_event_uq UNIQUE (device_id, event_key),
  CONSTRAINT companion_notification_deliveries_membership_fk
    FOREIGN KEY (org_id, recipient_user_id)
    REFERENCES public.memberships(org_id, user_id) ON DELETE CASCADE,
  CONSTRAINT companion_notification_deliveries_companion_fk
    FOREIGN KEY (org_id, companion_id)
    REFERENCES public.companions(org_id, id) ON DELETE CASCADE,
  CONSTRAINT companion_notification_deliveries_attempt_check CHECK (attempt_count >= 0),
  CONSTRAINT companion_notification_deliveries_content_check CHECK (
    char_length(title) BETWEEN 1 AND 180
    AND char_length(body) BETWEEN 1 AND 180
    AND title !~ E'[\n\r]'
    AND body !~ E'[\n\r]'
  ),
  CONSTRAINT companion_notification_deliveries_claim_check CHECK (
    (claim_token IS NULL) = (claim_expires_at IS NULL)
  )
);
--> statement-breakpoint

CREATE INDEX companion_notification_deliveries_due_idx
  ON public.companion_notification_deliveries(available_at, created_at);
--> statement-breakpoint
CREATE INDEX companion_notification_deliveries_expiry_idx
  ON public.companion_notification_deliveries(expires_at);
--> statement-breakpoint

ALTER TABLE public.companion_notification_devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_notification_devices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_notification_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.companion_notification_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY companion_notification_devices_function_owner_rls
  ON public.companion_notification_devices FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint
CREATE POLICY companion_notification_deliveries_function_owner_rls
  ON public.companion_notification_deliveries FOR ALL
  USING (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )))
  WITH CHECK (current_user = pg_get_userbyid((
    SELECT p.proowner FROM pg_proc p
    WHERE p.oid = 'public.companion_runtime_claim_work(text,integer,integer,bigint)'::regprocedure
  )));
--> statement-breakpoint

CREATE FUNCTION public.companion_api_register_notification_device(
  p_org_id uuid,
  p_installation_id uuid,
  p_platform text,
  p_device_token text,
  p_environment public.companion_notification_environment,
  p_bundle_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_lock_key text;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_installation_id IS NULL
     OR p_platform <> 'ios'
     OR char_length(p_device_token) NOT BETWEEN 64 AND 512
     OR p_device_token !~ '^[a-f0-9]+$'
     OR NOT (
       (p_environment = 'sandbox' AND p_bundle_id = 'dev.companion.mobile.dev')
       OR (p_environment = 'production' AND p_bundle_id = 'dev.companion.mobile')
     ) THEN
    RAISE EXCEPTION 'invalid notification device registration' USING ERRCODE = '22023';
  END IF;

  -- Serialize account/token reassignment with a worker already sending to any affected
  -- installation. Sorting the complete lock set keeps concurrent token swaps deadlock-free.
  FOR v_lock_key IN
    SELECT lock_target.key
    FROM (
      SELECT 'installation:' || p_installation_id::text AS key
      UNION
      SELECT 'installation:' || device.installation_id::text
      FROM public.companion_notification_devices device
      WHERE device.installation_id = p_installation_id
         OR (
           device.environment = p_environment
           AND device.bundle_id = p_bundle_id
           AND device.device_token = p_device_token
         )
      UNION
      SELECT 'token:' || p_environment::text || ':' || p_bundle_id || ':' || p_device_token
      UNION
      SELECT 'token:' || device.environment::text || ':' || device.bundle_id || ':' ||
             device.device_token
      FROM public.companion_notification_devices device
      WHERE device.installation_id = p_installation_id
         OR (
           device.environment = p_environment
           AND device.bundle_id = p_bundle_id
           AND device.device_token = p_device_token
         )
    ) lock_target
    ORDER BY lock_target.key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'companion-notification:' || v_lock_key,
      0
    ));
  END LOOP;

  -- Possession of both the installation id and APNs token lets a reinstall/account switch
  -- reclaim the same physical destination without exposing either value through a read route.
  DELETE FROM public.companion_notification_deliveries delivery
  USING public.companion_notification_devices device
  WHERE delivery.device_id = device.id
    AND device.installation_id = p_installation_id
    AND (device.org_id <> p_org_id OR device.user_id <> v_actor_id);

  DELETE FROM public.companion_notification_devices device
  WHERE device.environment = p_environment
    AND device.bundle_id = p_bundle_id
    AND device.device_token = p_device_token
    AND device.installation_id <> p_installation_id;

  INSERT INTO public.companion_notification_devices(
    org_id, installation_id, user_id, platform, device_token, environment, bundle_id,
    disabled_at, created_at, updated_at
  ) VALUES (
    p_org_id, p_installation_id, v_actor_id, p_platform, p_device_token, p_environment,
    p_bundle_id, NULL, v_now, v_now
  )
  ON CONFLICT (installation_id) DO UPDATE
  SET org_id = EXCLUDED.org_id,
      user_id = EXCLUDED.user_id,
      platform = EXCLUDED.platform,
      device_token = EXCLUDED.device_token,
      environment = EXCLUDED.environment,
      bundle_id = EXCLUDED.bundle_id,
      disabled_at = NULL,
      updated_at = EXCLUDED.updated_at;
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_api_unregister_notification_device(
  p_org_id uuid,
  p_installation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_environment public.companion_notification_environment;
  v_bundle_id text;
  v_device_token text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'companion-notification:installation:' || p_installation_id::text,
    0
  ));
  SELECT device.environment, device.bundle_id, device.device_token
  INTO v_environment, v_bundle_id, v_device_token
  FROM public.companion_notification_devices device
  WHERE device.org_id = p_org_id
    AND device.user_id = v_actor_id
    AND device.installation_id = p_installation_id;
  IF v_device_token IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'companion-notification:token:' || v_environment::text || ':' || v_bundle_id || ':' ||
        v_device_token,
      0
    ));
  END IF;
  DELETE FROM public.companion_notification_devices device
  WHERE device.org_id = p_org_id
    AND device.user_id = v_actor_id
    AND device.installation_id = p_installation_id;
  RETURN true;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_notification_enqueue(
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
  ON CONFLICT (device_id, event_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_notification_terminal_turn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_name text;
  v_attempt_id uuid;
  v_preview text;
  v_event public.companion_notification_event;
  v_title text;
  v_body text;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status
     OR NEW.status NOT IN ('succeeded', 'failed', 'interrupted') THEN
    RETURN NEW;
  END IF;
  SELECT companion.name INTO v_name
  FROM public.companions companion
  WHERE companion.org_id = NEW.org_id AND companion.id = NEW.companion_id;
  IF v_name IS NULL THEN RETURN NEW; END IF;

  SELECT attempt.id INTO v_attempt_id
  FROM public.companion_turn_attempts attempt
  WHERE attempt.org_id = NEW.org_id
    AND attempt.companion_id = NEW.companion_id
    AND attempt.turn_id = NEW.id
  ORDER BY attempt.attempt_number DESC
  LIMIT 1;

  IF NEW.status = 'succeeded' THEN
    v_event := 'reply';
    v_title := v_name || ' replied';
    SELECT entry.content INTO v_preview
    FROM public.companion_transcript_entries entry
    WHERE entry.org_id = NEW.org_id
      AND entry.companion_id = NEW.companion_id
      AND entry.role = 'assistant'
      AND v_attempt_id IS NOT NULL
      AND entry.event_id LIKE ('v2:' || v_attempt_id::text || ':%')
    ORDER BY entry.ordinal DESC
    LIMIT 1;
    IF NULLIF(btrim(COALESCE(v_preview, '')), '') IS NULL THEN
      IF EXISTS (
        SELECT 1
        FROM public.companion_message_attachments attachment
        JOIN public.companion_transcript_entries entry
          ON entry.org_id = attachment.org_id
         AND entry.companion_id = attachment.companion_id
         AND entry.event_id = attachment.entry_event_id
        WHERE attachment.org_id = NEW.org_id
          AND attachment.companion_id = NEW.companion_id
          AND attachment.kind = 'pi_output'
          AND v_attempt_id IS NOT NULL
          AND entry.event_id LIKE ('v2:' || v_attempt_id::text || ':%')
      ) THEN
        v_preview := 'Sent an image.';
      ELSE
        v_preview := 'Finished the turn.';
      END IF;
    END IF;
    v_body := v_preview;
  ELSIF NEW.status = 'failed' THEN
    v_event := 'failed';
    v_title := v_name || ' could not finish';
    v_body := COALESCE(NEW.last_error_message, 'Open the conversation for details.');
  ELSE
    v_event := 'interrupted';
    v_title := v_name || ' was interrupted';
    v_body := COALESCE(NEW.last_error_message, 'Open the conversation to retry or cancel.');
  END IF;

  PERFORM public.companion_notification_enqueue(
    NEW.org_id,
    NEW.companion_id,
    NEW.actor_id,
    'turn:' || NEW.id::text || ':' || NEW.status::text || ':' ||
      COALESCE(v_attempt_id::text, 'no-attempt'),
    v_event,
    v_title,
    v_body
  );
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER companion_notification_terminal_turn_trigger
AFTER UPDATE OF status ON public.companion_turns
FOR EACH ROW EXECUTE FUNCTION public.companion_notification_terminal_turn();
--> statement-breakpoint

CREATE FUNCTION public.companion_notification_pending_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_turn_id uuid;
  v_attempt_id uuid;
  v_actor_id text;
  v_name text;
  v_request_id text := NEW.decision ->> 'request_id';
BEGIN
  IF NEW.role <> 'decision'
     OR NEW.decision ->> 'status' <> 'pending'
     OR v_request_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT delivery.turn_id, delivery.attempt_id, turn.actor_id, companion.name
  INTO v_turn_id, v_attempt_id, v_actor_id, v_name
  FROM public.companion_decision_deliveries delivery
  JOIN public.companion_turns turn
    ON turn.org_id = delivery.org_id
   AND turn.companion_id = delivery.companion_id
   AND turn.id = delivery.turn_id
  JOIN public.companions companion
    ON companion.org_id = delivery.org_id AND companion.id = delivery.companion_id
  WHERE delivery.org_id = NEW.org_id
    AND delivery.companion_id = NEW.companion_id
    AND delivery.request_key = v_request_id
  ORDER BY delivery.created_at DESC
  LIMIT 1;
  IF v_turn_id IS NULL THEN RETURN NEW; END IF;

  PERFORM public.companion_notification_enqueue(
    NEW.org_id,
    NEW.companion_id,
    v_actor_id,
    'decision:' || v_attempt_id::text || ':' || v_request_id,
    'input_required',
    v_name || ' needs your answer',
    COALESCE(NULLIF(NEW.decision ->> 'title', ''), NEW.content)
  );
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TRIGGER companion_notification_pending_decision_trigger
AFTER INSERT ON public.companion_transcript_entries
FOR EACH ROW EXECUTE FUNCTION public.companion_notification_pending_decision();
--> statement-breakpoint

CREATE FUNCTION public.companion_claim_notification_deliveries(
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

  -- Keep maintenance bounded: a backlog or an APNs outage must not turn every two-second
  -- worker tick into an unbounded queue scan or delete transaction.
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
  SELECT claimed.id, claimed.claim_token, claimed.device_id, device.device_token, device.environment,
         device.bundle_id, claimed.org_id, claimed.companion_id, claimed.event,
         claimed.event_key, claimed.title, claimed.body, claimed.expires_at,
         claimed.attempt_count
  FROM claimed
  JOIN public.companion_notification_devices device ON device.id = claimed.device_id;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_validate_notification_delivery(
  p_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_installation_id uuid;
  v_environment public.companion_notification_environment;
  v_bundle_id text;
  v_device_token text;
BEGIN
  SELECT device.installation_id, device.environment, device.bundle_id, device.device_token
  INTO v_installation_id, v_environment, v_bundle_id, v_device_token
  FROM public.companion_notification_deliveries delivery
  JOIN public.companion_notification_devices device ON device.id = delivery.device_id
  WHERE delivery.id = p_id AND delivery.claim_token = p_claim_token;
  IF v_installation_id IS NULL THEN RETURN false; END IF;

  -- The worker keeps this transaction-scoped lock through the bounded APNs request. Device
  -- registration and logout take the same lock before changing ownership or deleting the row.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'companion-notification:installation:' || v_installation_id::text,
    0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'companion-notification:token:' || v_environment::text || ':' || v_bundle_id || ':' ||
      v_device_token,
    0
  ));

  -- Revalidate immediately before the external request. In particular, registration deletes
  -- deliveries when an installation changes account, so a claim captured before that switch can
  -- no longer disclose its preview through the newly assigned physical destination.
  IF EXISTS (
    SELECT 1
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
    WHERE delivery.id = p_id
      AND delivery.claim_token = p_claim_token
      AND delivery.claim_expires_at > clock_timestamp()
      AND delivery.expires_at > clock_timestamp()
      AND device.disabled_at IS NULL
      AND (companion.owner_id = delivery.recipient_user_id OR access.role IS NOT NULL)
  ) THEN
    RETURN true;
  END IF;

  DELETE FROM public.companion_notification_deliveries delivery
  WHERE delivery.id = p_id AND delivery.claim_token = p_claim_token;
  RETURN false;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_complete_notification_delivery(
  p_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  DELETE FROM public.companion_notification_deliveries delivery
  WHERE delivery.id = p_id
    AND delivery.claim_token = p_claim_token
    AND delivery.claim_expires_at > clock_timestamp();
  RETURN FOUND;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_defer_notification_delivery(
  p_id uuid,
  p_claim_token uuid,
  p_retry_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
BEGIN
  IF p_retry_seconds NOT BETWEEN 1 AND 900 THEN
    RAISE EXCEPTION 'invalid notification delivery retry delay' USING ERRCODE = '22023';
  END IF;
  UPDATE public.companion_notification_deliveries delivery
  SET available_at = clock_timestamp() + make_interval(secs => p_retry_seconds),
      claim_token = NULL,
      claim_expires_at = NULL,
      updated_at = clock_timestamp()
  WHERE delivery.id = p_id
    AND delivery.claim_token = p_claim_token
    AND delivery.claim_expires_at > clock_timestamp();
  RETURN FOUND;
END
$$;
--> statement-breakpoint

CREATE FUNCTION public.companion_invalidate_notification_device(
  p_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  v_device_id uuid;
BEGIN
  SELECT delivery.device_id INTO v_device_id
  FROM public.companion_notification_deliveries delivery
  WHERE delivery.id = p_id
    AND delivery.claim_token = p_claim_token
    AND delivery.claim_expires_at > clock_timestamp()
  FOR UPDATE;
  IF v_device_id IS NULL THEN RETURN false; END IF;
  UPDATE public.companion_notification_devices device
  SET disabled_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE device.id = v_device_id;
  DELETE FROM public.companion_notification_deliveries delivery
  WHERE delivery.device_id = v_device_id;
  RETURN true;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.companion_api_register_notification_device(
  uuid,uuid,text,text,public.companion_notification_environment,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_api_unregister_notification_device(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_notification_enqueue(
  uuid,uuid,text,text,public.companion_notification_event,text,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_notification_terminal_turn() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_notification_pending_decision() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_claim_notification_deliveries(text,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_validate_notification_delivery(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_complete_notification_delivery(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_defer_notification_delivery(uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.companion_invalidate_notification_device(uuid,uuid) FROM PUBLIC;
