ALTER TABLE "skill_filter_preferences"
  ADD COLUMN "sidebar_order" jsonb DEFAULT '{"mine":[],"org":[]}'::jsonb NOT NULL;
