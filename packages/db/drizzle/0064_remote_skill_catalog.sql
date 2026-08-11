-- Split the old overloaded "installed" marker into independent delivery modes.
-- Every existing row represented a skill the user had already added and a locally reported copy,
-- so it becomes Both while retaining its exact installed_version and chronology.
ALTER TABLE public.skill_installs
  ADD COLUMN remote_enabled_at timestamptz,
  ADD COLUMN local_installed_at timestamptz;--> statement-breakpoint

UPDATE public.skill_installs
SET remote_enabled_at = installed_at,
    local_installed_at = installed_at;--> statement-breakpoint

-- Keep old application instances safe during a rolling deployment. Legacy writers omit both new
-- columns; only that shape is upgraded to Both. New writers always provide at least one mode.
CREATE OR REPLACE FUNCTION public.skill_installs_legacy_delivery_defaults()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.remote_enabled_at IS NULL AND NEW.local_installed_at IS NULL THEN
    NEW.remote_enabled_at := NEW.installed_at;
    NEW.local_installed_at := NEW.installed_at;
  ELSIF TG_OP = 'UPDATE'
    AND NEW.remote_enabled_at IS NOT DISTINCT FROM OLD.remote_enabled_at
    AND NEW.local_installed_at IS NOT DISTINCT FROM OLD.local_installed_at
    AND (
      NEW.installed_version IS DISTINCT FROM OLD.installed_version
      OR NEW.agent_label IS DISTINCT FROM OLD.agent_label
      OR NEW.source IS DISTINCT FROM OLD.source
      OR NEW.last_reported_at IS DISTINCT FROM OLD.last_reported_at
    )
    -- A legacy ON CONFLICT writer cannot mention either v2 column anywhere in its statement.
    -- New writers always name at least one delivery column, including intentional disable/remove.
    AND position('remote_enabled_at' IN lower(current_query())) = 0
    AND position('local_installed_at' IN lower(current_query())) = 0
  THEN
    NEW.remote_enabled_at := COALESCE(NEW.last_reported_at, NEW.installed_at, now());
    NEW.local_installed_at := COALESCE(NEW.last_reported_at, NEW.installed_at, now());
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER skill_installs_legacy_delivery_defaults
BEFORE INSERT OR UPDATE ON public.skill_installs
FOR EACH ROW
EXECUTE FUNCTION public.skill_installs_legacy_delivery_defaults();--> statement-breakpoint

ALTER TABLE public.skill_installs
  ADD CONSTRAINT skill_installs_delivery_check
  CHECK (remote_enabled_at IS NOT NULL OR local_installed_at IS NOT NULL);
