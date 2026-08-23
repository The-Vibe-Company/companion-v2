-- The companion runtime image becomes a durable registry entity. Builders claim rows with an
-- epoch lease; consumers read published status instead of racing an in-process baker.

CREATE TYPE public.companion_image_status AS ENUM ('requested', 'building', 'ready', 'failed');

CREATE TABLE public.companion_images (
  digest text PRIMARY KEY,
  image_name text NOT NULL UNIQUE,
  status public.companion_image_status NOT NULL DEFAULT 'requested',
  parent_image_name text,
  build_box_id text,
  build_delete_intent_at timestamptz,
  build_delete_operation_id text,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  last_error_message text,
  claimed_at timestamptz,
  claim_epoch bigint NOT NULL DEFAULT 0,
  claim_actor_id text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  requested_at timestamptz NOT NULL DEFAULT now(),
  building_at timestamptz,
  ready_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_images_status_check CHECK ((status = 'ready') = (ready_at IS NOT NULL)),
  CONSTRAINT companion_images_error_check CHECK (
    ((last_error_code IS NULL) = (last_error_message IS NULL))
    AND (status <> 'failed' OR last_error_code IS NOT NULL)
    AND (status <> 'ready' OR last_error_code IS NULL)
  ),
  CONSTRAINT companion_images_claim_check CHECK (
    (status = 'building') = (claim_actor_id IS NOT NULL) AND claim_epoch >= 0
  )
);

CREATE INDEX companion_images_buildable_idx
  ON public.companion_images (next_attempt_at, digest)
  WHERE status IN ('requested', 'failed');
