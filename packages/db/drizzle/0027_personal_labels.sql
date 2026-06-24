-- Per-user personal folder tree. Mirrors `labels` / `skill_labels` (migration 0021) but namespaced per
-- OWNER within an org, so each user's "My Skills" library has its own private folders. Org labels are
-- 100% untouched.
--   * `personal_labels`        — canonical personal paths + appearance; a row lets an EMPTY personal
--                                folder exist. PK (org_id, owner_id, path).
--   * `personal_skill_labels`  — assignment edge: an authored personal skill is "filed in" N personal
--                                paths. Path stored directly (no FK to a label id) so rename = prefix
--                                UPDATE and delete = prefix DELETE across both tables.
-- `text_pattern_ops` indexes on (org_id, owner_id, path) keep prefix lookups index-friendly. RLS is
-- user-scoped (org_id AND owner_id) — stricter than the org-label tables because these rows are
-- private; both GUCs are already set by withTenantContext. The composite `(org_id, skill_id)` FK
-- guarantees the edge's org matches the skill's.

CREATE TABLE "personal_labels" (
	"org_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"path" text NOT NULL,
	"display_name" text,
	"color" text,
	"icon" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_labels_org_owner_path_pk" PRIMARY KEY("org_id","owner_id","path")
);
--> statement-breakpoint
CREATE TABLE "personal_skill_labels" (
	"org_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"skill_id" uuid NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_skill_labels_org_owner_skill_path_pk" PRIMARY KEY("org_id","owner_id","skill_id","path")
);
--> statement-breakpoint
ALTER TABLE "personal_labels" ADD CONSTRAINT "personal_labels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_labels" ADD CONSTRAINT "personal_labels_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_skill_labels" ADD CONSTRAINT "personal_skill_labels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_skill_labels" ADD CONSTRAINT "personal_skill_labels_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_skill_labels" ADD CONSTRAINT "personal_skill_labels_skill_org_fk" FOREIGN KEY ("org_id","skill_id") REFERENCES "public"."skills"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_labels_owner_path_idx" ON "personal_labels" USING btree ("org_id","owner_id","path" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "personal_skill_labels_owner_path_idx" ON "personal_skill_labels" USING btree ("org_id","owner_id","path" text_pattern_ops);--> statement-breakpoint

ALTER TABLE "personal_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "personal_skill_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "personal_labels_owner_rls" ON "personal_labels"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND "owner_id" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND "owner_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint

CREATE POLICY "personal_skill_labels_owner_rls" ON "personal_skill_labels"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND "owner_id" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid AND "owner_id" = NULLIF(current_setting('app.user_id', true), ''));
