-- A tool run is its own transcript entry, so it keeps the ordinal that places it between the turns
-- it happened between rather than being folded into one of them.
ALTER TYPE "companion_transcript_role" ADD VALUE IF NOT EXISTS 'tool';--> statement-breakpoint

ALTER TABLE "companion_transcript_entries" ADD COLUMN "tool" jsonb;--> statement-breakpoint

-- Both checks compare the role as text on purpose: PostgreSQL refuses to read an enum label added
-- earlier in the same transaction, and this migration adds 'tool' a few statements up.
ALTER TABLE "companion_transcript_entries"
  ADD CONSTRAINT "companion_transcript_entries_tool_role_check"
  CHECK (("role"::text = 'tool') = ("tool" IS NOT NULL));--> statement-breakpoint

-- One downscaled Box frame plus the run detail. Anything larger is dropped before it reaches a row.
ALTER TABLE "companion_transcript_entries"
  ADD CONSTRAINT "companion_transcript_entries_tool_size_check"
  CHECK ("tool" IS NULL OR octet_length("tool"::text) <= 262144);
