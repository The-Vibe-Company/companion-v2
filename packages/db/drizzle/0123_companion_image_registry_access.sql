-- The image registry is runtime-owned infrastructure without tenant columns or RLS. Consistent
-- with every other Runtime v2 surface, the executor reaches it through narrow SECURITY DEFINER
-- functions instead of ambient table privileges. The table itself receives no role grants;
-- scripts/runtime-role-grants.sql revokes it from every process role.

CREATE FUNCTION public.companion_runtime_image_request(
  p_digest text,
  p_image_name text
)
RETURNS public.companion_images
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.companion_images (digest, image_name)
  VALUES (p_digest, p_image_name)
  ON CONFLICT (digest) DO UPDATE
    SET status = 'requested',
        attempt_count = 0,
        last_error_code = null,
        last_error_message = null,
        next_attempt_at = now(),
        updated_at = now()
    WHERE public.companion_images.status = 'failed'
      AND public.companion_images.updated_at < now() - make_interval(secs => 600);
  RETURN (
    SELECT row FROM public.companion_images row WHERE row.digest = p_digest
  );
END;
$$;

CREATE FUNCTION public.companion_runtime_image_get(p_digest text)
RETURNS public.companion_images
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT row FROM public.companion_images row WHERE row.digest = p_digest;
$$;

CREATE FUNCTION public.companion_runtime_image_claim(
  p_executor_id text,
  p_digest text,
  p_image_name text
)
RETURNS TABLE (
  image_digest text,
  image_name text,
  image_claim_epoch bigint,
  image_attempt_count integer,
  image_build_box_id text,
  image_build_delete_intent_recorded boolean,
  image_build_delete_operation_id text,
  image_recovery_only boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT
      row.digest,
      row.status = 'building' AND row.attempt_count >= 4 AS recovery_only
    FROM public.companion_images row
    WHERE row.digest = p_digest
      AND row.image_name = p_image_name
      AND (
        (row.status IN ('requested', 'failed')
          AND row.next_attempt_at <= now()
          AND row.attempt_count < 4)
        OR (row.status = 'building' AND row.lease_expires_at < now())
      )
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE public.companion_images target
    SET status = 'building',
        claim_epoch = coalesce(target.claim_epoch, 0) + 1,
        claim_actor_id = p_executor_id,
        claimed_at = now(),
        lease_expires_at = now() + make_interval(secs => 1800),
        building_at = coalesce(target.building_at, now()),
        attempt_count = CASE
          WHEN candidate.recovery_only THEN target.attempt_count
          ELSE target.attempt_count + 1
        END,
        last_error_code = null,
        last_error_message = null,
        updated_at = now()
    FROM candidate
    WHERE target.digest = candidate.digest
    RETURNING
      target.digest,
      target.image_name,
      target.claim_epoch,
      target.attempt_count,
      target.build_box_id,
      target.build_delete_intent_at IS NOT NULL AS delete_intent_recorded,
      target.build_delete_operation_id,
      candidate.recovery_only
  )
  SELECT
    claimed.digest,
    claimed.image_name,
    claimed.claim_epoch,
    claimed.attempt_count,
    claimed.build_box_id,
    claimed.delete_intent_recorded,
    claimed.build_delete_operation_id,
    claimed.recovery_only
  FROM claimed;
END;
$$;

CREATE FUNCTION public.companion_runtime_image_clear_building_box(
  p_digest text,
  p_claim_epoch bigint,
  p_build_box_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.companion_images
  SET build_box_id = null,
      build_delete_intent_at = null,
      build_delete_operation_id = null,
      updated_at = now()
  WHERE digest = p_digest
    AND claim_epoch = p_claim_epoch
    AND status = 'building'
    AND build_box_id = p_build_box_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

CREATE FUNCTION public.companion_runtime_image_mark_delete_intent(
  p_digest text,
  p_claim_epoch bigint,
  p_build_box_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.companion_images
  SET build_delete_intent_at = coalesce(build_delete_intent_at, now()), updated_at = now()
  WHERE digest = p_digest
    AND claim_epoch = p_claim_epoch
    AND status = 'building'
    AND build_box_id = p_build_box_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

CREATE FUNCTION public.companion_runtime_image_mark_delete_operation(
  p_digest text,
  p_claim_epoch bigint,
  p_build_box_id text,
  p_operation_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.companion_images
  SET build_delete_operation_id = p_operation_id, updated_at = now()
  WHERE digest = p_digest
    AND claim_epoch = p_claim_epoch
    AND status = 'building'
    AND build_box_id = p_build_box_id
    AND build_delete_intent_at IS NOT NULL
    AND (
      build_delete_operation_id IS NULL
      OR build_delete_operation_id = p_operation_id
    );
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

CREATE FUNCTION public.companion_runtime_image_mark_building_box(
  p_digest text,
  p_claim_epoch bigint,
  p_build_box_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.companion_images
  SET build_box_id = p_build_box_id,
      build_delete_intent_at = null,
      build_delete_operation_id = null,
      updated_at = now()
  WHERE digest = p_digest AND claim_epoch = p_claim_epoch AND status = 'building';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

CREATE FUNCTION public.companion_runtime_image_record_ready(
  p_digest text,
  p_claim_epoch bigint,
  p_image_name text,
  p_parent_image_name text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.companion_images
  SET status = 'ready',
      ready_at = now(),
      parent_image_name = p_parent_image_name,
      build_box_id = null,
      build_delete_intent_at = null,
      build_delete_operation_id = null,
      claim_actor_id = null,
      claimed_at = null,
      lease_expires_at = null,
      updated_at = now()
  WHERE digest = p_digest AND claim_epoch = p_claim_epoch AND status = 'building';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

CREATE FUNCTION public.companion_runtime_image_record_failure(
  p_digest text,
  p_claim_epoch bigint,
  p_error_code text,
  p_error_message text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_new_status public.companion_image_status;
BEGIN
  IF p_error_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'image build error code must be a stable snake_case token';
  END IF;
  UPDATE public.companion_images
  SET status = (case when attempt_count >= 4 then 'failed' else 'requested' end
      )::public.companion_image_status,
      next_attempt_at = now() + make_interval(secs => CASE attempt_count
        WHEN 1 THEN 30
        WHEN 2 THEN 60
        WHEN 3 THEN 120
        ELSE 300
      END),
      last_error_code = p_error_code,
      last_error_message = left(p_error_message, 500),
      claim_actor_id = null,
      claimed_at = null,
      lease_expires_at = null,
      updated_at = now()
  WHERE digest = p_digest AND claim_epoch = p_claim_epoch AND status = 'building';
  IF NOT FOUND THEN
    RETURN 'lease_lost';
  END IF;
  SELECT status INTO v_new_status FROM public.companion_images WHERE digest = p_digest;
  RETURN v_new_status::text;
END;
$$;
