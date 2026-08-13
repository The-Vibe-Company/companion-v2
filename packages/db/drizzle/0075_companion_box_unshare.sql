-- THE-332 follow-up. The restore in 0074 copied each THE-330 pool's runtime onto every Companion in
-- its scope, so several Companions in one workspace ended up recording the same Box id. That is the
-- cardinality 0074 was undoing: one wake would start the shared machine and every other Companion in
-- the scope would keep pointing at the Pi running on it. The adapter now refuses to adopt a Box that
-- does not carry this Companion's own deterministic name, and this drops the ids that made it
-- possible so no path — wake, stop, live status, or thread sync — is handed one after deploy.
--
-- Only ids that match a leftover pool row are cleared, which is exactly what 0074 copied; a Companion
-- that reached its own Box keeps it. The pool table itself stays in place with its rows unused, the
-- same non-destructive cut 0074 made.
UPDATE "companions" c SET
  "box_id" = NULL,
  -- A cleared Box has no machine to be running on, and the chip has to say so rather than read
  -- Online against nothing. The next wake creates 'Companion <companion uuid>' and records it.
  "runtime_state" = 'not_created',
  "daemon_state" = 'unknown',
  "desktop_available" = false,
  -- The stored reason described the shared machine, including the false "Pi event log could not be
  -- read from Box" this deploy also fixes, so it would outlive the Box it was about.
  "last_error" = NULL,
  "last_observed_at" = now(),
  "updated_at" = now()
WHERE c."box_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "companion_runtime_pools" p
    WHERE p."org_id" = c."org_id"
      AND p."box_id" = c."box_id"
  );
