ALTER TABLE "companion_transcript_entries" ADD COLUMN "author_id" text;
--> statement-breakpoint
ALTER TABLE "companion_transcript_entries"
  ADD CONSTRAINT "companion_transcript_entries_author_id_user_id_fk"
  FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE SET NULL;
