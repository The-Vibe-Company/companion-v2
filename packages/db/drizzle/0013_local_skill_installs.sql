CREATE TABLE "local_skill_installs" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"skill_key" text NOT NULL,
	"installed_version" text NOT NULL,
	"agent_label" text,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_skill_installs_org_id_user_id_skill_key_pk" PRIMARY KEY("org_id","user_id","skill_key")
);
--> statement-breakpoint
ALTER TABLE "local_skill_installs" ADD CONSTRAINT "local_skill_installs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_skill_installs" ADD CONSTRAINT "local_skill_installs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_skill_installs_org_user_idx" ON "local_skill_installs" USING btree ("org_id","user_id");--> statement-breakpoint
ALTER TABLE "local_skill_installs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "local_skill_installs_tenant_rls" ON "local_skill_installs"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
