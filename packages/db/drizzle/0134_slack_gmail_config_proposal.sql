-- Keep the database-owned config decision boundary aligned with the shared provider contract.
-- Existing deployments already own this SECURITY DEFINER function and its split-role ACL, so
-- rewrite only the fail-closed provider allowlist and preserve the rest of the function verbatim.
DO $slack_gmail_config_proposal$
DECLARE
  v_signature text := 'public.companion_api_answer_config_decision(uuid,uuid,text,text)';
  v_old_gate text := 'NOT IN (''linear'', ''github'', ''notion'', ''conductor'')';
  v_new_gate text := 'NOT IN (''linear'', ''github'', ''notion'', ''conductor'', ''slack'', ''gmail'')';
  v_definition text;
  v_rewritten text;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Companion config decision surface is missing' USING ERRCODE = '55000';
  END IF;
  IF (
    char_length(v_definition)
    - char_length(replace(v_definition, v_old_gate, ''))
  ) <> char_length(v_old_gate) THEN
    RAISE EXCEPTION 'Companion config provider gate did not match exactly once'
      USING ERRCODE = '55000';
  END IF;
  v_rewritten := replace(v_definition, v_old_gate, v_new_gate);
  EXECUTE v_rewritten;
END
$slack_gmail_config_proposal$;
--> statement-breakpoint

-- CREATE OR REPLACE preserves the existing API-role grant. Keep the public boundary explicit.
REVOKE ALL ON FUNCTION public.companion_api_answer_config_decision(
  uuid, uuid, text, text
) FROM PUBLIC;
