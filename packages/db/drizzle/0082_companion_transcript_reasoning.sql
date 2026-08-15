-- Pi's thinking is kept beside the reply it produced instead of being dropped in projection, so the
-- thread can disclose why an answer happened. It is a column on the assistant row rather than a row
-- of its own: the thinking keeps that reply's ordinal, cannot be read without it, and is removed
-- with the Companion the row already cascades from.

ALTER TABLE "companion_transcript_entries" ADD COLUMN "reasoning" text;--> statement-breakpoint

-- The role is compared as text for the same reason the tool and decision checks are: the enum and
-- its labels are read as text everywhere in this table's constraints.
ALTER TABLE "companion_transcript_entries"
  ADD CONSTRAINT "companion_transcript_entries_reasoning_role_check"
  CHECK ("reasoning" IS NULL OR "role"::text = 'assistant');--> statement-breakpoint

-- The contract caps reasoning at 16 000 UTF-16 units, which cannot encode to more than 48 000 UTF-8
-- bytes; this is that bound. A looser one would not be the backstop it is written to be.
ALTER TABLE "companion_transcript_entries"
  ADD CONSTRAINT "companion_transcript_entries_reasoning_size_check"
  CHECK ("reasoning" IS NULL OR octet_length("reasoning") <= 48000);--> statement-breakpoint
