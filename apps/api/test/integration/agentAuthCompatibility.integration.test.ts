import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AgentAuthClient, MemoryStorage, type ApprovalInfo } from "@auth/agent";
import { getRequestListener } from "@hono/node-server";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@companion/db";
import {
  createIntegrationFixture,
  integrationDb,
  type IntegrationFixture,
} from "./testDatabase";

const execFileAsync = promisify(execFile);
const password = "Agent-auth-compatibility-password-1!";
const temporaryPaths: string[] = [];

interface CompanionAuthModule {
  auth: { handler(request: Request): Promise<Response> };
  getAgentConfiguration(): Promise<Record<string, unknown>>;
  approveAgentCapabilities(input: {
    headers: Headers;
    agentId: string;
    approvalId: string;
    userCode: string;
    capabilities?: string[];
  }): Promise<unknown>;
}

interface AuthHarness {
  apiOrigin: string;
  webOrigin: string;
  authModule: CompanionAuthModule;
  sessionCookie: string;
  close(): Promise<void>;
}

const AUTH_ENV_KEYS = [
  "BETTER_AUTH_COOKIE_PREFIX",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "COMPANION_API_URL",
  "COMPANION_WEB_URL",
] as const;

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function serverOrigin(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function cookieHeader(headers: Headers): string {
  const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
    ?? [headers.get("set-cookie") ?? ""];
  const cookies = values
    .flatMap((value) => value.split(/,(?=[^;,]+=)/))
    .map((value) => value.split(";", 1)[0]?.trim())
    .filter((value): value is string => Boolean(value));
  if (cookies.length === 0) throw new Error("Better Auth sign-in did not return a session cookie");
  return cookies.join("; ");
}

async function startAuthHarness(
  topology: "separate" | "unified",
  user: IntegrationFixture["developer"],
): Promise<AuthHarness> {
  let apiListener: RequestListener = (_request, response) => {
    response.writeHead(503);
    response.end();
  };
  const apiServer = createServer((request, response) => apiListener(request, response));
  await listen(apiServer);
  const apiOrigin = serverOrigin(apiServer);

  const webServer = topology === "separate"
    ? createServer((_request, response) => {
        response.writeHead(404);
        response.end();
      })
    : null;
  if (webServer) await listen(webServer);
  const webOrigin = webServer ? serverOrigin(webServer) : apiOrigin;

  const previousEnvironment = Object.fromEntries(
    AUTH_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof AUTH_ENV_KEYS)[number], string | undefined>;
  process.env.BETTER_AUTH_COOKIE_PREFIX = `agent-auth-compat-${randomUUID()}`;
  process.env.BETTER_AUTH_SECRET = "agent-auth-compatibility-secret-at-least-32-characters";
  process.env.BETTER_AUTH_URL = apiOrigin;
  process.env.COMPANION_API_URL = apiOrigin;
  process.env.COMPANION_WEB_URL = webOrigin;

  vi.resetModules();
  const authModule = await import("@companion/auth") as CompanionAuthModule;
  apiListener = getRequestListener(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/agent-configuration") {
      return Response.json(await authModule.getAgentConfiguration());
    }
    if (url.pathname.startsWith("/auth/")) return authModule.auth.handler(request);
    return Response.json({ error: "not_found" }, { status: 404 });
  });

  const signIn = await fetch(`${apiOrigin}/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: webOrigin,
    },
    body: JSON.stringify({ email: user.email, password }),
  });
  if (!signIn.ok) {
    throw new Error(`Better Auth sign-in failed (${signIn.status}): ${await signIn.text()}`);
  }

  return {
    apiOrigin,
    webOrigin,
    authModule,
    sessionCookie: cookieHeader(signIn.headers),
    async close() {
      await closeServer(apiServer);
      if (webServer) await closeServer(webServer);
      for (const key of AUTH_ENV_KEYS) {
        const previous = previousEnvironment[key];
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    },
  };
}

async function approveDeviceRequest(input: {
  info: ApprovalInfo;
  harness: AuthHarness;
}): Promise<string> {
  const completeUrl = input.info.verification_uri_complete;
  if (!completeUrl) throw new Error("device flow did not return a complete verification URL");
  const approvalUrl = new URL(completeUrl);
  expect(approvalUrl.origin).toBe(input.harness.webOrigin);
  expect(approvalUrl.pathname).toBe("/device/capabilities");
  const agentId = approvalUrl.searchParams.get("agent_id");
  const userCode = approvalUrl.searchParams.get("code");
  if (!agentId || !userCode) throw new Error("device verification URL omitted agent id or user code");

  const approval = await integrationDb.query.approvalRequest.findFirst({
    where: and(
      eq(schema.approvalRequest.agentId, agentId),
      eq(schema.approvalRequest.method, "device_authorization"),
      eq(schema.approvalRequest.status, "pending"),
    ),
  });
  if (!approval) throw new Error("device approval row was not persisted");
  await input.harness.authModule.approveAgentCapabilities({
    headers: new Headers({ cookie: input.harness.sessionCookie }),
    agentId,
    approvalId: approval.id,
    userCode,
  });
  return agentId;
}

function cliPath(): string {
  return fileURLToPath(new URL("../../node_modules/@auth/agent-cli/dist/index.js", import.meta.url));
}

function runCliConnect(input: {
  harness: AuthHarness;
  storageDir: string;
  workspaceId: string;
}): Promise<{ agentId: string; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const constraints = JSON.stringify({
      "skills:read": { workspaceId: { eq: input.workspaceId } },
    });
    const child = spawn(process.execPath, [
      cliPath(),
      `--storage-dir=${input.storageDir}`,
      `--url=${input.harness.apiOrigin}`,
      "--host-name=Companion compatibility host",
      "--no-browser",
      "connect",
      "--provider",
      input.harness.apiOrigin,
      "--capabilities",
      "skills:read",
      "--constraints",
      constraints,
      "--mode",
      "delegated",
      "--preferred-method",
      "device_authorization",
      "--name",
      "Pinned CLI compatibility agent",
    ], {
      env: { ...process.env, AGENT_AUTH_STORAGE_DIR: input.storageDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let approvalStarted = false;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      if (!settled) reject(new Error(`CLI device flow timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20_000);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (approvalStarted) return;
      const match = stderr.match(/Open:\s+(https?:\/\/\S+)/);
      if (!match?.[1]) return;
      approvalStarted = true;
      const info: ApprovalInfo = {
        method: "device_authorization",
        verification_uri_complete: match[1],
        expires_in: 300,
        interval: 5,
      };
      void approveDeviceRequest({ info, harness: input.harness }).catch((error) => {
        child.kill();
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`CLI exited with ${code ?? signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      const approvalUrl = stderr.match(/Open:\s+(https?:\/\/\S+)/)?.[1];
      const agentId = approvalUrl ? new URL(approvalUrl).searchParams.get("agent_id") : null;
      if (!agentId) {
        reject(new Error(`CLI did not expose an agent id in its device URL\nstderr:\n${stderr}`));
        return;
      }
      resolve({ agentId, stdout, stderr });
    });
  });
}

async function expectConstraintViolation(statement: Promise<unknown>, constraint: string): Promise<void> {
  let caught: unknown;
  try {
    await statement;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect((caught as { cause?: unknown }).cause).toMatchObject({
    code: "23514",
    constraint_name: constraint,
  });
}

/**
 * Product promise:
 * Companion's pinned Agent Auth SDK and CLI can complete the real delegated device flow against
 * the deployed Better Auth handler, including constrained grants and one-minute execution JWTs.
 *
 * Regression caught:
 * An incompatible discovery shape, endpoint path, device response, persisted key format, JWT
 * audience, or capability response would otherwise leave generated install prompts unusable.
 *
 * Why integrated:
 * This crosses actual SDK/CLI code, HTTP, Better Auth, PostgreSQL plugin tables, signed session
 * cookies, device approval, key persistence, JTI storage, and capability execution.
 *
 * Failure proof:
 * Changing either pinned version, the advertised issuer/endpoints, device-only approval config,
 * workspace constraint shape, or JWT audience makes one of these end-to-end flows fail.
 */
describe("pinned Agent Auth SDK and CLI compatibility", () => {
  let fixture: IntegrationFixture;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    await integrationDb.insert(schema.account).values({
      id: `credential-${randomUUID()}`,
      userId: fixture.developer.id,
      accountId: fixture.developer.id,
      providerId: "credential",
      password: await hashPassword(password),
    });
  });

  afterAll(async () => {
    await fixture.cleanup();
    await Promise.all(temporaryPaths.map((path) => rm(path, { recursive: true, force: true })));
  });

  it("enforces inline-only host and agent keys at the database boundary", async () => {
    const hostId = `inline-only-host-${randomUUID()}`;
    await expectConstraintViolation(integrationDb.insert(schema.agentHost).values({
      id: `remote-host-${randomUUID()}`,
      name: "Remote host",
      userId: fixture.developer.id,
      jwksUrl: "https://keys.example/jwks",
      status: "active",
    }), "agent_host_remote_jwks_disabled");

    await integrationDb.insert(schema.agentHost).values({
      id: hostId,
      name: "Inline host",
      userId: fixture.developer.id,
      publicKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "inline" }),
      status: "active",
    });
    try {
      await expectConstraintViolation(integrationDb.insert(schema.agent).values({
        id: `remote-agent-${randomUUID()}`,
        name: "Remote agent",
        userId: fixture.developer.id,
        hostId,
        status: "active",
        mode: "delegated",
        publicKey: "inline-fallback",
        jwksUrl: "https://keys.example/jwks",
      }), "agent_remote_jwks_disabled");
    } finally {
      await integrationDb.delete(schema.agentHost).where(eq(schema.agentHost.id, hostId));
    }
  });

  it("completes discovery, device approval, constrained JWT execution with @auth/agent 0.6.2 across split origins", async () => {
    const harness = await startAuthHarness("separate", fixture.developer);
    try {
      let approvedAgentId: string | null = null;
      const client = new AgentAuthClient({
        storage: new MemoryStorage(),
        urls: [harness.apiOrigin],
        hostName: "Companion SDK compatibility host",
        approvalTimeoutMs: 20_000,
        async onApprovalRequired(info) {
          approvedAgentId = await approveDeviceRequest({ info, harness });
        },
      });
      const discovered = await client.init();
      expect(discovered).toHaveLength(1);
      expect(discovered[0]).toMatchObject({
        provider_name: "Companion",
        modes: ["delegated"],
        approval_methods: ["device_authorization"],
      });
      expect(discovered[0]!.issuer).toBe(`${harness.apiOrigin}/auth`);

      const connected = await client.connectAgent({
        provider: discovered[0]!.issuer,
        capabilities: [{
          name: "skills:read",
          constraints: { workspaceId: { eq: fixture.orgA } },
        }],
        mode: "delegated",
        preferredMethod: "device_authorization",
        name: "Pinned SDK compatibility agent",
      });
      expect(connected.status).toBe("active");
      expect(connected.agentId).toBe(approvedAgentId);
      expect(connected.capabilityGrants).toEqual(expect.arrayContaining([
        expect.objectContaining({ capability: "skills:read", status: "active" }),
      ]));

      const execution = await client.executeCapability({
        agentId: connected.agentId,
        capability: "skills:read",
        arguments: { workspaceId: fixture.orgA },
      });
      expect(JSON.stringify(execution)).toContain("skills:read");
      expect(JSON.stringify(execution)).toContain(fixture.orgA);

      const persisted = await integrationDb.query.agent.findFirst({
        where: eq(schema.agent.id, connected.agentId),
      });
      expect(persisted).toMatchObject({ userId: fixture.developer.id, status: "active" });
      const persistedGrant = await integrationDb.query.agentCapabilityGrant.findFirst({
        where: and(
          eq(schema.agentCapabilityGrant.agentId, connected.agentId),
          eq(schema.agentCapabilityGrant.capability, "skills:read"),
        ),
      });
      expect(persistedGrant?.constraints).toContain(fixture.orgA);
      client.destroy();
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("connects, persists, restores, checks status and executes with @auth/agent-cli 0.5.1 on one unified origin", async () => {
    const harness = await startAuthHarness("unified", fixture.developer);
    const storageDir = await mkdtemp(join(tmpdir(), "companion-agent-auth-cli-e2e-"));
    temporaryPaths.push(storageDir);
    try {
      const connected = await runCliConnect({
        harness,
        storageDir,
        workspaceId: fixture.orgA,
      });
      expect(connected.stdout).toContain('"status": "active"');
      expect(connected.stdout).toContain('"capability": "skills:read"');
      expect(connected.stderr).toContain(`${harness.apiOrigin}/device/capabilities`);

      const commonArgs = [
        cliPath(),
        `--storage-dir=${storageDir}`,
        `--url=${harness.apiOrigin}`,
      ];
      const env = { ...process.env, AGENT_AUTH_STORAGE_DIR: storageDir };
      const status = await execFileAsync(process.execPath, [
        ...commonArgs,
        "status",
        connected.agentId,
      ], { env, maxBuffer: 1024 * 1024 });
      expect(status.stdout).toContain('"status": "active"');
      expect(status.stdout).toContain(connected.agentId);

      const execution = await execFileAsync(process.execPath, [
        ...commonArgs,
        "execute",
        connected.agentId,
        "skills:read",
        "--args",
        JSON.stringify({ workspaceId: fixture.orgA }),
      ], { env, maxBuffer: 1024 * 1024 });
      expect(execution.stdout).toContain("skills:read");
      expect(execution.stdout).toContain(fixture.orgA);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
