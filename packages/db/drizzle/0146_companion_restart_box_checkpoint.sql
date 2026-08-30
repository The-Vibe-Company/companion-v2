-- A restart Box operation stops Pi and applies any deferred Skill update before it asks the
-- provider to restart the Box. Keep that proof as its own durable checkpoint so lease takeover
-- never repeats the Skill update or the provider side effect.
DO $companion_restart_box_checkpoint$
DECLARE
  v_signature text :=
    'public.companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,'
    || 'timestamptz,integer,integer,integer)';
  v_definition text;
  v_old text := $r$      OR (v_operation_kind = 'restart_box' AND (
        (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'restarting_box')
        OR (v_current_checkpoint = 'restarting_box' AND p_next_checkpoint = 'waiting_ready')$r$;
  v_new text := $r$      OR (v_operation_kind = 'restart_box' AND (
        (v_current_checkpoint = 'pending' AND p_next_checkpoint = 'skills_updated')
        OR (v_current_checkpoint = 'skills_updated' AND p_next_checkpoint = 'restarting_box')
        OR (v_current_checkpoint = 'restarting_box' AND p_next_checkpoint = 'waiting_ready')$r$;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  v_count := (
    char_length(v_definition) - char_length(replace(v_definition, v_old, ''))
  ) / char_length(v_old);
  IF v_definition IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'restart Box checkpoint rewrite matched %, expected 1', COALESCE(v_count, 0)
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$companion_restart_box_checkpoint$;
--> statement-breakpoint
