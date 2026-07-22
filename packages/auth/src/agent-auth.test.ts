import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { discoverProvider, generateKeypair, signAgentJWT } from "@auth/agent";
import type { AgentSession, Constraints } from "@better-auth/agent-auth";
import { COMPANION_AGENT_OPERATION_REGISTRY } from "@companion/contracts/agent-operations";
import {
  AGENT_AUTH_CAPABILITIES,
  authorizeAgentOperation,
  capabilityForAgentOperation,
  emitAgentAuthEvent,
  registerAgentAuthEventSink,
} from "./agent-auth";
import { auth, getAgentConfiguration } from "./index";

const execFileAsync = promisify(execFile);
const tempPaths: string[] = [];

afterAll(async () => {
  await Promise.all(tempPaths.map((path) => rm(path, { recursive: true, force: true })));
});

function sessionWithGrant(constraints: Constraints): AgentSession {
  return {
    type: "delegated",
    agentId: "agent-1",
    userId: "user-1",
    user: { id: "user-1", email: "person@example.com", name: "Person" },
    host: { id: "host-1", userId: "user-1", status: "active" },
    agent: {
      id: "agent-1",
      name: "Codex",
      mode: "delegated",
      hostId: "host-1",
      createdAt: new Date(),
      activatedAt: new Date(),
      metadata: null,
      capabilityGrants: [
        {
          capability: "skills:read",
          constraints,
          grantedBy: "user-1",
          status: "active",
        },
      ],
    },
  };
}

describe("Agent Auth operation registry", () => {
  it("is closed over the five configured capabilities", () => {
    expect(AGENT_AUTH_CAPABILITIES.map((capability) => capability.name)).toEqual([
      "skills:read",
      "skills:write",
      "secrets:read",
      "secrets:write",
      "public-skills:install",
    ]);
    expect(capabilityForAgentOperation("GET", "/v1/skills/example")).toBe("skills:read");
    expect(capabilityForAgentOperation("DELETE", "/v1/orgs/current/members/user-1")).toBeNull();
    expect(capabilityForAgentOperation("POST", "/v1/skills/example/runs")).toBeNull();
    expect(capabilityForAgentOperation("POST", "/v1/skills")).toBeNull();
    expect(capabilityForAgentOperation("GET", "/v1/skills/example/versions/1.2.3/package")).toBeNull();
    expect(capabilityForAgentOperation("GET", "/v1/skills/example/versions/1.2.3/files/content")).toBeNull();
  });

  it("derives every direct REST authorization from the shared registry and excludes ticket transports", () => {
    for (const operation of COMPANION_AGENT_OPERATION_REGISTRY) {
      const concretePath = operation.path.replace(/:[^/]+/g, "example");
      const actual = capabilityForAgentOperation(operation.method, `/v1${concretePath}`);
      expect(actual, `${operation.method} ${operation.path}`).toBe(
        operation.transport === "rest" ? operation.capability : null,
      );
    }
  });

  it("requires the exact workspace constraint", () => {
    const workspaceId = "169b768e-b1d0-4dde-a62e-575022debe88";
    expect(
      authorizeAgentOperation({
        session: sessionWithGrant({ workspaceId }),
        method: "GET",
        pathname: "/v1/skills/example",
        workspaceId,
      }),
    ).not.toBeNull();
    expect(
      authorizeAgentOperation({
        session: sessionWithGrant({ workspaceId: { eq: workspaceId } }),
        method: "GET",
        pathname: "/v1/skills/example",
        workspaceId,
      }),
    ).not.toBeNull();
    expect(
      authorizeAgentOperation({
        session: sessionWithGrant({ workspaceId }),
        method: "GET",
        pathname: "/v1/skills/example",
        workspaceId: "eb0961c4-6674-4620-82f5-f844fcc6ce25",
      }),
    ).toBeNull();
    expect(
      authorizeAgentOperation({
        session: sessionWithGrant({ workspaceId: { eq: workspaceId, in: [workspaceId] } }),
        method: "GET",
        pathname: "/v1/skills/example",
        workspaceId,
      }),
    ).toBeNull();
  });
});

describe("Agent Auth event redaction", () => {
  it("never forwards capability arguments, output, or raw errors to an event sink", async () => {
    const received: unknown[] = [];
    const unregister = registerAgentAuthEventSink((event) => {
      received.push(event);
    });
    try {
      await emitAgentAuthEvent({
        type: "capability.executed",
        agentId: "agent-1",
        capability: "secrets:write",
        status: "error",
        arguments: { value: "SENTINEL_SECRET" },
        output: { ticket: "SENTINEL_SECRET" },
        error: "SENTINEL_SECRET",
        metadata: { method: "execute", status: "denied", secret: "SENTINEL_SECRET" },
      });
    } finally {
      unregister();
    }
    expect(received).toHaveLength(1);
    expect(JSON.stringify(received)).not.toContain("SENTINEL_SECRET");
    expect(received[0]).toMatchObject({
      type: "capability.executed",
      agentId: "agent-1",
      capability: "secrets:write",
      status: "error",
      metadata: { method: "execute", status: "denied" },
    });
  });
});

