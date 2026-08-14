-- Permission broker cards (THE-349): Pi pauses shell / file / questions behind an
-- extension_ui_request; the control plane projects one decision row per request and settles it
-- when Owner/Editor Allow / Deny / answer, or when the fail-closed timeout expires.

ALTER TYPE "companion_transcript_role" ADD VALUE IF NOT EXISTS 'decision';--> statement-breakpoint

ALTER TABLE "companion_transcript_entries" ADD COLUMN "decision" jsonb;--> statement-breakpoint

ALTER TABLE "companion_transcript_entries"
  ADD CONSTRAINT "companion_transcript_entries_decision_role_check"
  CHECK (("role"::text = 'decision') = ("decision" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "companion_transcript_entries"
  ADD CONSTRAINT "companion_transcript_entries_decision_size_check"
  CHECK ("decision" IS NULL OR octet_length("decision"::text) <= 262144);--> statement-breakpoint
