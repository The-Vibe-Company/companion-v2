ALTER TABLE "project_prompts"
  ADD COLUMN "file_reconciliation_event_sequence" integer;--> statement-breakpoint

ALTER TABLE "project_prompts"
  ADD CONSTRAINT "project_prompts_file_reconciliation_check"
  CHECK (
    "file_reconciliation_event_sequence" IS NULL
    OR "file_reconciliation_event_sequence" >= 1
  );--> statement-breakpoint

CREATE INDEX "project_prompts_file_reconciliation_idx"
  ON "project_prompts" ("org_id", "project_id", "completed_at", "id")
  WHERE "status" = 'completed' AND "file_reconciliation_event_sequence" IS NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION companion_claim_project_workspaces(
  p_worker_id text,
  p_limit integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 30
)
RETURNS TABLE (
  "org_id" uuid,
  "project_id" uuid,
  "creator_id" text,
  "status" "project_workspace_status",
  "sandbox_name" text,
  "sandbox_id" text,
  "sandbox_domain" text,
  "checkpoint_id" text,
  "checkpoint_generation" integer,
  "desired_generation" integer,
  "applied_generation" integer,
  "desired_file_revision" integer,
  "applied_file_revision" integer,
  "last_activity_at" timestamp with time zone,
  "idle_deadline_at" timestamp with time zone,
  "activation_revision" integer,
  "authority_revision" text,
  "activation_admission_token" uuid,
  "activation_admission_revision" integer,
  "activation_admission_authority_revision" text,
  "activation_admitted_at" timestamp with time zone,
  "environment_exposure_attempted_at" timestamp with time zone,
  "recycle_requested_at" timestamp with time zone,
  "recycle_reason" text,
  "skill_sync_error_at" timestamp with time zone,
  "skill_sync_error_code" text,
  "skill_sync_error_message" text,
  "lease_generation" integer,
  "delete_requested_at" timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_worker_context text := current_setting('app.project_worker', true);
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 512 THEN
    RAISE EXCEPTION 'valid worker id is required' USING ERRCODE = '22023';
  END IF;
  IF p_limit < 1 OR p_limit > 32 OR p_lease_seconds < 5 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'invalid project workspace claim limits' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.project_worker', 'claim', true);
  RETURN QUERY
  WITH candidates AS (
    SELECT w."org_id", w."project_id"
    FROM public."project_workspaces" w
    JOIN public."projects" p
      ON p."org_id" = w."org_id" AND p."id" = w."project_id"
    WHERE w."available_at" <= clock_timestamp()
      AND (w."lease_expires_at" IS NULL OR w."lease_expires_at" <= clock_timestamp())
      AND (
        p."delete_requested_at" IS NOT NULL
        OR (
          NOT EXISTS (
            SELECT 1 FROM public."memberships" m
            WHERE m."org_id" = w."org_id" AND m."user_id" = w."creator_id"
          )
          AND (
            (
              w."sandbox_id" IS NOT NULL
              AND w."status" NOT IN ('stopped', 'needs_attention', 'deleted')
            )
            OR EXISTS (
              SELECT 1 FROM public."project_prompts" prompt
              WHERE prompt."org_id" = w."org_id"
                AND prompt."project_id" = w."project_id"
                AND prompt."status" IN ('queued', 'dispatching', 'running')
            )
          )
        )
        OR (
          EXISTS (
            SELECT 1 FROM public."memberships" m
            WHERE m."org_id" = w."org_id" AND m."user_id" = w."creator_id"
          )
          AND (
            -- Credential rotation/revocation is an explicit environment boundary, not a functional
            -- retry. An exposed warm runtime must remain claimable even after an unrelated failure.
            (
              w."recycle_requested_at" IS NOT NULL
              AND w."environment_exposure_attempted_at" IS NOT NULL
              AND w."status" NOT IN ('stopped', 'deleted')
            )
            OR (
              w."status" <> 'needs_attention'
              -- An invalid pre-activation environment is stable until a secret/provider signal
              -- explicitly returns it to queued. A newly queued prompt alone must not churn it.
              AND (
                w."status" <> 'error'
                OR w."last_error_code" IS DISTINCT FROM 'project_environment_invalid'
                OR w."recycle_requested_at" IS NOT NULL
              )
              AND (
                w."recycle_requested_at" IS NOT NULL
                OR w."skill_sync_error_at" IS NOT NULL
                -- A worker can crash after durably finishing a prompt but before it installs the
                -- idle deadline. Reclaim every expired running lease even when no prompt remains;
                -- the next supervisor observation is the recovery boundary for both that case and
                -- a crash during an in-flight turn.
                OR w."status" IN ('queued', 'provisioning', 'running', 'stopping', 'deleting')
                -- Runtime/provider failures stay retryable. max_attempts caps retry telemetry while
                -- available_at remains the backoff boundary; it is not a terminal lifecycle state.
                OR (
                  w."status" = 'error'
                  AND w."last_error_code" = 'project_runtime_failed'
                )
                OR w."desired_generation" > w."applied_generation"
                -- Creator uploads wake an already-running warm workspace so the authoritative
                -- files/ projection can be swapped at the next quiescent boundary. A stopped
                -- Project remains storage-only until its next prompt activates the provider.
                OR (
                  w."status" <> 'stopped'
                  AND w."desired_file_revision" > w."applied_file_revision"
                )
                OR (w."idle_deadline_at" IS NOT NULL AND w."idle_deadline_at" <= clock_timestamp())
                OR EXISTS (
                  SELECT 1
                  FROM public."project_prompts" prompt
                  JOIN public."project_sessions" session
                    ON session."org_id" = prompt."org_id"
                   AND session."project_id" = prompt."project_id"
                   AND session."id" = prompt."session_id"
                   AND session."creator_id" = prompt."creator_id"
                  WHERE prompt."org_id" = w."org_id"
                    AND prompt."project_id" = w."project_id"
                    AND prompt."creator_id" = w."creator_id"
                    AND (
                      (prompt."status" = 'queued' AND prompt."available_at" <= clock_timestamp())
                      OR (
                        prompt."status" IN ('dispatching', 'running')
                        AND prompt."lease_expires_at" <= clock_timestamp()
                      )
                    )
                    AND (
                      w."last_error_code" IS DISTINCT FROM 'project_provider_unavailable'
                      OR (
                        -- A compatible prompt can repair a stale pre-exposure provider gate.
                        -- Warm runtimes still require the provider-change recycle fence because
                        -- their injected credential snapshot may differ from the current source.
                        w."environment_exposure_attempted_at" IS NULL
                        AND (
                          cardinality(session."model_credential_env_keys") = 0
                          OR EXISTS (
                            SELECT 1
                            FROM public."model_provider_connections" connection
                            WHERE connection."org_id" = w."org_id"
                              AND connection."provider" = session."model_provider"
                              AND connection."key_name" =
                                ANY(session."model_credential_env_keys")
                              AND (
                                (
                                  connection."scope" = 'personal'
                                  AND connection."user_id" = w."creator_id"
                                )
                                OR (
                                  connection."scope" = 'organization'
                                  AND NOT EXISTS (
                                    SELECT 1
                                    FROM public."model_provider_connections" personal
                                    WHERE personal."org_id" = w."org_id"
                                      AND personal."scope" = 'personal'
                                      AND personal."user_id" = w."creator_id"
                                      AND personal."provider" =
                                        session."model_provider"
                                  )
                                )
                              )
                          )
                        )
                      )
                    )
                )
                OR EXISTS (
                  SELECT 1 FROM public."project_sessions" session
                  WHERE session."org_id" = w."org_id"
                    AND session."project_id" = w."project_id"
                    AND (
                      session."status" = 'stopping'
                      OR session."stop_requested_at" IS NOT NULL
                    )
                  )
                )
              )
            )
          )
        )
    ORDER BY w."available_at", w."updated_at", w."project_id"
    FOR UPDATE OF w SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public."project_workspaces" w
    SET "lease_owner" = p_worker_id,
        "lease_expires_at" = clock_timestamp() + make_interval(secs => p_lease_seconds),
        "heartbeat_at" = clock_timestamp(),
        "lease_generation" = w."lease_generation" + 1,
        "attempt" = least(w."attempt" + 1, w."max_attempts"),
        "updated_at" = clock_timestamp()
    FROM candidates c
    WHERE w."org_id" = c."org_id" AND w."project_id" = c."project_id"
    RETURNING w.*
  )
  SELECT c."org_id", c."project_id", c."creator_id", c."status",
         c."sandbox_name", c."sandbox_id", c."sandbox_domain", c."checkpoint_id",
         c."checkpoint_generation",
         c."desired_generation", c."applied_generation",
         c."desired_file_revision", c."applied_file_revision",
         c."last_activity_at", c."idle_deadline_at", c."activation_revision",
         c."authority_revision",
         c."activation_admission_token", c."activation_admission_revision",
         c."activation_admission_authority_revision", c."activation_admitted_at",
         c."environment_exposure_attempted_at",
         c."recycle_requested_at", c."recycle_reason",
         c."skill_sync_error_at", c."skill_sync_error_code", c."skill_sync_error_message",
         c."lease_generation", p."delete_requested_at"
  FROM claimed c
  JOIN public."projects" p ON p."org_id" = c."org_id" AND p."id" = c."project_id";
  PERFORM set_config('app.project_worker', COALESCE(previous_worker_context, ''), true);
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION companion_claim_project_workspaces(text, integer, integer) FROM PUBLIC;
