import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const PARENT_SNAPSHOT_NAME = "companion-l14-222222222222";
const REAL_KEY = "box-real-controller-credential";

const DEFAULT_SNAPSHOTS = [
  {
    name: SNAPSHOT_NAME,
    status: "ready",
    sourceBoxId: BOX_ID,
    createdAt: "2026-08-20T12:00:00.000Z",
  },
  {
    name: "companion-l14-333333333333",
    status: "ready",
    sourceBoxId: BOX_ID,
    createdAt: "2026-08-20T13:00:00.000Z",
  },
  {
    name: PARENT_SNAPSHOT_NAME,
    status: "ready",
    sourceBoxId: BOX_ID,
    createdAt: "2026-08-20T13:00:00.000Z",
  },
  {
    name: "companion-l14-111111111111",
    status: "ready",
    sourceBoxId: BOX_ID,
    createdAt: "2026-08-19T12:00:00.000Z",
  },
  {
    name: "companion-l14-ABCDEF123456",
    status: "ready",
    sourceBoxId: BOX_ID,
    createdAt: "2026-08-21T12:00:00.000Z",
  },
  {
    name: "unrelated-image",
    status: "ready",
    sourceBoxId: BOX_ID,
    createdAt: "2026-08-21T13:00:00.000Z",
  },
];

