/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- Existing API fixtures predate the incremental anti-slop gate. */

import { describe, expect, it } from "vitest";

import type { Companion } from "@companion/contracts";
import {
  projectCompanionRuntimeV2,
  type CompanionRuntimeApiProjection,
} from "../src/companionRuntimeApi";

const companion: Companion = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Research",
  persona: null,
  icon: { shape: 1, mouth: 1, accessory: 1, color: 2 },
  model_id: "model-1",
  selected_skill_ids: [],
  can_write_skills: true,
  selected_mcp_account_ids: [],
  owner_id: "owner-1",
  access: "owner",
  pinned: false,
  hidden: false,
  unread: false,
  last_message: null,
  runtime: {
    generation: 1,
    state: "not_created",
    daemon_state: "unknown",
    box_id: null,
    provider_ids: ["anthropic"],
    provider_credential_generation: null,
    disk_layout_version: 0,
    desktop_available: false,
    last_error: null,
    skills_revision: 3,
    skills_applied_revision: 0,
    skills_applied_at: null,
    skills_last_error: null,
    last_observed_at: null,
    last_started_at: null,
    last_stopped_at: null,
    latest_operation: null,
  },
  created_at: "2026-08-16T00:00:00.000Z",
  updated_at: "2026-08-16T00:00:00.000Z",
};

function runtime(
  patch: Partial<CompanionRuntimeApiProjection> = {},
): CompanionRuntimeApiProjection {
  return {
    access_role: "owner",
    generation: 1,
    selected_skill_ids: [],
    selected_mcp_account_ids: [],
    box_id: null,
    box_state: "absent",
    pi_state: "absent",
    pi_invocation_id: null,
    disk_layout_version: 0,
    desired_settings_revision: 1,
    applied_settings_revision: 0,
    applied_skills_revision: 0,
    skills_available_revision: 3,
    skills_update_error_message: null,
    retirement_state: "active",
    last_error_code: null,
    last_error_message: null,
    last_error_action: null,
    active_turn: null,
    queued_count: 0,
    interrupted_turn: null,
    latest_operation: null,
    is_replying: false,
    last_observed_at: null,
    ...patch,
  };
}

function operation(
  patch: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    companion_id: companion.id,
    request_id: "33333333-3333-4333-8333-333333333333",
    source_turn_id: null,
    kind: "start",
    trigger: "user",
    status: "pending",
    queue_sequence: 1,
    checkpoint: "pending",
    attempt_count: 0,
    error: null,
    created_at: "2026-08-16T00:01:00+00:00",
    started_at: null,
    settled_at: null,
    ...patch,
  };
}

describe("Runtime v2 Companion projection", () => {
  it("shows accepted lifecycle work as Starting without consulting Box", () => {
    const projected = projectCompanionRuntimeV2(companion, runtime({
      latest_operation: operation(),
    }));

    expect(projected.runtime).toMatchObject({
      state: "provisioning",
      daemon_state: "stopped",
      box_id: null,
      desktop_available: false,
      latest_operation: {
        id: "22222222-2222-4222-8222-222222222222",
        source_turn_id: null,
        kind: "start",
        status: "pending",
        error: null,
      },
    });
  });

  it("projects a ready Box and idle Pi as online with its applied skill revision", () => {
    const projected = projectCompanionRuntimeV2(companion, runtime({
      generation: "9",
      selected_skill_ids: ["44444444-4444-4444-8444-444444444444"],
      selected_mcp_account_ids: ["55555555-5555-4555-8555-555555555555"],
      box_id: "bx_23456789",
      box_state: "ready",
      pi_state: "idle",
      disk_layout_version: 14,
      applied_skills_revision: 3,
      last_observed_at: "2026-08-16T00:02:00+00:00",
    }));

    expect(projected.runtime).toMatchObject({
      generation: 9,
      state: "running",
      daemon_state: "running",
      box_id: "bx_23456789",
      disk_layout_version: 14,
      desktop_available: true,
      skills_applied_revision: 3,
      skills_applied_at: null,
    });
    expect(projected.selected_skill_ids).toEqual([
      "44444444-4444-4444-8444-444444444444",
    ]);
    expect(projected.selected_mcp_account_ids).toEqual([
      "55555555-5555-4555-8555-555555555555",
    ]);
  });

  it("preserves the deployable-stage Skill sync error and its Viewer redaction", () => {
    const owner = projectCompanionRuntimeV2({
      ...companion,
      runtime: { ...companion.runtime, skills_last_error: "Box exec timed out" },
    }, runtime());
    const viewer = projectCompanionRuntimeV2({
      ...companion,
      access: "viewer",
      // The second PostgreSQL read may observe an Editor -> Viewer downgrade after the legacy
      // projection already returned operator detail, so the Runtime v2 overlay must redact again.
      runtime: { ...companion.runtime, skills_last_error: "Box exec timed out" },
    }, runtime({ access_role: "viewer" }));

    expect(owner.runtime.skills_last_error).toBe("Box exec timed out");
    expect(viewer.runtime.skills_last_error).toBe("Skill sync failed.");
  });

  it("rejects a non-positive runtime generation at the projection boundary", () => {
    expect(() => projectCompanionRuntimeV2(companion, runtime({ generation: 0 })))
      .toThrow("Companion runtime generation is invalid");
  });

  it("never exposes Box identity or operator error detail to a Viewer", () => {
    const projected = projectCompanionRuntimeV2(
      { ...companion, access: "viewer" },
      runtime({
        access_role: "viewer",
        box_id: "bx_23456789",
        box_state: "error",
        pi_state: "error",
        last_error_code: "provider_unavailable",
        last_error_message: "private operator detail",
        last_error_action: "retry",
      }),
    );

    expect(projected.runtime.box_id).toBeNull();
    expect(projected.runtime.desktop_available).toBe(false);
    expect(projected.runtime.last_error).toBe("Companion runtime needs attention.");
  });

  it("distinguishes an explicitly stopped Box from one never created", () => {
    const projected = projectCompanionRuntimeV2(companion, runtime({
      latest_operation: operation({
        kind: "stop",
        status: "succeeded",
        settled_at: "2026-08-16T00:03:00+00:00",
      }),
    }));

    expect(projected.runtime.state).toBe("stopped");
  });

  it("projects the latest lifecycle failure without exposing its detail to Viewers", () => {
    const failed = operation({
      kind: "restart_pi",
      status: "failed",
      error: {
        code: "pi_crash_loop",
        message: "Pi could not stay running.",
        action: "retry",
      },
      settled_at: "2026-08-16T00:03:00+00:00",
    });

    const owner = projectCompanionRuntimeV2(companion, runtime({ latest_operation: failed }));
    const viewer = projectCompanionRuntimeV2(
      { ...companion, access: "viewer" },
      runtime({ access_role: "viewer", latest_operation: failed }),
    );

    expect(owner.runtime).toMatchObject({ state: "error", last_error: "Pi could not stay running." });
    expect(viewer.runtime).toMatchObject({
      state: "error",
      last_error: "Companion runtime needs attention.",
      latest_operation: {
        kind: "restart_pi",
        status: "failed",
        error: {
          code: "runtime_unavailable",
          message: "Companion runtime needs attention.",
          action: "none",
        },
      },
    });
  });
});
