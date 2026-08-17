-- Repair the durable replay boundary for private desktop requests before split-role grants run.
-- Some databases already journalled the original 0091/0092 migrations before these objects were
-- mistakenly added to 0091 in place. Every statement therefore accepts both supported states:
-- the historical schema where the objects are absent and the short-lived schema where they exist.

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

-- Fail closed until the same-connection grant block gives only the dedicated runtime role EXECUTE.
REVOKE ALL ON TABLE public.companion_runtime_desktop_requests FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_consume_desktop_request(text, bigint, integer)
  FROM PUBLIC;
--> statement-breakpoint
