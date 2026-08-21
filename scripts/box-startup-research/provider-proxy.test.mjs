import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createBoxLeaseProxy } from "./provider-proxy.mjs";

const BAKER_BOX_ID = "bx_23456789";
const BOX_ID = "bx_3456789a";
const OTHER_BOX_ID = "bx_456789ab";
const OPERATION_ID = `bdop_${"a".repeat(32)}`;
const COMPANION_ID = "11111111-1111-4111-a111-111111111111";
const BAKER_COMPANION_ID = "22222222-2222-4222-a222-222222222222";
const BOX_NAME = `Companion ${COMPANION_ID} g1`;
const SNAPSHOT_NAME = "companion-l14-abcdef123456";
const REAL_KEY = "box-real-controller-credential";

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function fakeProvider(input = {}) {
  const boxIds = [BAKER_BOX_ID, BOX_ID];
  const deleted = new Set();
  let creates = 0;
  let snapshotDeleted = true;
  const authorizations = [];
  const commands = [];
  const server = createServer((request, response) => {
    void (async () => {
      authorizations.push(request.headers.authorization);
      const url = new URL(request.url || "/", "http://provider.invalid");
      const requestBody = await body(request);
      const json = (status, value) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/boxes" && request.method === "POST") {
        const id = boxIds[creates++];
        return json(202, {
          ok: true,
          type: "box.created",
          status: "provisioning",
          ttlSeconds: requestBody.ttlSeconds,
          box: { id, state: "provisioning" },
        });
      }
      if (url.pathname === "/boxes" && request.method === "GET") {
        return json(200, {
          ok: true,
          type: "box.list",
          boxes: [
            ...boxIds.filter((id) => !deleted.has(id)).map((id) => ({
              id,
              name: id === BOX_ID ? BOX_NAME : `Companion ${BAKER_COMPANION_ID} g1`,
              state: "ready",
            })),
            { id: OTHER_BOX_ID, name: "unrelated", state: "ready" },
          ],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      const exactBox = /^\/boxes\/(bx_[^/]+)$/.exec(url.pathname)?.[1];
      if (boxIds.includes(exactBox) && request.method === "GET") {
        return deleted.has(exactBox)
          ? json(404, { code: "box_not_found" })
          : json(200, { ok: true, type: "box.info", box: { id: exactBox, name: BOX_NAME, state: "ready" } });
      }
      if (url.pathname === `/boxes/${BOX_ID}` && request.method === "PATCH") {
        return json(200, { ok: true, type: "box.updated", box: { id: BOX_ID, ...requestBody, state: "ready" } });
      }
      if (url.pathname === `/boxes/${BOX_ID}/resume` && request.method === "POST") {
        return json(200, { ok: true, type: "box.info", box: { id: BOX_ID, name: BOX_NAME, state: "ready" } });
      }
      if (url.pathname === `/boxes/${BOX_ID}/stop` && request.method === "POST") {
        return json(200, { ok: true, type: "box.info", box: { id: BOX_ID, name: BOX_NAME, state: "archived" } });
      }
      if (boxIds.some((id) => url.pathname === `/boxes/${id}/commands`)
        && request.method === "POST" && requestBody.command.includes("companion_pi_bin")
        && !requestBody.command.includes("COMPANION_RESEARCH_BROKER_CLIENT")) {
        return json(200, {
          ok: true,
          type: "command.completed",
          success: true,
          stdout: `pi ${"1".repeat(64)}\nnode ${"2".repeat(64)}\npi_path /usr/bin/pi\nnode_path /usr/bin/node\nuid ${input.uid ?? 1000}\n`,
          stderr: "",
        });
      }
      if (url.pathname === `/boxes/${BOX_ID}/commands` && request.method === "POST") {
        commands.push(requestBody.command);
        const encoded = /COMPANION_PI_BROKER_COMMAND='([^']+)'/.exec(requestBody.command)?.[1];
        const prompt = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        return json(200, {
          ok: true,
          type: "command.completed",
          success: true,
          stdout: `${JSON.stringify({
            type: "response",
            command: "prompt",
            id: prompt.id,
            success: true,
            data: {
            piAcknowledged: true,
            attemptId: prompt.attemptId,
            invocationId: "invocation-1",
            initialCursor: 0,
            clearOutbox: true,
          } })}\n`,
          stderr: "",
        });
      }
      if (url.pathname === "/named-snapshots" && request.method === "POST") {
        snapshotDeleted = false;
        return json(202, { ok: true, type: "snapshot.named", snapshot: {
          name: SNAPSHOT_NAME,
          status: "ready",
          sourceBoxId: requestBody.boxId,
          createdAt: new Date(0).toISOString(),
        } });
      }
      if (url.pathname === `/named-snapshots/${SNAPSHOT_NAME}` && request.method === "DELETE") {
        snapshotDeleted = true;
        return json(200, { ok: true, type: "snapshot.named.deleted" });
      }
      if (url.pathname === `/named-snapshots/${SNAPSHOT_NAME}` && request.method === "GET") {
        return snapshotDeleted
          ? json(404, { code: "box_not_found" })
          : json(200, { ok: true, type: "snapshot.named", snapshot: {
            name: SNAPSHOT_NAME,
            status: "ready",
            sourceBoxId: BOX_ID,
            createdAt: new Date(0).toISOString(),
          } });
      }
      if (boxIds.includes(exactBox) && request.method === "DELETE") {
        deleted.add(exactBox);
        return json(202, { ok: true, type: "box.deleting", operation: {
          id: OPERATION_ID,
          targetId: exactBox,
          status: "completed",
          attemptCount: 1,
          requestedAt: new Date(0).toISOString(),
          completedAt: new Date(0).toISOString(),
        } });
      }
      return json(404, { code: "not_found" });
    })().catch(() => response.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake provider did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    authorizations,
    commands,
    close: async () => await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

test("limits a benchmark to its leased provider resources and independently proves cleanup", async () => {
  const upstream = await fakeProvider();
  const lease = await createBoxLeaseProxy({
    apiKey: REAL_KEY,
    upstreamBase: upstream.baseUrl,
    companionIds: [BAKER_COMPANION_ID, COMPANION_ID],
    snapshotName: SNAPSHOT_NAME,
    brokerSha256: "f".repeat(64),
  });
  const call = async (path, options = {}) => await fetch(`${lease.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${lease.apiKey}`,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  try {
    const create = async () => await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true }),
    });
    assert.equal((await create()).status, 202);
    assert.equal((await call(`/boxes/${BAKER_BOX_ID}`)).status, 200);
    assert.equal((await call("/named-snapshots", {
      method: "POST",
      body: JSON.stringify({ boxId: BAKER_BOX_ID, name: SNAPSHOT_NAME }),
    })).status, 202);
    assert.equal((await call(`/boxes/${BAKER_BOX_ID}`, {
      method: "DELETE",
      headers: { "x-ascii-confirm-delete": BAKER_BOX_ID },
    })).status, 202);
    assert.equal((await create()).status, 202);
    const listed = await call("/boxes?limit=200&sort=desc");
    assert.deepEqual((await listed.json()).boxes.map((box) => box.id), [BOX_ID]);
    assert.equal((await call(`/boxes/${OTHER_BOX_ID}`)).status, 403);
    assert.equal((await call(`/boxes/${BOX_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ name: BOX_NAME, ttlSeconds: 21_600 }),
    })).status, 200);
    assert.equal((await call(`/boxes/${BOX_ID}`)).status, 200);
    const promptCommand = (attemptId) => {
      const prompt = Buffer.from(JSON.stringify({
        id: `runtime-change-e2e:${attemptId}`,
        type: "prompt",
        attemptId,
        message: "probe",
        requiredInput: ["text"],
        clearOutbox: true,
      })).toString("base64");
      return `COMPANION_PI_BROKER_COMMAND='${prompt}'`;
    };
    const prompt = async (attemptId) => await call(`/boxes/${BOX_ID}/commands`, {
      method: "POST",
      body: JSON.stringify({ command: promptCommand(attemptId), timeoutSeconds: 8 }),
    });
    assert.equal((await prompt("33333333-3333-4333-a333-333333333333")).status, 200);
    assert.equal((await call(`/boxes/${BOX_ID}/stop`, {
      method: "POST",
      body: JSON.stringify({ force: false }),
    })).status, 200);
    assert.equal((await call(`/boxes/${BOX_ID}/resume`, {
      method: "POST",
      body: JSON.stringify({ noEnv: true, ttlSeconds: 21_600 }),
    })).status, 200);
    assert.equal((await call(`/boxes/${BOX_ID}`)).status, 200);
    assert.equal((await prompt("44444444-4444-4444-a444-444444444444")).status, 200);
    assert.equal((await call(`/named-snapshots/${SNAPSHOT_NAME}`, { method: "DELETE" })).status, 200);
    assert.equal((await call(`/boxes/${BOX_ID}`, {
      method: "DELETE",
      headers: { "x-ascii-confirm-delete": BOX_ID },
    })).status, 202);
    const evidence = await lease.proxy.prove({ cycles: 1 });
    assert.deepEqual({ ...evidence, metrics: undefined }, {
      createdBoxes: 2,
      resumedBoxes: 1,
      archivedBoxes: 1,
      commandCalls: 2,
      cleanupProven: true,
      metrics: undefined,
    });
    for (const metric of Object.values(evidence.metrics)) {
      assert.equal(metric.samples, 1);
      assert.ok(metric.p50_ms >= 0);
      assert.equal(metric.p50_ms, metric.p95_ms);
    }
    assert.equal(upstream.commands.length, 2);
    assert.ok(upstream.commands.every((command) =>
      command.includes("/usr/bin/systemctl --user is-active --quiet companion-pi-daemon.service")
      && command.includes("export PATH=/usr/bin:/bin")
      && command.includes("'/usr/bin/node' <<'COMPANION_RESEARCH_BROKER_CLIENT'")
      && command.includes("NODE_|LD_|DYLD_")
      && command.includes("companion_node_search_safe")
      && command.includes("/proc/$companion_child/exe")
      && command.includes(`sha256sum "$broker_script"`)
      && command.includes("/proc/$companion_main_pid/environ")
      && command.includes("socket:[$companion_socket_inode]")
      && command.includes("f".repeat(64))
      && command.includes("1".repeat(64))
      && command.includes("2".repeat(64))
      && command.includes("COMPANION_RESEARCH_BROKER_CLIENT")));
    assert.ok(upstream.authorizations.every((value) => value === `Bearer ${REAL_KEY}`));
  } finally {
    await lease.proxy.close();
    await upstream.close();
  }
});

test("rejects a root Box command boundary before candidate writes", async () => {
  const upstream = await fakeProvider({ uid: 0 });
  const lease = await createBoxLeaseProxy({
    apiKey: REAL_KEY,
    upstreamBase: upstream.baseUrl,
    companionIds: [BAKER_COMPANION_ID, COMPANION_ID],
    snapshotName: SNAPSHOT_NAME,
    brokerSha256: "f".repeat(64),
  });
  const call = async (path, options = {}) => await fetch(`${lease.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${lease.apiKey}`,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  try {
    assert.equal((await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true }),
    })).status, 202);
    assert.equal((await call(`/boxes/${BAKER_BOX_ID}`)).status, 403);
  } finally {
    await lease.proxy.close();
    await upstream.close();
  }
});
