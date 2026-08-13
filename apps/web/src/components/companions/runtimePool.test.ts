import type { Companion } from "@companion/contracts";
import { describe, expect, it } from "vitest";
import { applyCompanionRuntime, companionPoolKey } from "./runtimePool";

/**
 * Product promise (THE-330): the Box belongs to the workspace. Two Companions of a team workspace run
 * on one Box, so one wake answers for both and their chips are identical without a second wake. These
 * are pure projections of one runtime answer onto the loaded list, so they are tested as text.
 */
function companion(overrides: Partial<Companion> = {}): Companion {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Smoke 6",
    persona: null,
    owner_id: "user-1",
    access: "owner",
    runtime: {
      state: "not_created",
      daemon_state: "unknown",
      box_id: null,
      provider_ids: ["anthropic"],
      provider_credential_generation: null,
      disk_layout_version: 1,
      desktop_available: false,
      last_error: null,
      last_observed_at: null,
      last_started_at: null,
      last_stopped_at: null,
    },
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

const woke = (from: Companion): Companion => ({
  ...from,
  runtime: {
    ...from.runtime,
    state: "running",
    daemon_state: "running",
    box_id: "bx_23456789",
    desktop_available: true,
    disk_layout_version: 3,
  },
});

describe("companion runtime pool projection", () => {
  it("gives every Companion of a team workspace the Box a sibling woke", () => {
    const smokeSix = companion();
    const smokeFive = companion({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Smoke 5",
      owner_id: "user-2",
      access: "editor",
      runtime: { ...companion().runtime, provider_ids: ["openai"] },
    });

    const [, sibling] = applyCompanionRuntime([smokeSix, smokeFive], woke(smokeSix), "team");

    expect(sibling?.runtime.state).toBe("running");
    expect(sibling?.runtime.box_id).toBe("bx_23456789");
    expect(sibling?.runtime.desktop_available).toBe(true);
    expect(sibling?.runtime.disk_layout_version).toBe(3);
    // The Box is shared; the provider each Companion chose is not.
    expect(sibling?.runtime.provider_ids).toEqual(["openai"]);
  });

  it("keeps a personal workspace Box to its own owner", () => {
    const mine = companion();
    const theirs = companion({
      id: "22222222-2222-4222-8222-222222222222",
      owner_id: "user-2",
    });

    const [, other] = applyCompanionRuntime([mine, theirs], woke(mine), "personal");

    expect(companionPoolKey(mine, "personal")).not.toBe(companionPoolKey(theirs, "personal"));
    expect(other?.runtime.state).toBe("not_created");
    expect(other?.runtime.box_id).toBeNull();
  });

  it("withholds the Box from a Viewer who shares the woken machine", () => {
    const mine = companion();
    const watched = companion({
      id: "22222222-2222-4222-8222-222222222222",
      owner_id: "user-2",
      access: "viewer",
    });

    const [, viewer] = applyCompanionRuntime([mine, watched], woke(mine), "team");

    // A Viewer reads the shared state and nothing that could start or reach the Box.
    expect(viewer?.runtime.state).toBe("running");
    expect(viewer?.runtime.box_id).toBeNull();
    expect(viewer?.runtime.desktop_available).toBe(false);
  });

  it("never lets a Viewer's projection speak for the Box of a Companion they cannot run", () => {
    const watched = companion({ access: "viewer" });
    const mine = companion({
      id: "22222222-2222-4222-8222-222222222222",
      runtime: { ...woke(companion()).runtime },
    });

    const [, runner] = applyCompanionRuntime(
      [watched, mine],
      { ...watched, runtime: { ...watched.runtime, state: "running", daemon_state: "running" } },
      "team",
    );

    // The Viewer read carries no Box id, so applying it would have erased a Box the runner can reach.
    expect(runner?.runtime.box_id).toBe("bx_23456789");
    expect(runner?.runtime.desktop_available).toBe(true);
  });

  it("clears a shared failure once the pool leaves error", () => {
    const failed = companion({
      runtime: {
        ...companion().runtime,
        state: "error",
        last_error: "Pi daemon is not running after start",
      },
    });
    const sibling = companion({
      id: "22222222-2222-4222-8222-222222222222",
      runtime: {
        ...companion().runtime,
        state: "error",
        last_error: "Pi daemon is not running after start",
      },
    });

    const [, recovered] = applyCompanionRuntime([failed, sibling], woke(failed), "team");

    expect(recovered?.runtime.last_error).toBeNull();
  });
});
