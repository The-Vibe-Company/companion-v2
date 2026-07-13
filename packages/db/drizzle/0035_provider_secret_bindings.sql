CREATE TABLE "user_provider_connections" (
  "org_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "provider" text NOT NULL,
  "key_name" text NOT NULL,
  "secret_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_provider_connections_pk" PRIMARY KEY("org_id", "user_id", "provider"),
  CONSTRAINT "user_provider_connections_key_check" CHECK ("key_name" ~ '^[A-Za-z_][A-Za-z0-9_]*$')
);--> statement-breakpoint

CREATE TABLE "org_provider_connections" (
  "org_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "key_name" text NOT NULL,
  "secret_id" uuid NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_provider_connections_pk" PRIMARY KEY("org_id", "provider"),
  CONSTRAINT "org_provider_connections_key_check" CHECK ("key_name" ~ '^[A-Za-z_][A-Za-z0-9_]*$')
);--> statement-breakpoint

ALTER TABLE "user_provider_connections" ADD CONSTRAINT "user_provider_connections_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "user_provider_connections" ADD CONSTRAINT "user_provider_connections_user_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "user_provider_connections" ADD CONSTRAINT "user_provider_connections_member_org_fk" FOREIGN KEY ("org_id", "user_id") REFERENCES "memberships"("org_id", "user_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "user_provider_connections" ADD CONSTRAINT "user_provider_connections_secret_org_fk" FOREIGN KEY ("org_id", "secret_id") REFERENCES "secrets"("org_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "org_provider_connections" ADD CONSTRAINT "org_provider_connections_org_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "org_provider_connections" ADD CONSTRAINT "org_provider_connections_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "org_provider_connections" ADD CONSTRAINT "org_provider_connections_secret_org_fk" FOREIGN KEY ("org_id", "secret_id") REFERENCES "secrets"("org_id", "id") ON DELETE restrict;--> statement-breakpoint

CREATE INDEX "user_provider_connections_secret_idx" ON "user_provider_connections" ("org_id", "secret_id");--> statement-breakpoint
CREATE INDEX "org_provider_connections_secret_idx" ON "org_provider_connections" ("org_id", "secret_id");--> statement-breakpoint

CREATE FUNCTION companion_validate_provider_secret_binding() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  bound_key text;
  bound_audience public."secret_audience";
  bound_owner_id text;
  bound_disabled_at timestamp with time zone;
  bound_deleted_at timestamp with time zone;
  binding_user text;
BEGIN
  SELECT s."key", s."audience", s."owner_id", s."disabled_at", s."deleted_at"
  INTO bound_key, bound_audience, bound_owner_id, bound_disabled_at, bound_deleted_at
  FROM public."secrets" s
  WHERE s."org_id" = NEW."org_id" AND s."id" = NEW."secret_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'secret unavailable' USING ERRCODE = '23503';
  END IF;
  IF bound_disabled_at IS NOT NULL OR bound_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'secret unavailable' USING ERRCODE = '23514';
  END IF;
  IF bound_key <> NEW."key_name" THEN
    RAISE EXCEPTION 'provider key must match the bound secret key' USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'org_provider_connections' THEN
    IF bound_audience <> 'organization' THEN
      RAISE EXCEPTION 'workspace provider bindings require an organization secret' USING ERRCODE = '23514';
    END IF;
  ELSE
    binding_user := NEW."user_id";
    IF NOT (
      bound_owner_id = binding_user
      OR bound_audience = 'organization'
      OR (
        bound_audience = 'restricted'
        AND EXISTS (
          SELECT 1 FROM public."secret_recipients" r
          WHERE r."org_id" = NEW."org_id"
            AND r."secret_id" = NEW."secret_id"
            AND r."user_id" = binding_user
        )
      )
    ) THEN
      RAISE EXCEPTION 'secret unavailable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER user_provider_connections_validate BEFORE INSERT OR UPDATE OF "secret_id", "key_name" ON "user_provider_connections" FOR EACH ROW EXECUTE FUNCTION companion_validate_provider_secret_binding();--> statement-breakpoint
CREATE TRIGGER org_provider_connections_validate BEFORE INSERT OR UPDATE OF "secret_id", "key_name" ON "org_provider_connections" FOR EACH ROW EXECUTE FUNCTION companion_validate_provider_secret_binding();--> statement-breakpoint

ALTER TABLE "user_provider_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_provider_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_provider_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_provider_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "user_provider_connections_owner" ON "user_provider_connections" USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND "user_id" = NULLIF(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM "memberships" m WHERE m."org_id" = "user_provider_connections"."org_id" AND m."user_id" = "user_provider_connections"."user_id")
) WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND "user_id" = NULLIF(current_setting('app.user_id', true), '')
  AND EXISTS (SELECT 1 FROM "memberships" m WHERE m."org_id" = "user_provider_connections"."org_id" AND m."user_id" = "user_provider_connections"."user_id")
);--> statement-breakpoint
CREATE POLICY "org_provider_connections_tenant" ON "org_provider_connections" USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM "memberships" m WHERE m."org_id" = "org_provider_connections"."org_id" AND m."user_id" = NULLIF(current_setting('app.user_id', true), ''))
) WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM "memberships" m WHERE m."org_id" = "org_provider_connections"."org_id" AND m."user_id" = NULLIF(current_setting('app.user_id', true), ''))
);
