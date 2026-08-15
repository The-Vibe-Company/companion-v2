-- A timeout can leave Pi's execution process blocked even after its FIFO accepted and watermarked
-- follow-ups. Record both the timeout for which a fresh Pi process started and the last user entry
-- that process accepted. Restart and delivery progress are separate so a failed first prompt keeps
-- the entire protected tail without letting concurrent sends repeatedly recycle the recovered Pi.
ALTER TABLE "companion_threads" ADD COLUMN "timeout_restart_ordinal" integer;--> statement-breakpoint
ALTER TABLE "companion_threads" ADD COLUMN "timeout_delivery_ordinal" integer;--> statement-breakpoint

ALTER TABLE "companion_threads"
  ADD CONSTRAINT "companion_threads_timeout_restart_ordinal_check"
  CHECK ("timeout_restart_ordinal" is null or "timeout_restart_ordinal" >= 0);--> statement-breakpoint

ALTER TABLE "companion_threads"
  ADD CONSTRAINT "companion_threads_timeout_delivery_ordinal_check"
  CHECK ("timeout_delivery_ordinal" is null or "timeout_delivery_ordinal" >= 0);
