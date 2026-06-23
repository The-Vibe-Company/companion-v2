-- Org-wide shared label ("folder") tree. Two org-scoped, RLS-tenanted tables replace the old
-- owner/visibility axis as the only way to organize skills.
--   * `labels`        — the canonical set of paths + per-path appearance; a row here is what lets an
--                       EMPTY folder exist. PK (org_id, path).
--   * `skill_labels`  — the assignment edge: a skill is "filed in" N paths. The path string is stored
--                       directly (no FK to a label id) so rename = a prefix UPDATE and delete = a
--                       prefix DELETE across both tables, and roll-up counts need no join.
-- `text_pattern_ops` indexes on (org_id, path) keep the prefix `LIKE path || '/%'` lookups
-- (roll-up counts, rename/delete cascade) index-friendly.

CREATE TABLE "labels" (
	"org_id" uuid NOT NULL,
	"path" text NOT NULL,
	"color" text,
	"icon" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labels_org_id_path_pk" PRIMARY KEY("org_id","path")
);
--> statement-breakpoint
CREATE TABLE "skill_labels" (
	"org_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"path" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_labels_org_id_skill_id_path_pk" PRIMARY KEY("org_id","skill_id","path")
);
--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_labels" ADD CONSTRAINT "skill_labels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_labels" ADD CONSTRAINT "skill_labels_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_labels" ADD CONSTRAINT "skill_labels_skill_org_fk" FOREIGN KEY ("org_id","skill_id") REFERENCES "public"."skills"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "labels_org_path_idx" ON "labels" USING btree ("org_id","path" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "skill_labels_org_path_idx" ON "skill_labels" USING btree ("org_id","path" text_pattern_ops);--> statement-breakpoint

ALTER TABLE "labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "labels_tenant_rls" ON "labels"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY "skill_labels_tenant_rls" ON "skill_labels"
  USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
