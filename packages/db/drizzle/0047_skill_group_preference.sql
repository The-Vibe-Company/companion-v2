ALTER TABLE "skill_filter_preferences" ADD COLUMN "group_by" text DEFAULT 'folder' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_filter_preferences" ADD CONSTRAINT "skill_filter_preferences_group_by_check" CHECK ("group_by" in ('folder', 'none'));
