/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Existing simulator HTTP fixtures predate the incremental anti-slop gate. */

import { afterEach, describe, expect, it } from "vitest";
import { AsciiBoxMaintenanceClient } from "@companion/box-runtime";

import {
  createBoxSimServer,
  type BoxSimServerHandle,
  type BoxSimServerOptions,
} from "../src/server";

const API_KEY = "provider-test-key";
const CONTROL_TOKEN = "control-test-token";

const openServers: BoxSimServerHandle[] = [];

async function start(options: BoxSimServerOptions = {}): Promise<BoxSimServerHandle> {
  const handle = createBoxSimServer({
    ...options,
    apiKey: API_KEY,
    controlToken: CONTROL_TOKEN,
  });
  await handle.listen();
  openServers.push(handle);
  return handle;
}

async function provider(
  handle: BoxSimServerHandle,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${handle.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

async function expectBoxError(
  response: Response,
  status: number,
  code: string,
): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({
    ok: false,
    type: "box.error",
    status,
    code,
    message: expect.any(String),
    error: {
      code,
      message: expect.any(String),
      status,
      details: { error: expect.any(String) },
    },
    requestId: expect.stringMatching(/^req_box_sim_\d{8}$/),
  });
  expect((body.error as { message: string; details: { error: string } }).details.error)
    .toBe((body.error as { message: string }).message);
  return body;
}

async function control(
  handle: BoxSimServerHandle,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${handle.controlUrl}${path}`, {
    ...init,
    headers: {
      "X-Box-Sim-Token": CONTROL_TOKEN,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((handle) => handle.close()));
});

describe("Box simulator HTTP server", () => {
  it("keeps health public and both provider and control auth exact", async () => {
    const handle = await start();

    expect((await fetch(`${handle.baseUrl}/health`)).status).toBe(200);
    const errors = await Promise.all([
      expectBoxError(await fetch(`${handle.baseUrl}/boxes?apiKey=${API_KEY}`), 401, "unauthorized"),
      expectBoxError(await fetch(`${handle.baseUrl}/boxes`, {
        headers: { Authorization: `bearer ${API_KEY}` },
      }), 401, "unauthorized"),
      expectBoxError(await fetch(`${handle.controlUrl}/state`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      }), 401, "invalid_control_token"),
    ]);
    expect(new Set(errors.map((error) => error.requestId)).size).toBe(3);
    expect(errors.map((error) => error.requestId)).toEqual([
      "req_box_sim_00000002",
      "req_box_sim_00000003",
      "req_box_sim_00000004",
    ]);
    expect(JSON.stringify(errors)).not.toContain(API_KEY);
    expect(JSON.stringify(errors)).not.toContain(CONTROL_TOKEN);
    expect((await control(handle, "/state")).status).toBe(200);
  });

  it("uses the Box error envelope for unknown provider routes", async () => {
    const handle = await start();

    await expectBoxError(
      await provider(handle, "/unknown-provider-route"),
      404,
      "route_not_found",
    );
  });

  it("uses the Box error envelope for injected HTTP faults", async () => {
    const handle = await start();
    expect((await control(handle, "/faults", {
      method: "POST",
      body: JSON.stringify({
        point: "box.list.before",
        action: {
          kind: "http",
          status: 429,
          code: "synthetic_rate_limit",
          message: "Synthetic list rate limit",
        },
      }),
    })).status).toBe(201);

    await expectBoxError(
      await provider(handle, "/boxes"),
      429,
      "synthetic_rate_limit",
    );
  });

  it("rejects non-array archive defaults without mutating simulator state", async () => {
    const handle = await start();
    const initial = handle.simulator.defaults;

    for (const archiveStates of [null, {}, 42, "archiving,archived"]) {
      await expectBoxError(await control(handle, "/defaults", {
        method: "PUT",
        body: JSON.stringify({ archiveStates }),
      }), 400, "invalid_defaults");
      expect(handle.simulator.defaults).toEqual(initial);
    }
  });

  it("removes a partially-created Box when the Pi controller factory throws", async () => {
    const handle = await start({
      piControllerFactory: () => {
        throw new Error("synthetic factory diagnostic must not escape");
      },
    });

    const failure = await expectBoxError(await provider(handle, "/boxes", {
      method: "POST",
      body: "{}",
    }), 502, "pi_scenario_failed");
    expect(JSON.stringify(failure)).not.toContain("factory diagnostic");
    expect(handle.simulator.snapshot().boxes).toEqual([]);
    expect(await (await provider(handle, "/boxes")).json()).toMatchObject({ boxes: [] });
  });

  it("rejects malformed list limits instead of returning a misleading page", async () => {
    const handle = await start();
    const created = await (await provider(handle, "/boxes", {
      method: "POST",
      body: "{}",
    })).json() as { box: { id: string } };

    for (const limit of ["", "wat", "1junk", "0", "-1", "1.5", "201"]) {
      await expectBoxError(
        await provider(handle, `/boxes?limit=${encodeURIComponent(limit)}`),
        400,
        "invalid_request",
      );
    }
    expect(await (await provider(handle, "/boxes?limit=1")).json()).toMatchObject({
      boxes: [{ id: created.box.id }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
  });

  it("serves deterministic create, observe, patch, list, stop, resume, and desktop envelopes", async () => {
    const handle = await start();
    const createdResponse = await provider(handle, "/boxes", {
      method: "POST",
      body: JSON.stringify({
        name: "caller-controlled-name-must-be-ignored",
        desktopAvailable: false,
        ttlSeconds: 300,
        setupScript: "super-secret-setup-script",
        env: { SECRET_TOKEN: "never-project-me" },
      }),
    });
    expect(createdResponse.status).toBe(202);
    const created = await createdResponse.json() as {
      box: { id: string; name: string; state: string; desktopAvailable: boolean };
    };
    expect(created.box).toMatchObject({
      id: "bx_23456789",
      name: "box-sim-23456789",
      state: "provisioning",
      desktopAvailable: true,
    });
    expect(created.box.name).not.toBe("caller-controlled-name-must-be-ignored");

    const first = await (await provider(handle, `/boxes/${created.box.id}`)).json() as {
      box: { state: string };
    };
    const provisionedWrite = await provider(handle, `/boxes/${created.box.id}/files`, {
      method: "PUT",
      body: JSON.stringify({ path: ".companion/provisioned.txt", content: "bootable\n" }),
    });
    const second = await (await provider(handle, `/boxes/${created.box.id}`)).json() as {
      box: { state: string; setupStatus: string };
    };
    expect(first.box.state).toBe("provisioned");
    expect(provisionedWrite.status).toBe(200);
    expect(second.box).toMatchObject({ state: "ready", setupStatus: "done" });

    const patched = await provider(handle, `/boxes/${created.box.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Companion test", ttlSeconds: 21_600 }),
    });
    expect(await patched.json()).toMatchObject({
      type: "box.updated",
      box: { name: "Companion test", ttlSeconds: 21_600 },
    });
    expect(await (await provider(handle, "/boxes?limit=200&sort=desc")).json()).toMatchObject({
      type: "box.list",
      boxes: [{ id: created.box.id, name: "Companion test" }],
      pageInfo: { hasMore: false, nextCursor: null },
    });

    const desktop = await provider(handle, `/boxes/${created.box.id}/desktop?vnc=1`, {
      method: "POST",
      body: "{}",
    });
    expect(await desktop.json()).toMatchObject({
      type: "desktop.url",
      transport: "vnc",
      desktopUrl: `https://desktop.box-sim.invalid/${created.box.id}/vnc?token=sim-0001`,
    });

    const stopped = await provider(handle, `/boxes/${created.box.id}/stop`, {
      method: "POST",
      body: JSON.stringify({ force: false }),
    });
    expect(await stopped.json()).toMatchObject({ type: "box.stopping", box: { state: "archiving" } });
    expect(handle.simulator.snapshot().boxes[0]?.daemon).toMatchObject({
      status: "inactive",
      invocationId: null,
      rpcReady: false,
    });
    expect(await (await provider(handle, `/boxes/${created.box.id}`)).json())
      .toMatchObject({ box: { state: "archived", desktopAvailable: false } });

    const resumed = await provider(handle, `/boxes/${created.box.id}/resume`, {
      method: "POST",
      body: JSON.stringify({ noEnv: true, ttlSeconds: 600 }),
    });
    expect(await resumed.json()).toMatchObject({ type: "box.resuming", box: { state: "provisioning" } });
    expect(await (await provider(handle, `/boxes/${created.box.id}`)).json())
      .toMatchObject({ box: { state: "ready", ttlSeconds: 600 } });
    expect(handle.simulator.commandMachine(created.box.id).persistentFiles.get(
      ".ascii/playbook.json",
    )?.toString()).toContain('"boot":"resumed"');
  });

  it("keeps secret values out of the control snapshot", async () => {
    const handle = await start();
    const created = await (await provider(handle, "/boxes", {
      method: "POST",
      body: JSON.stringify({
        setupScript: "script-secret-417",
        env: { PROVIDER_SECRET: "provider-secret-991" },
      }),
    })).json() as { box: { id: string } };
    await provider(handle, `/boxes/${created.box.id}`);
    await provider(handle, `/boxes/${created.box.id}`);
    await provider(handle, `/boxes/${created.box.id}/files`, {
      method: "PUT",
      body: JSON.stringify({
        path: ".companion/runtime/state/providers.env",
        content: "API_TOKEN=file-secret-228",
      }),
    });

    const snapshot = await (await control(handle, "/state")).text();
    expect(snapshot).not.toContain("script-secret-417");
    expect(snapshot).not.toContain("provider-secret-991");
    expect(snapshot).not.toContain("file-secret-228");
    expect(snapshot).toContain("setupScriptSha256");
    expect(snapshot).toContain("providers.env");
  });

  it("runs the JSONL Pi controller by default through HTTP command shims", async () => {
    const handle = await start();
    const created = await (await provider(handle, "/boxes", {
      method: "POST",
      body: "{}",
    })).json() as { box: { id: string } };
    await provider(handle, `/boxes/${created.box.id}`);
    await provider(handle, `/boxes/${created.box.id}`);
    for (const [path, content] of [
      [".companion/pi/auth.json", "{}\n"],
      [".companion/runtime/state/providers.env", "SIM_TOKEN=redacted\n"],
    ]) {
      expect((await provider(handle, `/boxes/${created.box.id}/files`, {
        method: "PUT",
        body: JSON.stringify({ path, content }),
      })).status).toBe(200);
    }

    const startCommand = [
      "staged_credential_file=x",
      "systemctl --user daemon-reload",
      "systemctl --user start companion-pi-daemon.service",
    ].join("; ");
    const started = await provider(handle, `/boxes/${created.box.id}/commands`, {
      method: "POST",
      body: JSON.stringify({ command: startCommand }),
    });
    expect(await started.json()).toMatchObject({ success: true, exitCode: 0 });

    const promptCommand = brokerCommand({
      id: "http-turn-1",
      type: "prompt",
      attemptId: "attempt-http-1",
      message: "hello simulator",
    });
    const prompted = await provider(handle, `/boxes/${created.box.id}/commands`, {
      method: "POST",
      body: JSON.stringify({ command: promptCommand, timeoutSeconds: 10 }),
    });
    const acknowledgement = await prompted.json() as { success: boolean; stdout: string };
    expect(acknowledgement.success).toBe(true);
    expect(JSON.parse(acknowledgement.stdout)).toMatchObject({
      type: "response",
      command: "prompt",
      id: "http-turn-1",
      success: true,
      data: { attemptId: "attempt-http-1", piAcknowledged: true },
    });

    // The simulated Pi writes its journal from a real child process, so the acknowledgement only
    // promises the prompt was accepted. Poll for the first projected line instead of yielding one
    // macrotask, which is not a synchronization point and loses the race on a loaded machine.
    const readCommand = brokerCommand({ id: "http-read-1", type: "read_events", after: 0 });
    const readEvents = async () => await (await provider(handle, `/boxes/${created.box.id}/commands`, {
      method: "POST",
      body: JSON.stringify({ command: readCommand }),
    })).json() as { success: boolean; stdout: string };
    let read = await readEvents();
    const journalDeadline = Date.now() + 10_000;
    while (
      Date.now() < journalDeadline
      && !(JSON.parse(read.stdout) as { data: { events: unknown[] } }).data.events.length
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      read = await readEvents();
    }
    expect(read.success).toBe(true);
    const journal = JSON.parse(read.stdout) as { data: { events: Array<Record<string, unknown>> } };
    expect(journal.data.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ attemptId: "attempt-http-1", kind: "pi_event" }),
    ]));
    expect(journal.data.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({ type: "response" }) }),
    ]));
  });

  it("requires target-specific confirmation and tracks deletion deterministically", async () => {
    const handle = await start();
    const created = await (await provider(handle, "/boxes", {
      method: "POST",
      body: "{}",
    })).json() as { box: { id: string } };

    expect((await provider(handle, `/boxes/${created.box.id}`, {
      method: "DELETE",
    })).status).toBe(409);
    expect((await provider(handle, `/boxes/${created.box.id}`, {
      method: "DELETE",
      headers: { "X-Ascii-Confirm-Delete": "bx_wrong000" },
    })).status).toBe(409);

    const accepted = await provider(handle, `/boxes/${created.box.id}`, {
      method: "DELETE",
      headers: { "X-Ascii-Confirm-Delete": created.box.id },
    });
    expect(accepted.status).toBe(202);
    const operation = await accepted.json() as { operation: { id: string; status: string } };
    expect(operation.operation).toMatchObject({
      id: "bdop_00000000000000000000000000000001",
      targetId: created.box.id,
      status: "pending",
      attemptCount: 0,
      completedAt: null,
    });
    expect((await provider(handle, `/boxes/${created.box.id}`)).status).toBe(404);
    expect(await (await control(handle, `/deletion-operations/${operation.operation.id}`, {
      method: "PUT",
      body: JSON.stringify({ status: "blocked" }),
    })).json()).toMatchObject({ operation: { status: "blocked", attemptCount: 1 } });
    expect(await (await provider(handle, `/deletion-operations/${operation.operation.id}`)).json())
      .toMatchObject({ operation: { status: "blocked" } });
    await control(handle, `/deletion-operations/${operation.operation.id}`, {
      method: "PUT",
      body: JSON.stringify({ status: "processing" }),
    });
    expect(await (await provider(handle, `/deletion-operations/${operation.operation.id}`)).json())
      .toMatchObject({ operation: { status: "processing" } });
    expect(await (await provider(handle, `/deletion-operations/${operation.operation.id}`)).json())
      .toMatchObject({ operation: { status: "completed" } });
  });

  it("serves the maintenance client's list, permanent-delete, and completed-operation contract", async () => {
    const handle = await start();
    const created = await (await provider(handle, "/boxes", {
      method: "POST",
      body: "{}",
    })).json() as { box: { id: string } };
    await provider(handle, `/boxes/${created.box.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Companion maintenance contract" }),
    });
    const maintenance = new AsciiBoxMaintenanceClient({
      COMPANION_BOX_API_KEY: API_KEY,
      COMPANION_BOX_API_BASE: handle.baseUrl,
    });

    await expect(maintenance.listAllBoxes()).resolves.toContainEqual({
      id: created.box.id,
      name: "Companion maintenance contract",
      state: "provisioning",
    });
    const deletion = await maintenance.requestPermanentDeletion({ boxId: created.box.id });
    expect(deletion.outcome).toBe("accepted");
    if (deletion.outcome !== "accepted") throw new Error("simulator did not accept deletion");

    let operation = deletion.operation;
    for (let poll = 0; poll < 4 && operation.status !== "completed"; poll += 1) {
      operation = await maintenance.getDeletionOperation({
        operationId: operation.id,
        boxId: created.box.id,
      });
    }
    expect(operation).toMatchObject({
      id: deletion.operation.id,
      targetId: created.box.id,
      status: "completed",
    });
  });

  it("supports an explicit transient idle state before archive completion", async () => {
    const handle = await start();
    await control(handle, "/defaults", {
      method: "PUT",
      body: JSON.stringify({ archiveStates: ["archiving", "idle", "archived"] }),
    });
    const created = await (await provider(handle, "/boxes", {
      method: "POST",
      body: "{}",
    })).json() as { box: { id: string } };
    await provider(handle, `/boxes/${created.box.id}`);
    await provider(handle, `/boxes/${created.box.id}`);
    await provider(handle, `/boxes/${created.box.id}/stop`, { method: "POST", body: "{}" });

    expect(await (await provider(handle, `/boxes/${created.box.id}`)).json())
      .toMatchObject({ box: { state: "idle" } });
    expect(await (await provider(handle, `/boxes/${created.box.id}`)).json())
      .toMatchObject({ box: { state: "archived" } });
  });

  it("saves a named snapshot and clones its persistent files onto a new Box", async () => {
    const handle = await start();
    const created = await (await provider(handle, "/boxes", {
      method: "POST",
      body: "{}",
    })).json() as { box: { id: string } };
    await provider(handle, `/boxes/${created.box.id}`);
    await provider(handle, `/boxes/${created.box.id}`);
    await provider(handle, `/boxes/${created.box.id}/files`, {
      method: "PUT",
      body: JSON.stringify({
        path: ".companion/runtime/state/pi-layout.version",
        content: "14:baked:overlay=deadbeef",
      }),
    });

    const saved = await (await provider(handle, "/named-snapshots", {
      method: "POST",
      body: JSON.stringify({ boxId: created.box.id, name: "companion-l14-aaaaaaaaaaaa" }),
    })).json() as { snapshot: { name: string; status: string } };
    expect(saved.snapshot).toMatchObject({
      name: "companion-l14-aaaaaaaaaaaa",
      status: "saving",
    });
    expect(await (await provider(handle, "/named-snapshots/companion-l14-aaaaaaaaaaaa")).json())
      .toMatchObject({ snapshot: { status: "ready" } });

    const cloned = await (await provider(handle, "/boxes", {
      method: "POST",
      body: JSON.stringify({ from: "companion-l14-aaaaaaaaaaaa" }),
    })).json() as { box: { id: string; state: string } };
    expect(cloned.box.state).toBe("cloning");
    expect(cloned.box.id).not.toBe(created.box.id);
    await provider(handle, `/boxes/${cloned.box.id}`);
    await provider(handle, `/boxes/${cloned.box.id}`);
    expect(handle.simulator.commandMachine(cloned.box.id).persistentFiles.get(
      ".companion/runtime/state/pi-layout.version",
    )?.toString()).toBe("14:baked:overlay=deadbeef");
  });
});

function brokerCommand(command: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(command), "utf8").toString("base64");
  return `COMPANION_PI_BROKER_COMMAND='${encoded}' node <<'COMPANION_PI_BROKER_CLIENT'`;
}
