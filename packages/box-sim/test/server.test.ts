import { afterEach, describe, expect, it } from "vitest";

import { createBoxSimServer, type BoxSimServerHandle } from "../src/server";

const API_KEY = "provider-test-key";
const CONTROL_TOKEN = "control-test-token";

const openServers: BoxSimServerHandle[] = [];

async function start(): Promise<BoxSimServerHandle> {
  const handle = createBoxSimServer({ apiKey: API_KEY, controlToken: CONTROL_TOKEN });
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
    expect((await fetch(`${handle.baseUrl}/boxes?apiKey=${API_KEY}`)).status).toBe(401);
    expect((await fetch(`${handle.baseUrl}/boxes`, {
      headers: { Authorization: `bearer ${API_KEY}` },
    })).status).toBe(401);
    expect((await fetch(`${handle.controlUrl}/state`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    })).status).toBe(401);
    expect((await control(handle, "/state")).status).toBe(200);
  });

  it("serves deterministic create, observe, patch, list, stop, resume, and desktop envelopes", async () => {
    const handle = await start();
    const createdResponse = await provider(handle, "/boxes", {
      method: "POST",
      body: JSON.stringify({
        ttlSeconds: 300,
        setupScript: "super-secret-setup-script",
        env: { SECRET_TOKEN: "never-project-me" },
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { box: { id: string; state: string } };
    expect(created.box).toMatchObject({ id: "bx_23456789", state: "provisioning" });

    const first = await (await provider(handle, `/boxes/${created.box.id}`)).json() as {
      box: { state: string };
    };
    const second = await (await provider(handle, `/boxes/${created.box.id}`)).json() as {
      box: { state: string; setupStatus: string };
    };
    expect(first.box.state).toBe("provisioned");
    expect(second.box).toMatchObject({ state: "ready", setupStatus: "done" });

    const patched = await provider(handle, `/boxes/${created.box.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Companion test", ttlSeconds: 21_600 }),
    });
    expect(await patched.json()).toMatchObject({
      type: "box.info",
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

    const payload = JSON.stringify({ id: "http-turn-1", type: "prompt", message: "hello simulator" });
    const quoted = `'${payload.replaceAll("'", "'\"'\"'")}'`;
    const promptCommand = [
      "set -euo pipefail",
      'fifo="$HOME/.companion/runtime/state/pi.rpc.in"',
      "rpc_start_size=0",
      `printf '%s\\n' ${quoted} > "$fifo"`,
      "printf 'Pi RPC did not acknowledge prompt' >&2",
    ].join("\n");
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
    });

    const readCommand = "log=pi.rpc.ndjson; offset=0; tail -c x | head -c 262144";
    const read = await (await provider(handle, `/boxes/${created.box.id}/commands`, {
      method: "POST",
      body: JSON.stringify({ command: readCommand }),
    })).json() as { success: boolean; stdout: string };
    expect(read.success).toBe(true);
    expect(read.stdout.startsWith("0\n")).toBe(true);
    expect(read.stdout).toContain('"id":"http-turn-1"');
    expect(handle.simulator.snapshot().boxes[0]?.daemon.rpcLogBytes).toBeGreaterThan(0);
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
});
