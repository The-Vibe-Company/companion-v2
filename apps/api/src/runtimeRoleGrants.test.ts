import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveRuntimeRoleGrantsFile } from "./migrate";

describe("Skills Hub runtime-role grants", () => {
  it("grants skill maintenance capabilities without removed execution capabilities", async () => {
    const sql = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    expect(sql).toContain("companion_claim_skill_database_object_deletions");
    expect(sql).toContain("companion_claim_github_sync_destinations");
    expect(sql).toContain("companion_secret_usage_count");
    expect(sql).not.toMatch(/skill_run|project_workspace|project_worker|sandbox_usage|model_provider/i);
  });

  it("keeps Runtime v2 state private and grants only its fenced executor functions", async () => {
    const sql = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    for (const table of [
      "companion_runtime_control",
      "companion_runtime_instances",
      "companion_turns",
      "companion_turn_attempts",
      "companion_operations",
      "companion_decision_deliveries",
      "companion_runtime_leases",
    ]) {
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain("NOT (table_class.relname::text = ANY(private_runtime_table_names))");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON TABLE %s FROM %I");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM %I");

    expect(sql).toContain("companion_runtime_functions regprocedure[] := ARRAY[]::regprocedure[]");
    expect(sql).toContain(
      "IF pg_catalog.to_regprocedure('public.companion_runtime_gate_status()') IS NOT NULL THEN",
    );
    const runtimeFunctions = sql.slice(
      sql.indexOf("companion_runtime_functions := ARRAY["),
      sql.indexOf("owner_only_runtime_functions := ARRAY["),
    );
    for (const signature of [
      "companion_runtime_gate_status()",
      "companion_runtime_disable(bigint,text)",
      "companion_runtime_claim_work(text,integer,integer,bigint)",
      "companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)",
      "companion_runtime_checkpoint(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,text,uuid,text,bigint,timestamp with time zone,integer,integer,integer)",
      "companion_runtime_observe_instance(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,bigint,text,public.companion_box_observed_state,public.companion_pi_observed_state,text,integer,bigint,integer,timestamp with time zone)",
      "companion_runtime_settle(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,text,text,public.companion_runtime_error_action)",
      "companion_runtime_release_lease(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)",
    ]) {
      expect(runtimeFunctions).toContain(signature);
    }
    expect(runtimeFunctions).not.toContain("companion_runtime_enable");
    expect(sql).toContain("'public.companion_runtime_enable(bigint,text)'::regprocedure");
    for (const helper of [
      "companion_runtime_create_lease_row()",
      "companion_runtime_assert_v2_mutation()",
      "companion_runtime_require_v2_mutation()",
      "companion_runtime_fence_legacy_token()",
      "companion_runtime_require_instance_at_commit()",
      "companion_runtime_assign_turn_sequence()",
      "companion_runtime_assign_operation_intent()",
      "companion_runtime_assign_attempt_snapshot()",
      "companion_runtime_reject_actor_change()",
      "companion_runtime_reject_turn_surface_change()",
      "companion_runtime_reject_attempt_snapshot_change()",
      "companion_runtime_reject_operation_snapshot_change()",
      "companion_runtime_reject_responder_change()",
      "companion_runtime_close_attempt_decisions(uuid,uuid,uuid,text,text,public.companion_runtime_error_action,uuid)",
    ]) {
      expect(sql).toContain(`'public.${helper}'::regprocedure`);
    }
    expect(sql).toContain("owner_only_runtime_functions || internal_runtime_functions");
    expect(sql).toContain("pg_catalog.aclexplode(");
    expect(sql).toContain("acl.grantee <> protected_proc.proowner");
    expect(sql).toContain("defaults.defaclobjtype = 'f'");
    expect(sql).toContain("defaults.defaclnamespace IN (0, 'public'::regnamespace)");
    expect(sql).toContain("ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
    expect(sql).toContain("ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM %I");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTIONS FROM %I");
    expect(sql).toContain("FROM pg_catalog.pg_auth_members membership");
    expect(sql).toContain("companion runtime executor role must have no role memberships");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION %s TO %I");
  });

  it("makes the Runtime v2 cutover a one-way downgrade for legacy executors", async () => {
    const sql = await readFile(await resolveRuntimeRoleGrantsFile(), "utf8");
    const sentinel =
      "IF pg_catalog.to_regprocedure('public.companion_runtime_gate_status()') IS NOT NULL THEN";
    expect(sql).toContain(sentinel);

    for (const table of [
      "public.companions",
      "public.companion_runtime_pools",
      "public.companion_workspace_access",
      "public.companion_member_state",
      "public.companion_threads",
      "public.companion_transcript_entries",
      "public.companion_reconcile_leases",
    ]) {
      expect(sql).toContain(`'${table}'::regclass`);
    }
    expect(sql).toContain("REVOKE INSERT, UPDATE, DELETE ON TABLE %s FROM PUBLIC");
    expect(sql).toContain("REVOKE INSERT, UPDATE, DELETE ON TABLE %s FROM %I");

    for (const signature of [
      "companion_claim_delivery_lease(uuid,uuid,uuid,integer)",
      "companion_release_delivery_lease(uuid,uuid,uuid)",
      "companion_renew_delivery_lease(uuid,uuid,uuid,integer)",
      "companion_accept_delivery_lease(uuid,uuid,uuid,integer,integer)",
      "companion_expire_tool_runs(uuid,uuid,timestamp with time zone,integer,integer)",
      "companion_claim_reconcile_candidates(text,integer,integer,integer,integer)",
      "companion_settle_reconcile_lease(uuid,uuid,text,text,integer)",
    ]) {
      expect(sql).toContain(`'public.${signature}'::regprocedure`);
    }

    const retiredFunctions = sql.slice(
      sql.indexOf("retired_companion_functions := ARRAY["),
      sql.indexOf("-- A migration owner can carry arbitrary"),
    );
    expect(retiredFunctions).not.toContain("companion_delivery_read_fence");
    expect(sql).toContain("public.companion_delivery_read_fence(uuid, uuid, text)");

    const finalDowngrade = sql.lastIndexOf("FOREACH protected_function IN ARRAY retired_companion_functions");
    const finalLegacyApiGrant = sql.lastIndexOf("public.companion_accept_delivery_lease");
    const finalLegacyWorkerGrant = sql.lastIndexOf("public.companion_settle_reconcile_lease");
    expect(finalDowngrade).toBeGreaterThan(finalLegacyApiGrant);
    expect(finalDowngrade).toBeGreaterThan(finalLegacyWorkerGrant);
    const cutoverBlock = sql.slice(
      sql.lastIndexOf("Runtime v2 is a one-way cutover"),
      sql.indexOf("END\n$companion_runtime_grants$"),
    );
    expect(cutoverBlock).toContain(
      "REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM %I",
    );
    expect(cutoverBlock).toContain("REVOKE USAGE, SELECT ON SEQUENCES FROM %I");
  });
});