function validCreateEnvelope(boxId) {
  return {
    ok: true,
    type: "box.created",
    status: "provisioning",
    ttlSeconds: 900,
    box: { id: boxId, state: "provisioning" },
  };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function fakeProvider(input = {}) {
  const boxIds = [BAKER_BOX_ID, BOX_ID];
  const snapshotLists = input.snapshotLists ?? [input.snapshots ?? DEFAULT_SNAPSHOTS];
  const createResponses = input.createResponses ?? [];
  const deleted = new Set();
  let createRequests = 0;
  let createdBoxes = 0;
  let snapshotListCalls = 0;
  let snapshotDeleted = true;
  let attestationRequests = 0;
  const authorizations = [];
  const commands = [];
  const createBodies = [];
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
        const outcome = createResponses[createRequests++] ?? {};
        createBodies.push(requestBody);
        if (outcome.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, outcome.delayMs));
        }
        if (outcome.networkError === true) return response.destroy();
        const status = outcome.status ?? 202;
        if (outcome.body !== undefined) return json(status, outcome.body);
        if (status < 200 || status >= 300) return json(status, { code: "box_create_failed" });
        const id = boxIds[createdBoxes++];
        return json(status, {
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
      if (url.pathname === "/named-snapshots" && request.method === "GET") {
        const snapshots = snapshotLists[Math.min(snapshotListCalls++, snapshotLists.length - 1)] ?? [];
        return json(200, {
          ok: true,
          type: "snapshot.named.list",
          snapshots,
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
        const outcome = input.attestationResponses?.[attestationRequests++];
        if (outcome) return json(outcome.status, outcome.body);
        return json(200, {
          ok: true,
          type: "command.completed",
          success: true,
          stdout: `pi ${"1".repeat(64)}\nnode ${"2".repeat(64)}\npi_path ${input.piPath ?? "/usr/bin/pi"}\nnode_path /usr/bin/node\npi_uid ${input.piUid ?? 0}\npi_mode ${input.piMode ?? 755}\nuid ${input.uid ?? 1000}\n`,
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
  if (!address || !Object.hasOwn(address, "port")) throw new Error("fake provider did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    authorizations,
    commands,
    createBodies,
    attestationRequests: () => attestationRequests,
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
    const listedSnapshots = await call("/named-snapshots");
    assert.equal(listedSnapshots.status, 200);
    assert.deepEqual((await listedSnapshots.json()).snapshots.map((snapshot) => snapshot.name), [
      SNAPSHOT_NAME,
      PARENT_SNAPSHOT_NAME,
    ]);
    assert.equal((await call(`/named-snapshots/${PARENT_SNAPSHOT_NAME}`)).status, 403);
    assert.equal((await call(`/named-snapshots/${PARENT_SNAPSHOT_NAME}`, {
      method: "DELETE",
    })).status, 403);
    const create = async (from) => await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from }),
    });
    assert.equal((await create(PARENT_SNAPSHOT_NAME)).status, 202);
    assert.equal((await call(`/boxes/${BAKER_BOX_ID}`)).status, 200);
    assert.equal((await call("/named-snapshots", {
      method: "POST",
      body: JSON.stringify({ boxId: BAKER_BOX_ID, name: SNAPSHOT_NAME }),
    })).status, 202);
    assert.equal((await call(`/boxes/${BAKER_BOX_ID}`, {
      method: "DELETE",
      headers: { "x-ascii-confirm-delete": BAKER_BOX_ID },
    })).status, 202);
    assert.equal((await create(SNAPSHOT_NAME)).status, 202);
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
    assert.deepEqual(upstream.createBodies.map((requestBody) => requestBody.from), [
      PARENT_SNAPSHOT_NAME,
      SNAPSHOT_NAME,
    ]);
    assert.ok(upstream.commands.every((command) =>
      command.includes("/usr/bin/systemctl --user is-active --quiet companion-pi-daemon.service")
      && command.includes("export PATH=/usr/bin:/bin")
      && command.includes("'/usr/bin/node' <<'COMPANION_RESEARCH_BROKER_CLIENT'")
      && command.includes("NODE_|LD_|DYLD_")
      && command.includes("companion_node_search_safe")
      && command.includes("companion_pi_child_ready=false")
      && command.includes("/usr/bin/seq 1 40")
      && command.includes("/proc/$companion_child/exe")
      && command.includes(`sha256sum "$broker_script"`)
      && command.includes("/proc/$companion_main_pid/environ")
      && command.includes("socket:[$companion_socket_inode]")
      && command.includes("f".repeat(64))
      && command.includes("1".repeat(64))
      && command.includes("2".repeat(64))
      && command.includes("COMPANION_RESEARCH_BROKER_CLIENT")));
    const pollStart = upstream.commands[0].indexOf("companion_pi_child_ready=false");
    const pollEnd = upstream.commands[0].indexOf("companion_attest_broker", pollStart);
    assert.ok(pollStart >= 0 && pollEnd > pollStart);
    const missingMainPidPoll = upstream.commands[0]
      .slice(pollStart, pollEnd)
      .replaceAll("\0", "\\0")
      .replace(
        '$(/usr/bin/systemctl --user show companion-pi-daemon.service -p MainPID --value 2>/dev/null || true)',
        '$(printf 0)',
      )
      .replace('$(/usr/bin/seq 1 40)', '$(printf 1)')
      .replace('\n[ "$companion_pi_child_ready" = true ]\n', '\nprintf poll-reached\n');
    assert.equal(execFileSync("/bin/bash", ["-c", `set -euo pipefail\n${missingMainPidPoll}`], {
      encoding: "utf8",
    }).trim(), "poll-reached");
    assert.ok(upstream.authorizations.every((value) => value === `Bearer ${REAL_KEY}`));
  } finally {
    await lease.proxy.close();
    await upstream.close();
  }
});

test("requires the selected parent first and the target snapshot for later creates", async () => {
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
  const create = async (from) => {
    const requestBody = { ttlSeconds: 900, noEnv: true };
    if (from !== undefined) requestBody.from = from;
    return await call("/boxes", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
  };
  try {
    assert.equal((await call("/named-snapshots")).status, 200);
    assert.equal((await create()).status, 403);
    assert.equal((await create(SNAPSHOT_NAME)).status, 403);
    assert.equal((await create("companion-l14-999999999999")).status, 403);
    assert.equal((await create(PARENT_SNAPSHOT_NAME)).status, 202);
    assert.equal((await create()).status, 403);
    assert.equal((await create(PARENT_SNAPSHOT_NAME)).status, 403);
    assert.equal((await create("companion-l14-999999999999")).status, 403);
    assert.equal((await create(SNAPSHOT_NAME)).status, 202);
    assert.deepEqual(upstream.createBodies.map((requestBody) => requestBody.from), [
      PARENT_SNAPSHOT_NAME,
      SNAPSHOT_NAME,
    ]);
  } finally {
    await lease.proxy.close();
    await upstream.close();
  }
});

test("retries the same parent source after an explicit provider failure", async () => {
  const upstream = await fakeProvider({ createResponses: [{ status: 503 }, {}, {}] });
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
  const create = async (from) => await call("/boxes", {
    method: "POST",
    body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from }),
  });
  try {
    assert.equal((await call("/named-snapshots")).status, 200);
    assert.equal((await create(PARENT_SNAPSHOT_NAME)).status, 503);
    assert.equal((await create(SNAPSHOT_NAME)).status, 403);
    assert.equal((await create(PARENT_SNAPSHOT_NAME)).status, 202);
    assert.equal((await create(SNAPSHOT_NAME)).status, 202);
    assert.deepEqual(upstream.createBodies.map((requestBody) => requestBody.from), [
      PARENT_SNAPSHOT_NAME,
      PARENT_SNAPSHOT_NAME,
      SNAPSHOT_NAME,
    ]);
  } finally {
    await lease.proxy.close();
    await upstream.close();
  }
});

