-- The API and PostgreSQL can run on different hosts whose wall clocks differ slightly.
-- Keep PostgreSQL authoritative for the one-minute ticket lifetime: reject already-expired
-- requests, but cap a caller timestamp that is ahead of the database clock instead of rejecting it.
CREATE OR REPLACE FUNCTION companion_issue_public_skill_transfer_ticket(
  p_token text,
  p_version text,
  p_user_id text,
  p_agent_id text,
  p_agent_grant_id text,
  p_token_hash text,
  p_expires_at timestamp with time zone
)
RETURNS TABLE (
  "ticket_id" uuid,
  "org_id" uuid,
  "skill_id" uuid,
  "skill_version_id" uuid,
  "version" text,
  "checksum" text,
  "size_bytes" integer,
  "expires_at" timestamp with time zone
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  package record;
  inserted_ticket record;
  now_at timestamp with time zone := clock_timestamp();
BEGIN
  IF p_agent_id IS NULL OR btrim(p_agent_id) = ''
     OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_expires_at <= now_at THEN
    RETURN;
  END IF;

  SELECT s."org_id", s."id" AS "skill_id", v."id" AS "skill_version_id", s."slug",
         v."version", s."public_package_checksum" AS "checksum",
         s."public_package_size_bytes" AS "size_bytes"
    INTO package
  FROM public."skills" s
  JOIN public."skill_versions" v
    ON v."org_id" = s."org_id" AND v."skill_id" = s."id" AND v."id" = s."public_version_id"
  JOIN public."user" u ON u."id" = p_user_id AND u."email_verified" = true
  WHERE s."share_token" = p_token
    AND s."scope" = 'org'
    AND s."archived_at" IS NULL
    AND v."version" = p_version
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public."agent_transfer_tickets" AS created_ticket (
    "org_id", "user_id", "agent_id", "agent_grant_id", "action", "skill_id",
    "skill_version_id", "share_token", "skill_slug", "version", "checksum", "size_bytes",
    "token_hash", "expires_at"
  ) VALUES (
    package."org_id", p_user_id, p_agent_id, p_agent_grant_id,
    'public_skill_package.download', package."skill_id", package."skill_version_id",
    p_token, package."slug", package."version", package."checksum", package."size_bytes",
    p_token_hash, least(p_expires_at, now_at + interval '60 seconds')
  )
  RETURNING created_ticket."id", created_ticket."expires_at" INTO inserted_ticket;

  INSERT INTO public."audit_log" ("org_id", "actor_id", "action", "target_type", "target_id", "metadata")
  VALUES (
    package."org_id", p_user_id, 'skill.public_package.ticket_issue', 'skill',
    package."skill_id"::text,
    jsonb_build_object(
      'version', package."version", 'checksum', package."checksum", 'agentId', p_agent_id,
      'grantId', p_agent_grant_id, 'ticketId', inserted_ticket."id"
    )
  );

  RETURN QUERY SELECT inserted_ticket."id", package."org_id", package."skill_id",
                      package."skill_version_id", package."version", package."checksum",
                      package."size_bytes", inserted_ticket."expires_at";
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_issue_public_skill_transfer_ticket(
  text, text, text, text, text, text, timestamp with time zone
) FROM PUBLIC;
