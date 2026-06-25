ALTER TABLE "skills" ADD COLUMN "share_token" text;

UPDATE "skills"
SET "share_token" = substr(replace(gen_random_uuid()::text,'-',''),1,16)
WHERE "share_token" IS NULL;

ALTER TABLE "skills" ALTER COLUMN "share_token" SET DEFAULT substr(replace(gen_random_uuid()::text,'-',''),1,16);
ALTER TABLE "skills" ALTER COLUMN "share_token" SET NOT NULL;
ALTER TABLE "skills" ADD CONSTRAINT "skills_share_token_unique" UNIQUE("share_token");