test("retries the target source after a later provider failure", async () => {
  const upstream = await fakeProvider({ createResponses: [{}, { status: 503 }, {}] });
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
  const create = async (from) => await call("/boxes", {
    method: "POST",
    body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from }),
  });
  try {
    assert.equal((await call("/named-snapshots")).status, 200);
    assert.equal((await create(PARENT_SNAPSHOT_NAME)).status, 202);
    assert.equal((await create(SNAPSHOT_NAME)).status, 503);
    assert.equal((await create(PARENT_SNAPSHOT_NAME)).status, 403);
    assert.equal((await create(SNAPSHOT_NAME)).status, 202);
    assert.deepEqual(upstream.createBodies.map((requestBody) => requestBody.from), [
      PARENT_SNAPSHOT_NAME,
      SNAPSHOT_NAME,
      SNAPSHOT_NAME,
    ]);
  } finally {
    await lease.proxy.close();
    await upstream.close();
  }
});

test("blocks further creates after an ambiguous provider mutation", async () => {
  const cases = [
    { name: "network failure", createResponses: [{ networkError: true }] },
    {
      name: "invalid successful response",
      createResponses: [{
        status: 202,
        body: { ok: true, type: "box.created", box: { id: "not-a-box-id" } },
      }],
    },
    {
      name: "full envelope with non-202 status",
      createResponses: [{ status: 201, body: validCreateEnvelope(BAKER_BOX_ID) }],
      createdId: BAKER_BOX_ID,
    },
    {
      name: "malformed 202 with a valid nested id",
      createResponses: [{
        status: 202,
        body: { ok: true, type: "box.created", box: { id: BAKER_BOX_ID } },
      }],
      createdId: BAKER_BOX_ID,
    },
  ];
  for (const scenario of cases) {
    await testAmbiguousCreateCase(scenario);
  }
});

async function testAmbiguousCreateCase(scenario) {
  const upstream = await fakeProvider({ createResponses: scenario.createResponses });
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
    assert.equal((await call("/named-snapshots")).status, 200);
    assert.equal((await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from: PARENT_SNAPSHOT_NAME }),
    })).status, 403, scenario.name);
    if (scenario.createdId !== undefined) {
      assert.equal((await call(`/boxes/${scenario.createdId}`)).status, 200, scenario.name);
    }
    assert.equal((await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from: PARENT_SNAPSHOT_NAME }),
    })).status, 403, scenario.name);
    assert.deepEqual(upstream.createBodies.map((requestBody) => requestBody.from), [
      PARENT_SNAPSHOT_NAME,
    ], scenario.name);
  } finally {
    await lease.proxy.close();
    await upstream.close();
  }
}

test("rejects a concurrent create while the provider create is in flight", async () => {
  const upstream = await fakeProvider({ createResponses: [{ delayMs: 100 }, {}] });
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
  const create = async (from) => await call("/boxes", {
    method: "POST",
    body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from }),
  });
  try {
    assert.equal((await call("/named-snapshots")).status, 200);
    const first = create(PARENT_SNAPSHOT_NAME);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await create(PARENT_SNAPSHOT_NAME)).status, 403);
    assert.equal((await first).status, 202);
    assert.equal((await create(SNAPSHOT_NAME)).status, 202);
    assert.deepEqual(upstream.createBodies.map((requestBody) => requestBody.from), [
      PARENT_SNAPSHOT_NAME,
      SNAPSHOT_NAME,
    ]);
  } finally {
    await lease.proxy.close();
    await upstream.close();
  }
});

test("fails closed when no eligible parent is present", async () => {
  const noParentSnapshots = [
    {
      name: SNAPSHOT_NAME,
      status: "ready",
      sourceBoxId: BOX_ID,
      createdAt: "2026-08-20T12:00:00.000Z",
    },
    {
      name: "companion-l14-12345678901a",
      status: "saving",
      sourceBoxId: BOX_ID,
      createdAt: "2026-08-21T12:00:00.000Z",
    },
    {
      name: "unrelated-image",
      status: "ready",
      sourceBoxId: BOX_ID,
      createdAt: "2026-08-21T13:00:00.000Z",
    },
  ];
  const upstream = await fakeProvider({
    snapshotLists: [noParentSnapshots, DEFAULT_SNAPSHOTS],
  });
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
    const listed = await call("/named-snapshots");
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).snapshots.map((snapshot) => snapshot.name), [SNAPSHOT_NAME]);
    const listedAgain = await call("/named-snapshots");
    assert.equal(listedAgain.status, 200);
    assert.deepEqual((await listedAgain.json()).snapshots.map((snapshot) => snapshot.name), [SNAPSHOT_NAME]);
    assert.equal((await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true }),
    })).status, 403);
    assert.equal((await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from: null }),
    })).status, 403);
    assert.equal((await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from: SNAPSHOT_NAME }),
    })).status, 403);
    assert.deepEqual(upstream.createBodies, []);
  } finally {
    await lease.proxy.close();
    await upstream.close();
  }
});

