-- Global Better Auth Agent Auth identities. These are user/host identity records rather than
-- tenant-owned business data; every capability invocation still supplies and revalidates an exact
-- workspace constraint before Core is called.
CREATE TABLE "agent_host" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text,
  "user_id" text REFERENCES "user"("id") ON DELETE cascade,
  "default_capabilities" text,
  "public_key" text,
  "kid" text,
  "jwks_url" text,
  "enrollment_token_hash" text,
  "enrollment_token_expires_at" timestamp with time zone,
  "status" text DEFAULT 'active' NOT NULL,
  "activated_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_host_remote_jwks_disabled" CHECK ("jwks_url" IS NULL)
);--> statement-breakpoint
CREATE INDEX "agent_host_user_id_idx" ON "agent_host" ("user_id");--> statement-breakpoint
CREATE INDEX "agent_host_kid_idx" ON "agent_host" ("kid");--> statement-breakpoint
CREATE INDEX "agent_host_enrollment_token_hash_idx" ON "agent_host" ("enrollment_token_hash");--> statement-breakpoint
CREATE INDEX "agent_host_status_idx" ON "agent_host" ("status");--> statement-breakpoint

CREATE TABLE "agent" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "user_id" text REFERENCES "user"("id") ON DELETE cascade,
  "host_id" text NOT NULL REFERENCES "agent_host"("id") ON DELETE cascade,
  "status" text DEFAULT 'active' NOT NULL,
  "mode" text DEFAULT 'delegated' NOT NULL,
  "public_key" text NOT NULL,
  "kid" text,
  "jwks_url" text,
  "last_used_at" timestamp with time zone,
  "activated_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "metadata" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_remote_jwks_disabled" CHECK ("jwks_url" IS NULL)
);--> statement-breakpoint
CREATE INDEX "agent_user_id_idx" ON "agent" ("user_id");--> statement-breakpoint
CREATE INDEX "agent_host_id_idx" ON "agent" ("host_id");--> statement-breakpoint
CREATE INDEX "agent_status_idx" ON "agent" ("status");--> statement-breakpoint
CREATE INDEX "agent_kid_idx" ON "agent" ("kid");--> statement-breakpoint

CREATE TABLE "agent_capability_grant" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL REFERENCES "agent"("id") ON DELETE cascade,
  "capability" text NOT NULL,
  "denied_by" text REFERENCES "user"("id") ON DELETE cascade,
  "granted_by" text REFERENCES "user"("id") ON DELETE cascade,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "reason" text,
  "constraints" text
);--> statement-breakpoint
CREATE INDEX "agent_capability_grant_agent_id_idx" ON "agent_capability_grant" ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_capability_grant_capability_idx" ON "agent_capability_grant" ("capability");--> statement-breakpoint
CREATE INDEX "agent_capability_grant_granted_by_idx" ON "agent_capability_grant" ("granted_by");--> statement-breakpoint
CREATE INDEX "agent_capability_grant_status_idx" ON "agent_capability_grant" ("status");--> statement-breakpoint
-- Agent Auth 0.6.2 stores only capability names on approval requests. Without this invariant,
-- two concurrent requests for the same capability under different workspace constraints are
-- indistinguishable at approval time and the upstream approval handler would activate both.
CREATE UNIQUE INDEX "agent_capability_grant_one_pending_capability_idx"
  ON "agent_capability_grant" ("agent_id", "capability")
  WHERE "status" = 'pending';--> statement-breakpoint

