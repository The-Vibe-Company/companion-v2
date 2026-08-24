import assert from "node:assert/strict";
import test from "node:test";
import { cleanup, prepare } from "./ios-e2e-fixture.mjs";

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

test("prepares the shared API fixture without exposing a mobile-only contract", async () => {
  const requests = [];
  const fetchImpl = async (request, options) => {
    const record = {
      url: request.pathname,
      method: options.method ?? "GET",
      headers: new Headers(options.headers),
      body: options.body ? JSON.parse(options.body) : null,
    };
    requests.push(record);
    if (record.url === "/v1/auth/login") {
      return json({}, { headers: { "set-cookie": "ci.session_token=opaque; Path=/; HttpOnly" } });
    }
    if (record.url === "/v1/auth/whoami") {
      return json({ org: { org_id: "org-1" }, needsOnboarding: false });
    }
    if (record.url === "/v1/companion-providers/zai") {
      return json({ connection: { provider_id: "zai" } });
    }
    if (record.url === "/v1/companion-providers") {
      return json({
        catalog: [{ id: "zai", models: [{ id: "glm-test", default: true }] }],
        connections: [],
        default_provider_id: null,
        can_manage: true,
      });
    }
    if (record.url === "/v1/companions" && record.method === "GET") {
      return json({ companions: [] });
    }
    if (record.url === "/v1/companions" && record.method === "POST") {
      return json({ companion: { id: "companion-1" } }, { status: 201 });
    }
    return json({ error: "unexpected request" }, { status: 500 });
  };

  const result = await prepare({
    apiURL: new URL("http://127.0.0.1:3001"),
    email: "admin@thevibecompany.co",
    password: "adminadmin",
    zaiApiKey: "zai-secret",
  }, fetchImpl);

  assert.deepEqual(result, { companionId: "companion-1", modelId: "glm-test", created: true });
  const providerRequest = requests.find((request) => request.url.endsWith("/zai"));
  assert.equal(providerRequest.headers.get("cookie"), "ci.session_token=opaque");
  assert.equal(providerRequest.headers.get("x-companion-org"), "org-1");
  assert.equal(providerRequest.headers.get("origin"), "http://127.0.0.1:3001");
  assert.deepEqual(providerRequest.body, { auth_method: "api_key", credential: "zai-secret" });
  assert.equal(requests.some((request) => request.headers.has("client_surface")), false);
});

test("cleanup uses the public idempotency contract and waits for deletion", async () => {
  const requests = [];
  let rosterReads = 0;
  const fetchImpl = async (request, options) => {
    const record = {
      url: request.pathname,
      method: options.method ?? "GET",
      headers: new Headers(options.headers),
    };
    requests.push(record);
    if (record.url === "/v1/auth/login") {
      return json({}, { headers: { "set-cookie": "ci.session_token=opaque; Path=/; HttpOnly" } });
    }
    if (record.url === "/v1/auth/whoami") {
      return json({ org: { org_id: "org-1" }, needsOnboarding: false });
    }
    if (record.url === "/v1/companions" && record.method === "GET") {
      rosterReads += 1;
      return json({ companions: rosterReads === 1 ? [{ id: "companion-1", name: "Zai E2E La Paz" }] : [] });
    }
    if (record.url === "/v1/companions/companion-1" && record.method === "DELETE") {
      return json({ operation: { id: "operation-1" } }, { status: 202 });
    }
    return json({ error: "unexpected request" }, { status: 500 });
  };

  const result = await cleanup({
    apiURL: new URL("http://127.0.0.1:3001"),
    email: "admin@thevibecompany.co",
    password: "adminadmin",
    zaiApiKey: "",
  }, fetchImpl);

  assert.deepEqual(result, { deleted: 1 });
  const deletion = requests.find((request) => request.method === "DELETE");
  assert.match(deletion.headers.get("idempotency-key"), /^[0-9a-f-]{36}$/);
});

test("prepare and cleanup reject remote API targets before sending credentials or deletes", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return json({});
  };
  const configuration = {
    apiURL: new URL("https://api.example.test"),
    email: "admin@thevibecompany.co",
    password: "adminadmin",
    zaiApiKey: "zai-secret",
  };

  await assert.rejects(
    prepare(configuration, fetchImpl),
    /E2E API URL must target the isolated loopback stack/,
  );
  await assert.rejects(
    cleanup(configuration, fetchImpl),
    /E2E API URL must target the isolated loopback stack/,
  );
  assert.equal(requests, 0);
});
