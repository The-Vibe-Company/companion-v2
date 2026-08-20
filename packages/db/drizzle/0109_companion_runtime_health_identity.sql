-- Health may persist a proven Pi identity. A warm-layout refresh recycles Pi, and a crashed start
-- can leave the durable pi_invocation_id NULL while a live daemon runs; forbidding health from
-- recording that identity trapped health work in a contract-error loop. CREATE OR REPLACE keeps the
-- 0090 signature, owner, and grants byte-identical; the only behavioral change is the health guard
-- below: a Pi invocation id may be attached or replaced from health only with idle proof, mirroring
-- the restart operation rule. Box attach, disk layout, and applied revisions stay forbidden.

CREATE OR REPLACE FUNCTION public.companion_runtime_observe_instance(
  p_org_id uuid,
  p_companion_id uuid,
  p_claim_token uuid,
  p_claim_epoch bigint,
  p_gate_epoch bigint,
  p_executor_id text,
  p_work_kind public.companion_runtime_work_kind,
  p_work_id uuid,
  p_runtime_generation bigint,
  p_expected_checkpoint_sequence bigint,
  p_box_id text,
  p_box_state public.companion_box_observed_state,
  p_pi_state public.companion_pi_observed_state,
  p_pi_invocation_id text,
  p_disk_layout_version integer,
  p_applied_settings_revision bigint,
  p_applied_skills_revision integer,
  p_observed_at timestamp with time zone
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_lease_expires_at timestamp with time zone;
  v_generation bigint;
  v_box_id text;
  v_pi_invocation_id text;
  v_disk_layout_version integer;
  v_desired_settings_revision bigint;
  v_applied_settings_revision bigint;
  v_applied_skills_revision integer;
  v_skills_revision integer;
  v_last_observed_at timestamp with time zone;
  v_checkpoint text;
  v_checkpoint_sequence bigint;
  v_operation_kind public.companion_operation_kind;
  v_client_surface public.companion_client_surface := 'web';
  v_target_settings_revision bigint;
  v_target_skills_revision integer;
  v_observation_checkpoint text;
  v_checkpoint_updated_at timestamp with time zone;
  v_ambiguous_create_interrupted_at timestamp with time zone;
  v_delete_create_ambiguous boolean := false;
  v_settings_claim_revision bigint;
  v_settings_claim_skills_revision integer;
  v_cold_start_deadline timestamp with time zone;
  v_next_sequence bigint;
BEGIN
  IF p_runtime_generation < 1
     OR p_expected_checkpoint_sequence < 0
     OR p_observed_at IS NULL
     OR p_observed_at > v_now + interval '5 minutes'
     OR (p_box_id IS NOT NULL AND p_box_id !~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$')
     OR (p_pi_invocation_id IS NOT NULL AND (
       char_length(p_pi_invocation_id) NOT BETWEEN 1 AND 200
       OR p_pi_invocation_id ~ E'[\n\r]'
     ))
     OR (p_disk_layout_version IS NOT NULL
       AND p_disk_layout_version NOT BETWEEN 0 AND 1000000)
     OR (p_applied_settings_revision IS NOT NULL AND p_applied_settings_revision < 0)
     OR (p_applied_skills_revision IS NOT NULL AND p_applied_skills_revision < 0)
     OR (p_box_id IS NULL AND p_box_state IS NULL AND p_pi_state IS NULL
       AND p_pi_invocation_id IS NULL AND p_disk_layout_version IS NULL
       AND p_applied_settings_revision IS NULL AND p_applied_skills_revision IS NULL)
     OR p_work_kind NOT IN ('operation', 'settings', 'health') THEN
    RAISE EXCEPTION 'invalid Runtime v2 instance observation' USING ERRCODE = '22023';
  END IF;

  SELECT l.expires_at INTO v_lease_expires_at
  FROM public.companion_runtime_leases l
  JOIN public.companion_runtime_control c ON c.id = 'runtime-v2'
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp()
    AND c.enabled
    AND c.gate_epoch = p_gate_epoch
  FOR UPDATE OF l;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT i.generation, i.box_id, i.pi_invocation_id, i.disk_layout_version,
         i.desired_settings_revision, i.applied_settings_revision,
         i.applied_skills_revision, c.skills_revision, i.last_observed_at
  INTO v_generation, v_box_id, v_pi_invocation_id, v_disk_layout_version,
       v_desired_settings_revision, v_applied_settings_revision,
       v_applied_skills_revision, v_skills_revision, v_last_observed_at
  FROM public.companion_runtime_instances i
  JOIN public.companions c
    ON c.org_id = i.org_id AND c.id = i.companion_id
  WHERE i.org_id = p_org_id
    AND i.companion_id = p_companion_id
    AND i.generation = p_runtime_generation
  FOR UPDATE OF i;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_now := clock_timestamp();
  IF v_lease_expires_at <= v_now THEN RETURN NULL; END IF;

  IF (v_last_observed_at IS NOT NULL AND p_observed_at < v_last_observed_at)
     OR (p_disk_layout_version IS NOT NULL AND p_disk_layout_version < v_disk_layout_version)
     OR (p_applied_settings_revision IS NOT NULL AND (
       p_applied_settings_revision < v_applied_settings_revision
       OR p_applied_settings_revision > v_desired_settings_revision
     ))
     OR (p_applied_skills_revision IS NOT NULL AND (
       p_applied_skills_revision < v_applied_skills_revision
       OR p_applied_skills_revision > v_skills_revision
     )) THEN
    RETURN NULL;
  END IF;

  -- A Box id is immutable within one runtime generation. Delete settlement, not an observation,
  -- is the only path that clears it after terminal provider evidence.
  IF p_box_id IS NOT NULL AND v_box_id IS NOT NULL AND p_box_id <> v_box_id THEN
    RAISE EXCEPTION 'Box id is immutable within a runtime generation' USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation' THEN
    SELECT o.kind, o.client_surface,
           o.checkpoint, o.checkpoint_sequence,
           o.target_settings_revision, o.target_skills_revision,
           t.cold_start_deadline_at, o.updated_at
    INTO v_operation_kind, v_client_surface, v_checkpoint, v_checkpoint_sequence,
         v_target_settings_revision, v_target_skills_revision,
         v_cold_start_deadline, v_checkpoint_updated_at
    FROM public.companion_operations o
    LEFT JOIN public.companion_turns t
      ON t.org_id = o.org_id AND t.companion_id = o.companion_id AND t.id = o.source_turn_id
    WHERE o.org_id = p_org_id
      AND o.companion_id = p_companion_id
      AND o.id = p_work_id
      AND o.runtime_generation = p_runtime_generation
      AND o.status = 'running'
      AND o.claim_epoch = p_claim_epoch
      AND o.checkpoint_sequence = p_expected_checkpoint_sequence
    FOR UPDATE OF o;
    IF NOT FOUND THEN RETURN NULL; END IF;

    IF v_operation_kind = 'delete' THEN
      SELECT MAX(ambiguous_start.updated_at)
      INTO v_ambiguous_create_interrupted_at
      FROM public.companion_operations ambiguous_start
      WHERE ambiguous_start.org_id = p_org_id
        AND ambiguous_start.companion_id = p_companion_id
        AND ambiguous_start.runtime_generation = p_runtime_generation
        AND ambiguous_start.kind = 'start'
        AND ambiguous_start.status = 'interrupted'
        AND ambiguous_start.checkpoint = 'creating_box';
      v_delete_create_ambiguous := v_ambiguous_create_interrupted_at IS NOT NULL;
    END IF;
  ELSIF p_work_kind = 'settings' THEN
    SELECT i.settings_checkpoint, i.settings_checkpoint_sequence,
           i.settings_claim_revision, i.settings_claim_skills_revision,
           i.settings_claim_client_surface, i.settings_claim_cold_start_deadline_at
    INTO v_checkpoint, v_checkpoint_sequence,
         v_settings_claim_revision, v_settings_claim_skills_revision, v_client_surface,
         v_cold_start_deadline
    FROM public.companion_runtime_instances i
    WHERE i.org_id = p_org_id
      AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id
      AND i.generation = p_runtime_generation
      AND i.settings_claim_epoch = p_claim_epoch
      AND i.settings_checkpoint = 'applying'
      AND i.settings_checkpoint_sequence = p_expected_checkpoint_sequence;
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSE
    SELECT i.health_checkpoint, i.health_checkpoint_sequence
    INTO v_checkpoint, v_checkpoint_sequence
    FROM public.companion_runtime_instances i
    WHERE i.org_id = p_org_id
      AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id
      AND i.generation = p_runtime_generation
      AND i.health_claim_epoch = p_claim_epoch
      AND i.health_checkpoint = 'observing'
      AND i.health_checkpoint_sequence = p_expected_checkpoint_sequence;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;

  -- A cold Send's budget also fences the last configuration observation before dispatch. The
  -- runtime may still settle the work as interrupted, but it cannot publish an applied revision
  -- after the source turn's three-minute deadline.
  v_now := clock_timestamp();
  IF v_lease_expires_at <= v_now
     OR (
       v_cold_start_deadline IS NOT NULL
       AND v_now >= v_cold_start_deadline
       AND (
         (
           p_work_kind = 'operation'
           AND v_operation_kind = 'start'
           -- Never discard causal identity evidence for a Box lookup/create already performed
           -- under a valid renewal. Recording the canonical id prevents an orphan; checkpoint and
           -- settlement still prohibit any subsequent effect or successful cold turn.
           AND NOT (
             v_checkpoint IN ('resolving_box', 'creating_box')
             AND p_box_id IS NOT NULL
           )
         )
         OR (p_work_kind = 'operation' AND v_operation_kind = 'apply_settings')
         OR p_work_kind = 'settings'
       )
     ) THEN
    RETURN NULL;
  END IF;

  -- A create POST cannot be cancelled after its write intent. When Delete preempts that exact
  -- generation, absence is not proof until the full cold-create outcome horizon has elapsed. A
  -- later second observation is still required below, so a delayed named Box is attached and
  -- permanently deleted instead of appearing after retirement.
  IF p_work_kind = 'operation'
     AND v_operation_kind = 'delete'
     AND v_checkpoint = 'pending'
     AND p_box_id IS NULL
     AND p_box_state = 'absent'
     AND v_delete_create_ambiguous
     AND v_now < v_ambiguous_create_interrupted_at + interval '3 minutes' THEN
    RETURN NULL;
  END IF;

  -- Health is observation-only: it may refresh typed states/timestamps, but it cannot discover a
  -- new Box identity or claim that layout/settings/skills were applied. The single exception is
  -- the Pi invocation id: a recycled daemon or a start that crashed after Pi started leaves a
  -- live idle invocation the durable projection does not know, so health may attach or replace
  -- that identity only with idle proof, mirroring the restart operation rule. Lifecycle work may
  -- attach a new Box only while a start is resolving it or immediately after the create write
  -- intent.
  IF p_work_kind = 'health' AND (
       (p_box_id IS NOT NULL AND (v_box_id IS NULL OR p_box_id <> v_box_id))
       OR (p_pi_invocation_id IS NOT NULL
         AND p_pi_invocation_id IS DISTINCT FROM v_pi_invocation_id
         AND p_pi_state IS DISTINCT FROM 'idle'::public.companion_pi_observed_state)
       OR p_disk_layout_version IS NOT NULL
       OR p_applied_settings_revision IS NOT NULL
       OR p_applied_skills_revision IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'health observation cannot mutate runtime identity or applied revisions'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'settings' AND (
       p_box_id IS NOT NULL
       OR p_box_state IS NOT NULL
       OR p_disk_layout_version IS NOT NULL
       OR p_pi_state IS DISTINCT FROM 'idle'::public.companion_pi_observed_state
       OR p_pi_invocation_id IS NULL
       OR p_pi_invocation_id IS NOT DISTINCT FROM v_pi_invocation_id
       OR p_applied_settings_revision IS DISTINCT FROM v_settings_claim_revision
       OR CASE WHEN v_client_surface = 'native_mobile'
            THEN p_applied_skills_revision IS NOT NULL
            ELSE p_applied_skills_revision IS DISTINCT FROM v_settings_claim_skills_revision
          END
     ) THEN
    RAISE EXCEPTION 'settings activation requires exact revisions and a new idle Pi invocation'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND p_box_id IS NOT NULL
     AND v_box_id IS NULL
     AND NOT (
       (v_operation_kind = 'start' AND v_checkpoint IN ('resolving_box', 'creating_box'))
       -- A Delete that preempted an ambiguous create must resolve the deterministic generation
       -- name before it may prove absence. If the provider list finds that Box, attach its id so
       -- the normal permanent-delete path is mandatory instead of orphaning the resource.
       OR (v_operation_kind = 'delete'
           AND v_checkpoint IN ('pending', 'box_absence_observed'))
     ) THEN
    RAISE EXCEPTION 'operation cannot attach a Box id at this checkpoint' USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND p_pi_invocation_id IS DISTINCT FROM v_pi_invocation_id
     AND p_pi_invocation_id IS NOT NULL
     AND NOT (
       (v_operation_kind IN ('start', 'restart_pi', 'restart_box')
        AND v_checkpoint = 'starting_pi')
       OR (v_operation_kind = 'apply_settings'
           AND v_checkpoint = 'applying_settings')
     ) THEN
    RAISE EXCEPTION 'operation cannot replace the Pi invocation at this checkpoint'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND v_operation_kind IN ('restart_pi', 'restart_box', 'apply_settings')
     AND p_pi_invocation_id IS DISTINCT FROM v_pi_invocation_id
     AND p_pi_invocation_id IS NOT NULL
     AND p_pi_state IS DISTINCT FROM 'idle'::public.companion_pi_observed_state THEN
    RAISE EXCEPTION 'a restarted Pi invocation may be attached only with idle proof'
      USING ERRCODE = '22023';
  END IF;

  -- Applying settings is one activation proof: staged revisions become durable only when the same
  -- observation replaces the old daemon identity with a new idle Pi invocation.
  IF p_work_kind = 'operation'
     AND v_operation_kind = 'apply_settings'
     AND v_checkpoint = 'applying_settings'
     AND (
       p_pi_state IS DISTINCT FROM 'idle'::public.companion_pi_observed_state
       OR p_pi_invocation_id IS NULL
       OR p_pi_invocation_id IS NOT DISTINCT FROM v_pi_invocation_id
       OR p_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
       OR CASE WHEN v_client_surface = 'native_mobile'
            THEN p_applied_skills_revision IS NOT NULL
            ELSE p_applied_skills_revision IS DISTINCT FROM v_target_skills_revision
          END
     ) THEN
    RAISE EXCEPTION 'settings activation requires exact revisions and a new idle Pi invocation'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND p_disk_layout_version IS NOT NULL
     AND NOT (
       v_operation_kind IN ('start', 'restart_box')
       AND v_checkpoint IN ('installing_layout', 'starting_pi', 'pi_ready')
     ) THEN
    RAISE EXCEPTION 'operation cannot apply a disk layout at this checkpoint'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND (p_applied_settings_revision IS NOT NULL OR p_applied_skills_revision IS NOT NULL)
     AND NOT (
       (v_operation_kind IN ('start', 'restart_box')
         AND v_checkpoint IN ('installing_layout', 'starting_pi', 'pi_ready'))
       OR (v_operation_kind = 'apply_settings' AND v_checkpoint = 'applying_settings')
     ) THEN
    RAISE EXCEPTION 'operation cannot apply revisions at this checkpoint' USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND v_operation_kind IN ('start', 'restart_box', 'apply_settings')
     AND (p_applied_settings_revision IS NOT NULL OR p_applied_skills_revision IS NOT NULL)
     AND (CASE
       WHEN v_operation_kind IN ('start', 'restart_box', 'apply_settings')
            AND v_client_surface = 'native_mobile' THEN
         v_target_settings_revision IS NULL
         OR p_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
         OR p_applied_skills_revision IS NOT NULL
       ELSE
         v_target_settings_revision IS NULL
         OR v_target_skills_revision IS NULL
         OR p_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
         OR p_applied_skills_revision IS DISTINCT FROM v_target_skills_revision
     END) THEN
    RAISE EXCEPTION 'operation observation must prove its exact captured revisions'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.companion_runtime_instances i
  SET box_id = COALESCE(i.box_id, p_box_id),
      box_state = COALESCE(p_box_state, i.box_state),
      pi_state = COALESCE(p_pi_state, i.pi_state),
      pi_invocation_id = CASE
        -- Absence is positive proof that no invocation remains. Retaining the previous id would
        -- pair an absent daemon state with stale identity and mislead the next health claimant.
        WHEN p_pi_state = 'absent'::public.companion_pi_observed_state THEN NULL
        ELSE COALESCE(p_pi_invocation_id, i.pi_invocation_id)
      END,
      disk_layout_version = COALESCE(p_disk_layout_version, i.disk_layout_version),
      applied_settings_revision = CASE
        WHEN p_work_kind = 'settings' THEN i.applied_settings_revision
        ELSE COALESCE(p_applied_settings_revision, i.applied_settings_revision)
      END,
      applied_skills_revision = CASE
        WHEN p_work_kind = 'settings' THEN i.applied_skills_revision
        ELSE COALESCE(p_applied_skills_revision, i.applied_skills_revision)
      END,
      applied_client_surface = CASE
        WHEN p_work_kind = 'operation' AND p_applied_settings_revision IS NOT NULL
          THEN v_client_surface
        ELSE i.applied_client_surface
      END,
      settings_checkpoint = CASE
        WHEN p_work_kind = 'settings' THEN 'applied'
        ELSE i.settings_checkpoint
      END,
      settings_checkpoint_sequence = i.settings_checkpoint_sequence
        + CASE WHEN p_work_kind = 'settings' THEN 1 ELSE 0 END,
      health_checkpoint = CASE
        WHEN p_work_kind = 'health' THEN 'observed'
        ELSE i.health_checkpoint
      END,
      health_checkpoint_sequence = i.health_checkpoint_sequence
        + CASE WHEN p_work_kind = 'health' THEN 1 ELSE 0 END,
      last_heartbeat_at = CASE
        WHEN p_work_kind = 'health' THEN GREATEST(COALESCE(i.last_heartbeat_at, p_observed_at), p_observed_at)
        ELSE i.last_heartbeat_at
      END,
      box_observed_at = CASE
        WHEN p_box_id IS NOT NULL OR p_box_state IS NOT NULL
          THEN GREATEST(COALESCE(i.box_observed_at, p_observed_at), p_observed_at)
        ELSE i.box_observed_at
      END,
      pi_observed_at = CASE
        WHEN p_pi_state IS NOT NULL OR p_pi_invocation_id IS NOT NULL
          THEN GREATEST(COALESCE(i.pi_observed_at, p_observed_at), p_observed_at)
        ELSE i.pi_observed_at
      END,
      last_observed_at = GREATEST(COALESCE(i.last_observed_at, p_observed_at), p_observed_at),
      last_write_epoch = GREATEST(i.last_write_epoch, p_claim_epoch),
      updated_at = v_now
  WHERE i.org_id = p_org_id
    AND i.companion_id = p_companion_id
    AND i.generation = p_runtime_generation
    AND (p_box_id IS NULL OR i.box_id IS NULL OR i.box_id = p_box_id)
    AND (
      p_work_kind <> 'health'
      OR (
        i.health_claim_epoch = p_claim_epoch
        AND i.health_checkpoint = 'observing'
        AND i.health_checkpoint_sequence = p_expected_checkpoint_sequence
      )
    )
    AND (
      p_work_kind <> 'settings'
      OR (
        i.settings_claim_epoch = p_claim_epoch
        AND i.settings_checkpoint = 'applying'
        AND i.settings_checkpoint_sequence = p_expected_checkpoint_sequence
      )
    );
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_next_sequence := v_checkpoint_sequence
    + CASE WHEN p_work_kind IN ('settings', 'health') THEN 1 ELSE 0 END;
  IF p_work_kind = 'operation' THEN
    v_observation_checkpoint := CASE
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'resolving_box'
        AND p_box_id IS NULL
        AND p_box_state = 'absent' THEN 'box_absence_observed'
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'resolving_box'
        AND p_box_id IS NOT NULL
        AND p_box_state IN ('ready', 'idle', 'running') THEN 'box_ready_observed'
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'resolving_box'
        AND p_box_id IS NOT NULL THEN 'box_resolved'
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'creating_box'
        AND p_box_id IS NOT NULL
        AND p_box_state IN ('ready', 'idle', 'running') THEN 'box_ready_observed'
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'creating_box'
        AND p_box_id IS NOT NULL THEN 'box_created'
      WHEN v_operation_kind IN ('start', 'restart_box')
        AND v_checkpoint = 'waiting_ready'
        AND p_box_state IN ('ready', 'idle', 'running') THEN 'box_ready_observed'
      WHEN v_operation_kind = 'stop'
        AND v_checkpoint = 'waiting_archived'
        AND p_box_state = 'archived' THEN 'box_archived'
      WHEN v_operation_kind = 'delete'
        AND v_checkpoint = 'pending'
        AND p_box_id IS NULL
        AND p_box_state = 'absent'
        AND v_delete_create_ambiguous THEN 'box_absence_observed'
      WHEN v_operation_kind = 'delete'
        AND v_checkpoint = 'pending'
        AND p_box_id IS NULL
        AND p_box_state = 'absent'
        AND NOT v_delete_create_ambiguous THEN 'box_absent'
      WHEN v_operation_kind = 'delete'
        AND v_checkpoint = 'box_absence_observed'
        AND p_box_id IS NULL
        AND p_box_state = 'absent'
        AND v_now >= v_checkpoint_updated_at + interval '30 seconds' THEN 'box_absent'
      WHEN v_operation_kind = 'delete'
        AND v_checkpoint = 'waiting_deleted'
        AND p_box_state = 'absent' THEN 'provider_deleted'
      WHEN v_operation_kind = 'apply_settings'
        AND v_checkpoint = 'applying_settings'
        AND p_pi_state = 'idle'
        AND p_pi_invocation_id IS NOT NULL
        AND (v_pi_invocation_id IS NULL OR p_pi_invocation_id <> v_pi_invocation_id)
        AND p_applied_settings_revision = v_target_settings_revision
        AND CASE WHEN v_client_surface = 'native_mobile'
          THEN p_applied_skills_revision IS NULL
          ELSE p_applied_skills_revision = v_target_skills_revision
        END THEN 'settings_applied'
      WHEN v_operation_kind IN ('start', 'restart_pi', 'restart_box')
        AND v_checkpoint = 'starting_pi'
        AND p_pi_state = 'idle'
        AND p_pi_invocation_id IS NOT NULL
        AND (v_pi_invocation_id IS NULL OR p_pi_invocation_id <> v_pi_invocation_id)
        THEN 'pi_observed'
      ELSE NULL
    END;
  END IF;

  IF v_observation_checkpoint IS NOT NULL THEN
    UPDATE public.companion_operations o
    SET checkpoint = v_observation_checkpoint,
        checkpoint_sequence = o.checkpoint_sequence + 1,
        updated_at = v_now
    WHERE o.org_id = p_org_id
      AND o.companion_id = p_companion_id
      AND o.id = p_work_id
      AND o.runtime_generation = p_runtime_generation
      AND o.status = 'running'
      AND o.claim_epoch = p_claim_epoch
      AND o.checkpoint = v_checkpoint
      AND o.checkpoint_sequence = p_expected_checkpoint_sequence
    RETURNING o.checkpoint_sequence INTO v_next_sequence;
    IF v_next_sequence IS NULL THEN
      RAISE EXCEPTION 'failed to persist operation observation evidence' USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN v_next_sequence;
END
$$;
