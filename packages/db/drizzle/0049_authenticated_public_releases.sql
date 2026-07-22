-- A public share link may pin exactly one immutable version. Existing skills stay metadata-only.
ALTER TABLE "skills" ADD COLUMN "public_version_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "public_package_checksum" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "public_package_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "public_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_public_version_org_skill_fk"
  FOREIGN KEY ("org_id", "id", "public_version_id")
  REFERENCES "skill_versions"("org_id", "skill_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
CREATE INDEX "skills_public_version_idx" ON "skills" ("org_id", "public_version_id");--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_public_release_complete_check" CHECK (
  (
    "public_version_id" IS NULL AND "public_package_checksum" IS NULL
    AND "public_package_size_bytes" IS NULL AND "public_released_at" IS NULL
  ) OR (
    "public_version_id" IS NOT NULL AND "public_package_checksum" IS NOT NULL
    AND "public_package_size_bytes" IS NOT NULL AND "public_released_at" IS NOT NULL
  )
);--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_public_package_checksum_check"
  CHECK ("public_package_checksum" IS NULL OR "public_package_checksum" ~ '^sha256:[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_public_package_size_check"
  CHECK ("public_package_size_bytes" IS NULL OR "public_package_size_bytes" >= 0);--> statement-breakpoint

-- Binary transfer tickets are tenant-owned business data. The raw bearer is never persisted.
CREATE TABLE "agent_transfer_tickets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "agent_id" text NOT NULL,
  "agent_grant_id" text,
  "action" text NOT NULL,
  "skill_id" uuid,
  "skill_version_id" uuid,
  "share_token" text,
  "skill_slug" text NOT NULL,
  "version" text NOT NULL,
  "file_path" text,
  "checksum" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_transfer_tickets_action_check"
    CHECK ("action" IN ('public_skill_package.download', 'skill_package.download', 'skill_file.download', 'skill_package.upload', 'local_skill.download')),
  CONSTRAINT "agent_transfer_tickets_binding_check" CHECK (
    (
      "action" = 'public_skill_package.download'
      AND "skill_id" IS NOT NULL AND "skill_version_id" IS NOT NULL AND "share_token" IS NOT NULL
      AND "file_path" IS NULL
    ) OR (
      "action" = 'skill_package.download'
      AND "skill_id" IS NOT NULL AND "skill_version_id" IS NOT NULL AND "share_token" IS NULL
      AND "file_path" IS NULL
    ) OR (
      "action" = 'skill_file.download'
      AND "skill_id" IS NOT NULL AND "skill_version_id" IS NOT NULL AND "share_token" IS NULL
      AND "file_path" IS NOT NULL AND btrim("file_path") <> ''
    ) OR (
      "action" = 'skill_package.upload'
      AND "skill_version_id" IS NULL AND "share_token" IS NULL
      AND "file_path" IS NULL
    ) OR (
      "action" = 'local_skill.download'
      AND "skill_id" IS NULL AND "skill_version_id" IS NULL AND "share_token" IS NULL
      AND "file_path" IS NULL
    )
  ),
  CONSTRAINT "agent_transfer_tickets_size_check" CHECK ("size_bytes" >= 0),
  CONSTRAINT "agent_transfer_tickets_checksum_check" CHECK ("checksum" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "agent_transfer_tickets_skill_org_fk"
    FOREIGN KEY ("org_id", "skill_id") REFERENCES "skills"("org_id", "id") ON DELETE cascade,
  CONSTRAINT "agent_transfer_tickets_version_org_skill_fk"
    FOREIGN KEY ("org_id", "skill_id", "skill_version_id")
    REFERENCES "skill_versions"("org_id", "skill_id", "id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX "agent_transfer_tickets_expiry_idx" ON "agent_transfer_tickets" ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_transfer_tickets_agent_idx"
  ON "agent_transfer_tickets" ("org_id", "user_id", "agent_id", "created_at");--> statement-breakpoint
ALTER TABLE "agent_transfer_tickets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "agent_transfer_tickets_tenant_rls" ON "agent_transfer_tickets"
  USING ("org_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- Metadata remains anonymous for every live org skill. When a public release is pinned, all
-- version-derived presentation data comes from that immutable version rather than a newer current
-- version. The release columns remain null for metadata-only links.
DROP FUNCTION companion_public_skill_preview(text);--> statement-breakpoint
CREATE FUNCTION companion_public_skill_preview(p_token text)
RETURNS TABLE (
  "slug" text,
  "display_name" text,
  "description" text,
  "creator_name" text,
  "creator_initials" text,
  "current_version" text,
  "frontmatter" text,
  "updated_at" timestamp with time zone,
  "public_version" text,
  "public_checksum" text,
  "public_size_bytes" integer,
  "public_released_at" timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s."slug", s."display_name", s."description", p."name", p."initials",
         current_version."version", coalesce(public_version."frontmatter", current_version."frontmatter"),
         coalesce(s."public_released_at", s."updated_at"), public_version."version",
         s."public_package_checksum", s."public_package_size_bytes", s."public_released_at"
  FROM public."skills" s
  JOIN public."profiles" p ON p."id" = s."creator_id"
  JOIN public."skill_versions" current_version
    ON current_version."org_id" = s."org_id"
   AND current_version."skill_id" = s."id"
   AND current_version."id" = s."current_version_id"
  LEFT JOIN public."skill_versions" public_version
    ON public_version."org_id" = s."org_id"
   AND public_version."skill_id" = s."id"
   AND public_version."id" = s."public_version_id"
  WHERE s."share_token" = p_token AND s."scope" = 'org' AND s."archived_at" IS NULL
  LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_public_skill_preview(text) FROM PUBLIC;--> statement-breakpoint

-- A verified browser session may fetch the exact pinned package without joining the owning org.
-- The function is deliberately exact-token/exact-version and records authorization without exposing
-- the tenant or storage key to the public API response.
CREATE FUNCTION companion_authorize_public_skill_package(
  p_token text,
  p_version text,
  p_user_id text
)
RETURNS TABLE (
  "org_id" uuid,
  "skill_id" uuid,
  "skill_version_id" uuid,
  "slug" text,
  "version" text,
  "storage_path" text,
  "checksum" text,
  "size_bytes" integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  package record;
BEGIN
  SELECT s."org_id", s."id" AS "skill_id", v."id" AS "skill_version_id", s."slug",
         v."version", v."storage_path", s."public_package_checksum" AS "checksum",
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

  INSERT INTO public."audit_log" ("org_id", "actor_id", "action", "target_type", "target_id", "metadata")
  VALUES (
    package."org_id", p_user_id, 'skill.public_package.download_authorized', 'skill',
    package."skill_id"::text,
    jsonb_build_object('version', package."version", 'checksum', package."checksum", 'auth', 'session')
  );

  RETURN QUERY SELECT package."org_id", package."skill_id", package."skill_version_id",
                      package."slug", package."version", package."storage_path",
                      package."checksum", package."size_bytes";
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_authorize_public_skill_package(text, text, text) FROM PUBLIC;--> statement-breakpoint

-- Called only after Agent Auth has authenticated the delegated user/agent and approved
-- public-skills:install. It inserts the hash of a caller-generated random ticket, never plaintext.
CREATE FUNCTION companion_issue_public_skill_transfer_ticket(
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
     OR p_expires_at <= now_at OR p_expires_at > now_at + interval '60 seconds' THEN
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
    p_token_hash, p_expires_at
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
REVOKE ALL ON FUNCTION companion_issue_public_skill_transfer_ticket(text, text, text, text, text, text, timestamp with time zone) FROM PUBLIC;--> statement-breakpoint

-- Atomically consume a ticket and revalidate every mutable/revocable condition. Promotion,
-- withdrawal, archive, account disablement, ticket revocation, expiry, replay, token/version drift,
-- checksum drift, and action mismatch all fail before a storage key is returned.
CREATE FUNCTION companion_consume_public_skill_transfer_ticket(
  p_token_hash text,
  p_token text,
  p_version text
)
RETURNS TABLE (
  "org_id" uuid,
  "skill_id" uuid,
  "skill_version_id" uuid,
  "slug" text,
  "version" text,
  "storage_path" text,
  "checksum" text,
  "size_bytes" integer,
  "user_id" text,
  "agent_id" text,
  "agent_grant_id" text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  ticket record;
  package record;
  now_at timestamp with time zone := clock_timestamp();
BEGIN
  SELECT * INTO ticket
  FROM public."agent_transfer_tickets" t
  WHERE t."token_hash" = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT s."org_id", s."id" AS "skill_id", v."id" AS "skill_version_id", s."slug",
         v."version", v."storage_path", s."public_package_checksum" AS "checksum",
         s."public_package_size_bytes" AS "size_bytes"
    INTO package
  FROM public."skills" s
  JOIN public."skill_versions" v
    ON v."org_id" = s."org_id" AND v."skill_id" = s."id" AND v."id" = s."public_version_id"
  JOIN public."user" u ON u."id" = ticket."user_id" AND u."email_verified" = true
  WHERE s."org_id" = ticket."org_id"
    AND s."id" = ticket."skill_id"
    AND s."share_token" = p_token
    AND s."share_token" = ticket."share_token"
    AND s."slug" = ticket."skill_slug"
    AND s."scope" = 'org'
    AND s."archived_at" IS NULL
    AND v."id" = ticket."skill_version_id"
    AND v."version" = p_version
    AND v."version" = ticket."version"
    AND s."public_package_checksum" = ticket."checksum"
    AND s."public_package_size_bytes" = ticket."size_bytes"
  LIMIT 1;

  IF ticket."action" <> 'public_skill_package.download'
     OR ticket."expires_at" <= now_at
     OR ticket."revoked_at" IS NOT NULL
     OR ticket."consumed_at" IS NOT NULL
     OR ticket."failed_at" IS NOT NULL
     OR NOT public.companion_agent_transfer_ticket_auth_active(
       ticket."user_id", ticket."agent_id", ticket."agent_grant_id",
       ticket."action", ticket."org_id"
     )
     OR NOT FOUND THEN
    IF ticket."consumed_at" IS NULL AND ticket."failed_at" IS NULL THEN
      UPDATE public."agent_transfer_tickets"
      SET "failed_at" = now_at
      WHERE "id" = ticket."id";
      INSERT INTO public."audit_log" ("org_id", "actor_id", "action", "target_type", "target_id", "metadata")
      VALUES (
        ticket."org_id", ticket."user_id", 'skill.public_package.ticket_denied',
        'agent_transfer_ticket', ticket."id"::text,
        jsonb_build_object('reason', 'invalid_expired_replayed_or_revoked', 'agentId', ticket."agent_id")
      );
    END IF;
    RETURN;
  END IF;

  UPDATE public."agent_transfer_tickets"
  SET "consumed_at" = now_at
  WHERE "id" = ticket."id";

  INSERT INTO public."audit_log" ("org_id", "actor_id", "action", "target_type", "target_id", "metadata")
  VALUES (
    ticket."org_id", ticket."user_id", 'skill.public_package.ticket_consume', 'skill',
    ticket."skill_id"::text,
    jsonb_build_object(
      'version', package."version", 'checksum', package."checksum", 'agentId', ticket."agent_id",
      'grantId', ticket."agent_grant_id", 'ticketId', ticket."id"
    )
  );

  RETURN QUERY SELECT package."org_id", package."skill_id", package."skill_version_id",
                      package."slug", package."version", package."storage_path",
                      package."checksum", package."size_bytes", ticket."user_id",
                      ticket."agent_id", ticket."agent_grant_id";
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_consume_public_skill_transfer_ticket(text, text, text) FROM PUBLIC;--> statement-breakpoint

-- Atomically claim a tenant skill package/file upload/download ticket before a tenant context is known. The
-- function validates the immutable request binding plus live user membership, but deliberately does
-- not make the final resource decision: the API re-enters the ordinary Core service under the
-- returned tenant/user context before reading or mutating a package.
CREATE FUNCTION companion_consume_agent_transfer_ticket(
  p_token_hash text,
  p_action text,
  p_skill_slug text,
  p_version text,
  p_checksum text DEFAULT NULL,
  p_size_bytes integer DEFAULT NULL,
  p_file_path text DEFAULT NULL
)
RETURNS TABLE (
  "ticket_id" uuid,
  "org_id" uuid,
  "user_id" text,
  "user_email" text,
  "user_name" text,
  "agent_id" text,
  "agent_grant_id" text,
  "action" text,
  "skill_id" uuid,
  "skill_version_id" uuid,
  "skill_slug" text,
  "version" text,
  "file_path" text,
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
  ticket record;
  now_at timestamp with time zone := clock_timestamp();
  valid_ticket boolean;
BEGIN
  SELECT t.*, u."email" AS "user_email", u."name" AS "user_name",
         u."email_verified" AS "user_email_verified",
         EXISTS (
           SELECT 1
           FROM public."memberships" m
           WHERE m."org_id" = t."org_id" AND m."user_id" = t."user_id"
         ) AS "user_is_member"
    INTO ticket
  FROM public."agent_transfer_tickets" t
  LEFT JOIN public."user" u ON u."id" = t."user_id"
  WHERE t."token_hash" = p_token_hash
  FOR UPDATE OF t;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  valid_ticket :=
    p_action IN ('skill_package.download', 'skill_file.download', 'skill_package.upload', 'local_skill.download')
    AND ticket."action" = p_action
    AND ticket."skill_slug" = p_skill_slug
    AND ticket."version" = p_version
    AND ticket."file_path" IS NOT DISTINCT FROM p_file_path
    AND (p_checksum IS NULL OR ticket."checksum" = p_checksum)
    AND (p_size_bytes IS NULL OR ticket."size_bytes" = p_size_bytes)
    AND (
      p_action <> 'skill_package.upload'
      OR (p_checksum IS NOT NULL AND p_size_bytes IS NOT NULL)
    )
    AND (
      p_action <> 'skill_file.download'
      OR (p_file_path IS NOT NULL AND btrim(p_file_path) <> '')
    )
    AND ticket."expires_at" > now_at
    AND ticket."revoked_at" IS NULL
    AND ticket."consumed_at" IS NULL
    AND ticket."failed_at" IS NULL
    AND ticket."user_email" IS NOT NULL
    AND ticket."user_email_verified" = true
    AND ticket."user_is_member" = true
    AND public.companion_agent_transfer_ticket_auth_active(
      ticket."user_id", ticket."agent_id", ticket."agent_grant_id",
      ticket."action", ticket."org_id"
    );

  IF valid_ticket IS DISTINCT FROM true THEN
    IF ticket."consumed_at" IS NULL AND ticket."failed_at" IS NULL THEN
      UPDATE public."agent_transfer_tickets"
      SET "failed_at" = now_at
      WHERE "id" = ticket."id";
      INSERT INTO public."audit_log" ("org_id", "actor_id", "action", "target_type", "target_id", "metadata")
      VALUES (
        ticket."org_id", ticket."user_id", 'skill.package.ticket_denied',
        'agent_transfer_ticket', ticket."id"::text,
        jsonb_build_object(
          'reason', 'invalid_expired_replayed_revoked_or_membership_changed',
          'operation', ticket."action", 'agentId', ticket."agent_id"
        )
      );
    END IF;
    RETURN;
  END IF;

  UPDATE public."agent_transfer_tickets"
  SET "consumed_at" = now_at
  WHERE "id" = ticket."id";

  INSERT INTO public."audit_log" ("org_id", "actor_id", "action", "target_type", "target_id", "metadata")
  VALUES (
    ticket."org_id", ticket."user_id", 'skill.package.ticket_consume',
    CASE WHEN ticket."skill_id" IS NULL THEN 'agent_transfer_ticket' ELSE 'skill' END,
    coalesce(ticket."skill_id"::text, ticket."id"::text),
    jsonb_build_object(
      'operation', ticket."action", 'slug', ticket."skill_slug", 'version', ticket."version",
      'agentId', ticket."agent_id", 'grantId', ticket."agent_grant_id", 'ticketId', ticket."id"
    )
  );

  RETURN QUERY SELECT ticket."id", ticket."org_id", ticket."user_id", ticket."user_email",
                      ticket."user_name", ticket."agent_id", ticket."agent_grant_id",
                      ticket."action", ticket."skill_id", ticket."skill_version_id",
                      ticket."skill_slug", ticket."version", ticket."file_path", ticket."checksum",
                      ticket."size_bytes", ticket."expires_at";
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_consume_agent_transfer_ticket(text, text, text, text, text, integer, text) FROM PUBLIC;--> statement-breakpoint

-- Agent/grant revocation calls this hook so already-issued 60-second tickets stop immediately.
CREATE FUNCTION companion_revoke_agent_transfer_tickets(
  p_user_id text,
  p_agent_id text,
  p_agent_grant_id text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE public."agent_transfer_tickets" t
  SET "revoked_at" = clock_timestamp()
  WHERE t."user_id" = p_user_id
    AND t."agent_id" = p_agent_id
    AND (p_agent_grant_id IS NULL OR t."agent_grant_id" = p_agent_grant_id)
    AND t."revoked_at" IS NULL
    AND t."consumed_at" IS NULL
    AND t."failed_at" IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_revoke_agent_transfer_tickets(text, text, text) FROM PUBLIC;
