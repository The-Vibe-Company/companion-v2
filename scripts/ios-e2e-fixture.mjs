#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const COMPANION_NAME = "Zai E2E La Paz";
const PROVIDER_ID = "zai";
const DELETE_TIMEOUT_MS = 15 * 60_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function sessionCookie(response) {
  const values = response.headers.getSetCookie();
  for (const value of values) {
    for (const part of value.split(/,(?=\s*[^;,=]+=[^;,]*)/)) {
      const pair = part.trim().split(";", 1)[0];
      const name = pair?.split("=", 1)[0];
      if (name?.endsWith(".session_token")) return pair;
    }
  }
  throw new Error("login did not return a session cookie");
}

function client(configuration, fetchImpl = fetch) {
  let cookie;
  let orgId;

  async function request(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json");
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    if (orgId) headers.set("x-companion-org", orgId);
    if (options.method && !["GET", "HEAD"].includes(options.method)) {
      headers.set("origin", configuration.apiURL.origin);
    }
    const response = await fetchImpl(new URL(path, configuration.apiURL), { ...options, headers });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const code = body?.code ?? body?.error ?? `http_${response.status}`;
      throw new Error(`${path} failed: ${code}`);
    }
    return { body, response };
  }

  return {
    async authenticate() {
      const login = await request("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: configuration.email,
          password: configuration.password,
          name: "iOS E2E",
        }),
      });
      cookie = sessionCookie(login.response);
      const identity = await request("/v1/auth/whoami");
      orgId = identity.body?.org?.org_id;
      if (!orgId || identity.body?.needsOnboarding) {
        throw new Error("test user is not onboarded into a workspace");
      }
    },
    request,
  };
}

function assertLoopbackAPI(configuration) {
  if (!["http:", "https:"].includes(configuration.apiURL.protocol)) {
    throw new Error("invalid E2E API URL");
  }
  if (!LOOPBACK_HOSTS.has(configuration.apiURL.hostname)) {
    throw new Error("E2E API URL must target the isolated loopback stack");
  }
}

export async function prepare(configuration, fetchImpl = fetch) {
  assertLoopbackAPI(configuration);
  const api = client(configuration, fetchImpl);
  await api.authenticate();
  await api.request(`/v1/companion-providers/${PROVIDER_ID}`, {
    method: "PUT",
    body: JSON.stringify({ auth_method: "api_key", credential: configuration.zaiApiKey }),
  });

  const providers = (await api.request("/v1/companion-providers")).body;
  const provider = providers?.catalog?.find((candidate) => candidate.id === PROVIDER_ID);
  const model = provider?.models?.find((candidate) => candidate.default) ?? provider?.models?.[0];
  if (!model?.id) throw new Error("z.ai catalog returned no model");

  const roster = (await api.request("/v1/companions")).body?.companions ?? [];
  const existing = roster.find((companion) => companion.name === COMPANION_NAME);
  if (existing) return { companionId: existing.id, modelId: existing.model_id ?? model.id, created: false };

  const created = (await api.request("/v1/companions", {
    method: "POST",
    body: JSON.stringify({
      name: COMPANION_NAME,
      persona: "Deterministic native iOS end-to-end verification Companion.",
      provider_id: PROVIDER_ID,
      model_id: model.id,
    }),
  })).body?.companion;
  if (!created?.id) throw new Error("Companion creation returned no id");
  return { companionId: created.id, modelId: model.id, created: true };
}

export async function cleanup(configuration, fetchImpl = fetch) {
  assertLoopbackAPI(configuration);
  const api = client(configuration, fetchImpl);
  await api.authenticate();
  const roster = (await api.request("/v1/companions")).body?.companions ?? [];
  const companions = roster.filter((companion) => companion.name === COMPANION_NAME);
  for (const companion of companions) {
    await api.request(`/v1/companions/${encodeURIComponent(companion.id)}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": randomUUID() },
    });
  }
  if (companions.length === 0) return { deleted: 0 };

  const deadline = Date.now() + DELETE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = (await api.request("/v1/companions")).body?.companions ?? [];
    if (!remaining.some((companion) => companion.name === COMPANION_NAME)) {
      return { deleted: companions.length };
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("timed out waiting for E2E Companion deletion");
}

function configuration() {
  const rawURL = required("COMPANION_IOS_E2E_API_URL");
  const apiURL = new URL(rawURL);
  return {
    apiURL,
    email: required("COMPANION_IOS_E2E_EMAIL"),
    password: required("COMPANION_IOS_E2E_PASSWORD"),
    zaiApiKey: process.env.COMPANION_BOX_E2E_ZAI_API_KEY?.trim() ?? "",
  };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const command = process.argv[2];
    const config = configuration();
    if (command === "prepare") {
      if (!config.zaiApiKey) throw new Error("missing COMPANION_BOX_E2E_ZAI_API_KEY");
      const result = await prepare(config);
      console.log(JSON.stringify({ status: "ready", ...result }));
    } else if (command === "cleanup") {
      const result = await cleanup(config);
      console.log(JSON.stringify({ status: "clean", ...result }));
    } else {
      throw new Error("usage: ios-e2e-fixture.mjs prepare|cleanup");
    }
  } catch (error) {
    console.error(`[ios-e2e-fixture] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
