ALTER TABLE "skill_run_prompts" ADD COLUMN "user_text" text;--> statement-breakpoint
UPDATE "skill_run_prompts" p
SET "user_text" = CASE
  WHEN p."kind" = 'initial' THEN r."prompt"
  ELSE p."prompt"
END
FROM "skill_runs" r
WHERE r."org_id" = p."org_id" AND r."id" = p."run_id";--> statement-breakpoint
ALTER TABLE "skill_run_prompts" ALTER COLUMN "user_text" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_run_prompts" ADD CONSTRAINT "skill_run_prompts_identity_uq" UNIQUE("org_id", "run_id", "id");--> statement-breakpoint

ALTER TABLE "skill_run_attachments" ADD COLUMN "prompt_id" uuid;--> statement-breakpoint
UPDATE "skill_run_attachments" a
SET "prompt_id" = p."id"
FROM "skill_run_prompts" p
WHERE p."org_id" = a."org_id" AND p."run_id" = a."run_id" AND p."ordinal" = 0;--> statement-breakpoint
ALTER TABLE "skill_run_attachments" ALTER COLUMN "prompt_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_run_attachments" ADD CONSTRAINT "skill_run_attachments_prompt_fk"
  FOREIGN KEY ("org_id", "run_id", "prompt_id")
  REFERENCES "skill_run_prompts"("org_id", "run_id", "id") ON DELETE cascade;--> statement-breakpoint