CREATE TABLE "approval_request" (
  "id" text PRIMARY KEY NOT NULL,
  "method" text NOT NULL,
  "agent_id" text REFERENCES "agent"("id") ON DELETE cascade,
  "host_id" text REFERENCES "agent_host"("id") ON DELETE cascade,
  "user_id" text REFERENCES "user"("id") ON DELETE cascade,
  "capabilities" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "user_code_hash" text,
  "login_hint" text,
  "binding_message" text,
  "client_notification_token" text,
  "client_notification_endpoint" text,
  "delivery_mode" text,
  "interval" integer NOT NULL,
  "last_polled_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "approval_request_agent_id_idx" ON "approval_request" ("agent_id");--> statement-breakpoint
CREATE INDEX "approval_request_host_id_idx" ON "approval_request" ("host_id");--> statement-breakpoint
CREATE INDEX "approval_request_user_id_idx" ON "approval_request" ("user_id");--> statement-breakpoint
CREATE INDEX "approval_request_status_idx" ON "approval_request" ("status");--> statement-breakpoint

-- Ticket consumption is a second, transactional authorization boundary after Agent Auth capability
-- execution. Revalidate the exact active delegated identity and grant here so native host, agent, or
-- capability revocation (and expiry) immediately invalidates every already-issued 60-second ticket,
-- even if the application-level eager ticket-revocation hook did not run.
CREATE FUNCTION companion_agent_transfer_ticket_auth_active(
  p_user_id text,
  p_agent_id text,
  p_agent_grant_id text,
  p_action text,
  p_org_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."agent" a
    JOIN public."agent_host" h ON h."id" = a."host_id"
    JOIN public."agent_capability_grant" g
      ON g."id" = p_agent_grant_id AND g."agent_id" = a."id"
    WHERE a."id" = p_agent_id
      AND a."user_id" = p_user_id
      AND (h."user_id" IS NULL OR h."user_id" = p_user_id)
      AND a."mode" = 'delegated'
      AND a."status" = 'active'
      AND h."status" = 'active'
      AND g."status" = 'active'
      AND (a."expires_at" IS NULL OR a."expires_at" > statement_timestamp())
      AND (h."expires_at" IS NULL OR h."expires_at" > statement_timestamp())
      AND (g."expires_at" IS NULL OR g."expires_at" > statement_timestamp())
      AND g."capability" = CASE p_action
        WHEN 'public_skill_package.download' THEN 'public-skills:install'
        WHEN 'skill_package.download' THEN 'skills:read'
        WHEN 'skill_file.download' THEN 'skills:read'
        WHEN 'skill_package.upload' THEN 'skills:write'
        WHEN 'local_skill.download' THEN 'skills:read'
        ELSE NULL
      END
      AND (
        p_action = 'public_skill_package.download'
        OR (
          p_action IN ('skill_package.download', 'skill_file.download', 'skill_package.upload', 'local_skill.download')
          AND g."constraints" IS NOT NULL
          AND (
            g."constraints"::jsonb ->> 'workspaceId' = p_org_id::text
            OR g."constraints"::jsonb #>> '{workspaceId,eq}' = p_org_id::text
          )
        )
      )
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_agent_transfer_ticket_auth_active(text, text, text, text, uuid) FROM PUBLIC;--> statement-breakpoint

-- Reject a fake upload ticket before the API reads or hashes a potentially 32 MiB request body.
-- This is deliberately non-consuming: the exact checksum/size binding is still checked atomically
-- by companion_consume_agent_transfer_ticket after the authenticated body has been read.
CREATE FUNCTION companion_preflight_agent_transfer_ticket(
  p_token_hash text,
  p_action text,
  p_skill_slug text,
  p_version text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."agent_transfer_tickets" t
    JOIN public."user" u ON u."id" = t."user_id" AND u."email_verified" = true
    JOIN public."memberships" m ON m."org_id" = t."org_id" AND m."user_id" = t."user_id"
    WHERE t."token_hash" = p_token_hash
      AND p_action = 'skill_package.upload'
      AND t."action" = p_action
      AND t."skill_slug" = p_skill_slug
      AND t."version" = p_version
      AND t."expires_at" > statement_timestamp()
      AND t."revoked_at" IS NULL
      AND t."consumed_at" IS NULL
      AND t."failed_at" IS NULL
      AND public.companion_agent_transfer_ticket_auth_active(
        t."user_id", t."agent_id", t."agent_grant_id", t."action", t."org_id"
      )
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_preflight_agent_transfer_ticket(text, text, text, text) FROM PUBLIC;--> statement-breakpoint

-- Storage reads happen after the one-use ticket transaction commits. Re-resolve the consumed ticket
-- by its hash immediately before the API emits bytes (or commits an upload) so every mutable
-- identity, membership, and public-release predicate is observed without trusting application fields.
CREATE FUNCTION companion_revalidate_agent_transfer_ticket(p_token_hash text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."agent_transfer_tickets" t
    JOIN public."user" u ON u."id" = t."user_id" AND u."email_verified" = true
    WHERE t."token_hash" = p_token_hash
      AND t."consumed_at" IS NOT NULL
      AND t."revoked_at" IS NULL
      AND t."failed_at" IS NULL
      AND t."expires_at" > statement_timestamp()
      AND public.companion_agent_transfer_ticket_auth_active(
        t."user_id", t."agent_id", t."agent_grant_id", t."action", t."org_id"
      )
      AND (
        (
          t."action" = 'public_skill_package.download'
          AND EXISTS (
            SELECT 1
            FROM public."skills" s
            JOIN public."skill_versions" v
              ON v."org_id" = s."org_id"
              AND v."skill_id" = s."id"
              AND v."id" = s."public_version_id"
            WHERE s."org_id" = t."org_id"
              AND s."id" = t."skill_id"
              AND s."share_token" = t."share_token"
              AND s."slug" = t."skill_slug"
              AND s."scope" = 'org'
              AND s."archived_at" IS NULL
              AND v."id" = t."skill_version_id"
              AND v."version" = t."version"
              AND s."public_package_checksum" = t."checksum"
              AND s."public_package_size_bytes" = t."size_bytes"
          )
        )
        OR (
          t."action" IN ('skill_package.download', 'skill_file.download', 'skill_package.upload', 'local_skill.download')
          AND EXISTS (
            SELECT 1
            FROM public."memberships" m
            WHERE m."org_id" = t."org_id" AND m."user_id" = t."user_id"
          )
        )
      )
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_revalidate_agent_transfer_ticket(text) FROM PUBLIC;--> statement-breakpoint

-- Shared secondary storage keeps replay/rate-limit state consistent across API replicas. It must
-- exist before the Agent Auth plugin starts; limits intentionally stay enabled in local development.
CREATE TABLE "agent_auth_ephemeral" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "agent_auth_ephemeral_expires_at_idx" ON "agent_auth_ephemeral" ("expires_at");