test("pins the first eligible parent when a later list offers a different one", async () => {
  const newerParent = "companion-l14-444444444444";
  const upstream = await fakeProvider({
    snapshotLists: [
      [
        {
          name: SNAPSHOT_NAME,
          status: "ready",
          sourceBoxId: BOX_ID,
          createdAt: "2026-08-20T12:00:00.000Z",
        },
        {
          name: PARENT_SNAPSHOT_NAME,
          status: "ready",
          sourceBoxId: BOX_ID,
          createdAt: "2026-08-20T13:00:00.000Z",
        },
      ],
      [
        {
          name: SNAPSHOT_NAME,
          status: "ready",
          sourceBoxId: BOX_ID,
          createdAt: "2026-08-20T12:00:00.000Z",
        },
        {
          name: newerParent,
          status: "ready",
          sourceBoxId: BOX_ID,
          createdAt: "2026-08-21T13:00:00.000Z",
        },
        {
          name: PARENT_SNAPSHOT_NAME,
          status: "ready",
          sourceBoxId: BOX_ID,
          createdAt: "2026-08-20T13:00:00.000Z",
        },
      ],
    ],
  });
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
    assert.deepEqual(
      (await (await call("/named-snapshots")).json()).snapshots.map((snapshot) => snapshot.name),
      [SNAPSHOT_NAME, PARENT_SNAPSHOT_NAME],
    );
    assert.deepEqual(
      (await (await call("/named-snapshots")).json()).snapshots.map((snapshot) => snapshot.name),
      [SNAPSHOT_NAME, PARENT_SNAPSHOT_NAME],
    );
    assert.equal((await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from: newerParent }),
    })).status, 403);
    assert.equal((await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from: PARENT_SNAPSHOT_NAME }),
    })).status, 202);
    assert.equal((await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from: SNAPSHOT_NAME }),
    })).status, 202);
    assert.deepEqual(upstream.createBodies.map((requestBody) => requestBody.from), [
      PARENT_SNAPSHOT_NAME,
      SNAPSHOT_NAME,
    ]);
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
    assert.equal((await call("/named-snapshots")).status, 200);
    assert.equal((await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from: PARENT_SNAPSHOT_NAME }),
    })).status, 202);
    assert.equal((await call(`/boxes/${BAKER_BOX_ID}`)).status, 403);
  } finally {
    await lease.proxy.close();
    await upstream.close();
  }
});

test("pins an image-owned Pi launcher before candidate writes", async () => {
  const upstream = await fakeProvider({
    piPath: "/home/user/.nvm/versions/node/v24.18.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    piUid: 1000,
    piMode: 755,
    uid: 1000,
  });
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
    assert.equal((await call("/named-snapshots")).status, 200);
    assert.equal((await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from: PARENT_SNAPSHOT_NAME }),
    })).status, 202);
    assert.equal((await call(`/boxes/${BAKER_BOX_ID}`)).status, 200);
  } finally {
    await lease.proxy.close();
    await upstream.close();
  }
});

test("retries read-only runtime attestation while a ready Box command service catches up", async () => {
  const upstream = await fakeProvider({
    attestationResponses: [
      { status: 409, body: { code: "box_not_ready" } },
      { status: 200, body: { success: false, stdout: "", stderr: "" } },
    ],
    piPath: "/home/user/.nvm/versions/node/v24.18.1/bin/pi",
    piUid: 1000,
    piMode: 755,
    uid: 1000,
  });
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
    assert.equal((await call("/named-snapshots")).status, 200);
    assert.equal((await call("/boxes", {
      method: "POST",
      body: JSON.stringify({ ttlSeconds: 900, noEnv: true, from: PARENT_SNAPSHOT_NAME }),
    })).status, 202);
    assert.equal((await call(`/boxes/${BAKER_BOX_ID}`)).status, 200);
    assert.equal(upstream.attestationRequests(), 3);
  } finally {
    await lease.proxy.close();
    await upstream.close();
  }
});
