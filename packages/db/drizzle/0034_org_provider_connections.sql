CREATE TABLE "org_provider_connections" (
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"key_name" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_provider_connections_org_id_provider_pk" PRIMARY KEY("org_id","provider"),
	CONSTRAINT "org_provider_connections_key_check" CHECK ("key_name" ~ '^[A-Za-z_][A-Za-z0-9_]*$')
);
--> statement-breakpoint
ALTER TABLE "org_provider_connections" ADD CONSTRAINT "org_provider_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_provider_connections" ADD CONSTRAINT "org_provider_connections_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_provider_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_provider_connections_tenant_rls" ON "org_provider_connections"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
