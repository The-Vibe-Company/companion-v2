CREATE TABLE "skill_installs" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"skill_id" uuid NOT NULL,
	"installed_version" text,
	"agent_label" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_installs_org_id_user_id_skill_id_pk" PRIMARY KEY("org_id","user_id","skill_id"),
	CONSTRAINT "skill_installs_source_check" CHECK ("source" IN ('agent','manual'))
);
--> statement-breakpoint
ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_installs_org_user_idx" ON "skill_installs" USING btree ("org_id","user_id");--> statement-breakpoint
ALTER TABLE "skill_installs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "skill_installs_tenant_rls" ON "skill_installs"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
