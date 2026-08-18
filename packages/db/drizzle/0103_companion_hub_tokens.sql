-- Skills Hub access for a hosted Companion is unconditional: there is no per-Companion grant to
-- configure. Every Companion's Box receives an ephemeral, runtime-minted token carrying the full
-- Skills Hub scope set, acting as the member whose settings staged the Box. The token is rotated on
-- every staging, erased when the Box stops, and re-checked on every request against the Companion
-- still existing and that member still belonging to the organization.
--
-- This is not the THE-360 permanent Companion PAT that Runtime v2 cut over in 0094. That token was
-- durable, human-issued, and unbounded; this one is short-lived, runtime-issued, and revocable by
-- deleting the Companion or removing the member.

ALTER TABLE public.api_tokens DROP CONSTRAINT api_tokens_source_provenance_check;
--> statement-breakpoint

ALTER TABLE public.api_tokens
  ADD CONSTRAINT api_tokens_source_provenance_check
  CHECK (
    (source_type = 'human' AND source_agent_id IS NULL AND target_workspace_id IS NULL)
    OR (source_type = 'agent_auth' AND source_agent_id IS NOT NULL)
    OR (
      source_type = 'companion'
      AND source_agent_id IS NOT NULL
      AND target_workspace_id IS NULL
      AND source_agent_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  );
--> statement-breakpoint

-- `can_write_skills` predates unconditional access and is no longer a decision anyone makes: every
-- Companion may publish under its settings actor. The column stays for the operation snapshots and
-- projections that already read it, pinned true so it can never contradict the minted token.
ALTER TABLE public.companions ALTER COLUMN can_write_skills SET DEFAULT true;
--> statement-breakpoint

UPDATE public.companions SET can_write_skills = true WHERE can_write_skills IS NOT TRUE;
--> statement-breakpoint

COMMENT ON COLUMN public.companions.can_write_skills IS
  'Legacy THE-360 flag, pinned true: Skills Hub access is unconditional and carried by the ephemeral runtime-minted token.';
