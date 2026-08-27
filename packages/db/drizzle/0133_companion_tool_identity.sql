-- A call id identifies one immutable tool run. Later progress/result projections may arrive without
-- a provider tool name and therefore carry the generic fallback, but they must never erase the
-- concrete identity established by the start event.
CREATE FUNCTION public.companion_preserve_tool_run_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD.role = 'tool'
     AND NEW.role = 'tool'
     AND OLD.tool ->> 'call_id' IS NOT NULL
     AND OLD.tool ->> 'call_id' = NEW.tool ->> 'call_id' THEN
    NEW.tool := jsonb_set(
      jsonb_set(NEW.tool, '{kind}', OLD.tool -> 'kind'),
      '{name}',
      OLD.tool -> 'name'
    );
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_preserve_tool_run_identity() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER companion_transcript_tool_identity_before_update
BEFORE UPDATE OF tool ON public.companion_transcript_entries
FOR EACH ROW
EXECUTE FUNCTION public.companion_preserve_tool_run_identity();
