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
  model_id: "model-1",
  selected_skill_ids: [],
  can_write_skills: false,
  selected_mcp_account_ids: [],
  owner_id: "owner-1",
  access: "owner",
  pinned: false,
  hidden: false,
  unread: false,
  last_message: null,
  runtime: {
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
    box_id: null,
    box_state: "absent",
    pi_state: "absent",
    pi_invocation_id: null,
    disk_layout_version: 0,
    desired_settings_revision: 1,
    applied_settings_revision: 0,
    applied_skills_revision: 0,
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
    });
  });

  it("projects a ready Box and idle Pi as online with its applied skill revision", () => {
    const projected = projectCompanionRuntimeV2(companion, runtime({
      box_id: "bx_23456789",
      box_state: "ready",
      pi_state: "idle",
      disk_layout_version: 14,
      applied_skills_revision: 3,
      last_observed_at: "2026-08-16T00:02:00+00:00",
    }));

    expect(projected.runtime).toMatchObject({
      state: "running",
      daemon_state: "running",
      box_id: "bx_23456789",
      disk_layout_version: 14,
      desktop_available: true,
      skills_applied_revision: 3,
      skills_applied_at: null,
    });
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
    });
  });
});
