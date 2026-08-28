import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { AsciiBoxMaintenanceClient } from "@companion/box-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { resolveBoxLabConfig } from "../src/config";
import { BoxLabService } from "../src/lab";
import { createBoxLabServer, type BoxLabServerHandle } from "../src/server";
import { BoxLabStateStore } from "../src/state";
import { FakeDriver } from "./fakeDriver";

const API_KEY = "box-lab-test-key";
const openServers: BoxLabServerHandle[] = [];
const temporaryDirectories: string[] = [];
const boxEnvelopeSchema = z.object({
  box: z.object({
    id: z.string(),
    state: z.string(),
  }),
});

async function start(): Promise<{ handle: BoxLabServerHandle; driver: FakeDriver }> {
  const directory = await mkdtemp(resolve(tmpdir(), "companion-box-lab-test-"));
  temporaryDirectories.push(directory);
  const config = resolveBoxLabConfig({
    BOX_LAB_API_KEY: API_KEY,
    BOX_LAB_DRIVER: "oci-systemd",
    BOX_LAB_WORKSPACE_ID: "contract-test",
    BOX_LAB_STATE_DIR: directory,
  }, directory);
  const driver = new FakeDriver();
  const service = new BoxLabService({
    driver,
    store: new BoxLabStateStore(config.stateDirectory, config.workspaceScope),
    resourcePrefix: config.resourcePrefix,
    diagnosticsDirectory: config.diagnosticsDirectory,
  });
  const handle = createBoxLabServer({ config, service, port: 0 });
  await handle.listen();
  openServers.push(handle);
  return { handle, driver };
}

async function provider(handle: BoxLabServerHandle, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${API_KEY}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return await fetch(`${handle.baseUrl}${path}`, {
    ...init,
    headers,
  });
}

async function waitState(handle: BoxLabServerHandle, boxId: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await provider(handle, `/boxes/${boxId}`);
    const body = boxEnvelopeSchema.parse(await response.json());
    if (body.box.state === state) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  throw new Error(`Box did not reach ${state}`);
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Box Lab Box v1 server", () => {
  it("keeps health public, requires exact bearer auth, and rejects unsupported surfaces", async () => {
    const { handle } = await start();

    await expect((await fetch(`${handle.baseUrl}/health`)).json()).resolves.toMatchObject({
      ok: true,
      type: "box-lab.health",
      driver: "oci-systemd",
      workspaceId: "contract-test",
    });
    const unauthorized = await fetch(`${handle.baseUrl}/boxes?apiKey=${API_KEY}`);
    expect(unauthorized.status).toBe(401);
    expect(JSON.stringify(await unauthorized.json())).not.toContain(API_KEY);

    const create = await provider(handle, "/boxes", { method: "POST", body: "{}" });
    const created = boxEnvelopeSchema.parse(await create.json());
    await waitState(handle, created.box.id, "running");
    const desktop = await provider(handle, `/boxes/${created.box.id}/desktop`, { method: "POST", body: "{}" });
    expect(desktop.status).toBe(501);
    await expect(desktop.json()).resolves.toMatchObject({ code: "unsupported_surface" });
    const unknown = await provider(handle, "/not-a-provider-route");
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ code: "route_not_found" });
  });

  it("supports the real maintenance client plus files, commands, stop/resume, snapshots, clones, and deletion", async () => {
    const { handle, driver } = await start();
    const client = new AsciiBoxMaintenanceClient({
      COMPANION_BOX_API_KEY: API_KEY,
      COMPANION_BOX_API_BASE: handle.baseUrl,
    });
    const deadlineAt = new Date(Date.now() + 10_000);
    const created = await client.createOrRecoverGenerationBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      ttlSeconds: 3_600,
      deadlineAt,
      setupScript: "#!/bin/bash\nprintf setup\n",
    });
    expect(created.outcome).toBe("created");
    await client.applyGenerationBoxSettings({
      boxId: created.boxId,
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      ttlSeconds: 3_600,
      deadlineAt,
    });
    await waitState(handle, created.boxId, "running");

    const file = await provider(handle, `/boxes/${created.boxId}/files`, {
      method: "PUT",
      body: JSON.stringify({ path: ".companion/probe.txt", content: "alive\n" }),
    });
    expect(file.status).toBe(200);
    expect([...driver.resources.values()][0]!.files.get(".companion/probe.txt")?.toString("utf8"))
      .toBe("alive\n");
    const command = await provider(handle, `/boxes/${created.boxId}/commands`, {
      method: "POST",
      body: JSON.stringify({ command: "printf real-command", timeoutSeconds: 5 }),
    });
    await expect(command.json()).resolves.toMatchObject({ success: true, stdout: "printf real-command\n" });

    await provider(handle, `/boxes/${created.boxId}/stop`, { method: "POST", body: "{}" });
    await waitState(handle, created.boxId, "archived");
    await provider(handle, `/boxes/${created.boxId}/resume`, { method: "POST", body: "{}" });
    await waitState(handle, created.boxId, "running");

    await client.saveNamedSnapshot({ boxId: created.boxId, name: "contract-snapshot", deadlineAt });
    for (;;) {
      const snapshot = await client.getNamedSnapshot({ name: "contract-snapshot", deadlineAt });
      if (snapshot?.status === "ready") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    }
    const clone = await client.createEphemeralBox({
      ttlSeconds: 3_600,
      from: "contract-snapshot",
      deadlineAt,
    });
    await waitState(handle, clone.boxId, "running");
    expect([...driver.resources.values()].some((resource) => resource.files.has(".companion/probe.txt")))
      .toBe(true);

    await expect(client.deletePermanentlyAndWait({
      boxId: clone.boxId,
      deadlineAt,
      pollIntervalMs: 1,
    })).resolves.toMatchObject({ outcome: "deleted" });
    await client.deleteNamedSnapshot({ name: "contract-snapshot", deadlineAt });
    await expect(client.deletePermanentlyAndWait({
      boxId: created.boxId,
      deadlineAt,
      pollIntervalMs: 1,
    })).resolves.toMatchObject({ outcome: "deleted" });
    expect(driver.resources.size).toBe(0);
    expect(driver.snapshots.size).toBe(0);
  });

  it("rejects path traversal and deletion without exact confirmation", async () => {
    const { handle } = await start();
    const created = boxEnvelopeSchema.parse(
      await (await provider(handle, "/boxes", { method: "POST", body: "{}" })).json(),
    );
    await waitState(handle, created.box.id, "running");

    const traversal = await provider(handle, `/boxes/${created.box.id}/files`, {
      method: "PUT",
      body: JSON.stringify({ path: "../../etc/shadow", content: "no" }),
    });
    expect(traversal.status).toBe(400);
    const deletion = await provider(handle, `/boxes/${created.box.id}`, { method: "DELETE", body: "{}" });
    expect(deletion.status).toBe(409);
    await expect(deletion.json()).resolves.toMatchObject({ code: "delete_confirmation_required" });
  });
});