describe("pinned SDK and CLI compatibility", () => {
  it("lets @auth/agent 0.6.2 and @auth/agent-cli 0.5.1 consume the server discovery document", async () => {
    const configuration = await getAgentConfiguration();
    const server = createServer((request, response) => {
      if (request.url === "/.well-known/agent-configuration") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(configuration));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
      const origin = `http://127.0.0.1:${address.port}`;
      const discovered = await discoverProvider(origin);
      expect(discovered.provider_name).toBe("Companion");
      expect(discovered.modes).toEqual(["delegated"]);
      expect(discovered.approval_methods).toEqual(["device_authorization"]);

      const storageDir = await mkdtemp(join(tmpdir(), "companion-agent-auth-cli-"));
      tempPaths.push(storageDir);
      const cliPath = fileURLToPath(
        new URL("../node_modules/@auth/agent-cli/dist/index.js", import.meta.url),
      );
      const { stdout } = await execFileAsync(process.execPath, [cliPath, `--url=${origin}`, "discover", origin], {
        // CLI 0.5.1 defaults to directory-only discovery. URL mode is the
        // official opt-in for a self-hosted instance and enables direct
        // discovery without weakening its global directory policy.
        env: { ...process.env, AGENT_AUTH_STORAGE_DIR: storageDir },
      });
      expect(stdout).toContain("Companion");
      expect(stdout).toContain("device_authorization");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("generates one-minute, unique agent JWTs with the pinned SDK", async () => {
    const keypair = await generateKeypair();
    const first = await signAgentJWT({
      agentKeypair: keypair,
      agentId: "agent-1",
      audience: "https://companion.example.com",
      capabilities: ["skills:read"],
      expiresInSeconds: 60,
    });
    const second = await signAgentJWT({
      agentKeypair: keypair,
      agentId: "agent-1",
      audience: "https://companion.example.com",
      capabilities: ["skills:read"],
      expiresInSeconds: 60,
    });
    expect(first).not.toBe(second);
    const payload = JSON.parse(Buffer.from(first.split(".")[1]!, "base64url").toString("utf8")) as {
      exp: number;
      iat: number;
      jti: string;
      capabilities: string[];
    };
    expect(payload.exp - payload.iat).toBe(60);
    expect(payload.jti).toBeTruthy();
    expect(payload.capabilities).toEqual(["skills:read"]);
  });
});

describe("Agent Auth handler origin boundary", () => {
  it("rejects a forged Host before the Better Auth protocol handler", async () => {
    const configured = process.env.BETTER_AUTH_URL ?? process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001";
    const url = new URL("/auth/capability/list", configured);
    const response = await auth.handler(new Request(url, {
      headers: { host: "attacker.example" },
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_agent_auth_origin" });
  });

  it("rejects remote dynamic-host JWKS before the plugin can fetch them", async () => {
    const configured = process.env.BETTER_AUTH_URL ?? process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001";
    const payload = {
      iss: "host-attacker",
      aud: new URL(configured).origin,
      iat: Math.floor(Date.now() / 1_000),
      exp: Math.floor(Date.now() / 1_000) + 60,
      jti: "remote-jwks-probe",
      host_jwks_url: "https://metadata.attacker.example/jwks",
      agent_public_key: { kty: "OKP", crv: "Ed25519", x: "not-a-real-key" },
    };
    const token = [
      Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "host+jwt", kid: "probe" })).toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      "signature",
    ].join(".");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const response = await auth.handler(new Request(new URL("/auth/agent/register", configured), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          host: new URL(configured).host,
        },
        body: JSON.stringify({ name: "Probe", mode: "delegated" }),
      }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "remote_agent_jwks_disabled" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects a persisted host JWKS URL before session middleware", async () => {
    const configured = process.env.BETTER_AUTH_URL ?? process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001";
    const response = await auth.handler(new Request(new URL("/auth/host/create", configured), {
      method: "POST",
      headers: { "content-type": "application/json", host: new URL(configured).host },
      body: JSON.stringify({ name: "Unsafe host", jwks_url: "https://keys.example/jwks" }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "remote_agent_jwks_disabled" });
  });
});
