import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";

const clientPath = fileURLToPath(new URL("../skill/scripts/companion-agent-client.mjs", import.meta.url));

function runClient(
  input: unknown,
  env: NodeJS.ProcessEnv,
  extraPipe = false,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [clientPath], {
      env,
      stdio: extraPipe ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("compiled Companion agent client", () => {
  it("starts as a standalone ESM executable", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-standalone-bundle-"));
    const isolatedClientPath = join(fixtureRoot, "companion-agent-client.mjs");
    copyFileSync(clientPath, isolatedClientPath);
    try {
      const result = spawnSync(process.execPath, [isolatedClientPath], {
        input: "{}",
        encoding: "utf8",
        env: process.env,
      });

      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: "expected one JSON request on stdin" });
      expect(result.stderr).toBe("");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects a checksum mismatch before writing a downloaded package", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-checksum-bundle-"));
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/zip" });
      response.end(Buffer.from("known-package-bytes"));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP address");
      const workspaceId = "00000000-0000-4000-8000-000000000001";
      const credentialsDirectory = join(fixtureRoot, ".companion");
      mkdirSync(credentialsDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(join(credentialsDirectory, "credentials.json"), JSON.stringify({
        schemaVersion: 3,
        activeWorkspaceId: workspaceId,
        workspaces: {
          [workspaceId]: {
            apiUrl: `http://127.0.0.1:${address.port}/v1`,
            legacyPat: { token: "cmp_pat_fixture" },
          },
        },
      }), { mode: 0o600 });
      const outputPath = join(fixtureRoot, "must-not-exist.zip");

      const result = await runClient({
        action: "download",
        workspaceId,
        path: "/skills/demo/versions/1.0.0/package",
        outputPath,
        checksum: `sha256:${"0".repeat(64)}`,
      }, {
        ...process.env,
        HOME: fixtureRoot,
        COMPANION_AUTH_MODE: "legacy-pat",
      });

      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: expect.stringContaining("download checksum mismatch") });
      expect(result.stderr).toBe("");
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("uses COMPANION_DELEGATION_TOKEN without credentials or approval output", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-delegation-env-"));
    const requests: Array<{ authorization?: string; target?: string }> = [];
    const server = createServer((request, response) => {
      requests.push({
        authorization: request.headers.authorization,
        target: request.headers["x-companion-delegation-target"] as string | undefined,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ skills: [] }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const syntheticToken = "cmp_pat_synthetic_delegation_env";
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP address");
      const result = await runClient({ action: "api", method: "GET", path: "/skills" }, {
        ...process.env,
        HOME: fixtureRoot,
        COMPANION_API_URL: `http://127.0.0.1:${address.port}/v1`,
        COMPANION_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
        COMPANION_DELEGATION_TOKEN: syntheticToken,
        COMPANION_DELEGATION_TARGET_ID: "conductor-workspace-1",
      });

      expect(result.status, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { skills: [] } });
      expect(result.stdout).not.toContain(syntheticToken);
      expect(result.stderr).toBe("");
      expect(requests).toEqual([{
        authorization: `Bearer ${syntheticToken}`,
        target: "conductor-workspace-1",
      }]);
      expect(existsSync(join(fixtureRoot, ".companion", "credentials.json"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("never starts connect/device approval while delegation env mode is active", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-delegation-no-connect-"));
    const syntheticToken = "cmp_pat_synthetic_no_connect";
    try {
      const result = await runClient({
        action: "connect",
        apiUrl: "https://companion.invalid/v1",
        workspaceId: "00000000-0000-4000-8000-000000000001",
      }, {
        ...process.env,
        HOME: fixtureRoot,
        COMPANION_DELEGATION_TOKEN: syntheticToken,
        COMPANION_API_URL: "https://companion.invalid/v1",
        COMPANION_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain(syntheticToken);
      expect(result.stdout).not.toContain("approval_required");
      expect(existsSync(join(fixtureRoot, ".companion", "credentials.json"))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("requires the workspace environment variable even when the request carries a workspace id", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-delegation-workspace-env-"));
    const syntheticToken = "cmp_pat_synthetic_workspace_env";
    try {
      const result = await runClient({
        action: "api",
        method: "GET",
        path: "/skills",
        workspaceId: "00000000-0000-4000-8000-000000000001",
      }, {
        ...process.env,
        HOME: fixtureRoot,
        COMPANION_API_URL: "https://companion.invalid/v1",
        COMPANION_DELEGATION_TOKEN: syntheticToken,
        COMPANION_WORKSPACE_ID: undefined,
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("requires COMPANION_API_URL and COMPANION_WORKSPACE_ID");
      expect(result.stdout).not.toContain(syntheticToken);
      expect(result.stderr).toBe("");
      expect(existsSync(join(fixtureRoot, ".companion", "credentials.json"))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("refuses a socket descriptor for delegation before reading credentials or issuing a token", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-delegation-socket-"));
    try {
      const result = await runClient({
        action: "delegate",
        outputFd: 3,
        targetWorkspaceId: "conductor-workspace-1",
      }, {
        ...process.env,
        HOME: fixtureRoot,
      }, true);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("requires a private owner-only FIFO");
      expect(result.stdout).not.toContain("cmp_pat_");
      expect(result.stdout).not.toContain("approval_required");
      expect(result.stderr).toBe("");
      expect(existsSync(join(fixtureRoot, ".companion", "credentials.json"))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("accepts the owner-only FIFO the bundled Python runtime builds, and only that", async () => {
    // companion_lib._private_secret_pipe is the only producer of these descriptors, and it
    // asserts the guard's conditions in Python rather than calling the guard itself. Tighten
    // the guard beyond what that helper builds and the Python suite stays green while secret
    // projection breaks again, which is exactly how the macOS outage happened. This runs both
    // descriptors through the real compiled guard so the two sides cannot drift apart.
    const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-delegation-fifo-"));
    const fifoPath = join(fixtureRoot, "pipe");
    const created = spawnSync("mkfifo", ["-m", "600", fifoPath]);
    expect(created.status).toBe(0);
    // Mirror the helper: open both ends, then unlink, so the descriptor under test is the
    // one the client actually receives in production.
    const readFd = openSync(fifoPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const writeFd = openSync(fifoPath, constants.O_WRONLY);
    unlinkSync(fifoPath);

    const delegateOverFd = (descriptor: number | "pipe") =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [clientPath], {
          env: { ...process.env, HOME: fixtureRoot },
          stdio: ["pipe", "pipe", "pipe", descriptor],
        });
        // Passing a raw descriptor widens the stdio types, so narrow them once here.
        const { stdin, stdout: childStdout, stderr: childStderr } = child;
        if (!stdin || !childStdout || !childStderr) {
          reject(new Error("expected piped stdin, stdout, and stderr"));
          return;
        }
        let stdout = "";
        let stderr = "";
        childStdout.on("data", (chunk) => { stdout += String(chunk); });
        childStderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject);
        child.once("close", (status) => resolve({ status, stdout, stderr }));
        stdin.end(JSON.stringify({
          action: "delegate",
          outputFd: 3,
          targetWorkspaceId: "conductor-workspace-1",
        }));
      });

    try {
      // delegate checks the descriptor before it reads credentials, so the guard is reached
      // even with an empty HOME. secret-redeem resolves credentials first and would fail
      // earlier, proving nothing about the descriptor.
      const overSocket = await delegateOverFd("pipe");
      expect(overSocket.stdout).toContain("requires a private owner-only FIFO");

      const overFifo = await delegateOverFd(writeFd);
      expect(overFifo.stdout).not.toContain("requires a private owner-only FIFO");
      expect(overFifo.stdout).not.toContain("requires an inherited private pipe descriptor");
      expect(JSON.parse(overFifo.stdout).ok).toBe(false); // stopped later, on missing credentials
      expect(overFifo.stdout).not.toContain("cmp_pat_");
      expect(overFifo.stderr).toBe("");
    } finally {
      closeSync(readFd);
      closeSync(writeFd);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("redacts delegation credentials from sensitive HTTP errors and all output", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-delegation-redaction-"));
    const syntheticToken = "cmp_pat_synthetic_sensitive_error";
    const server = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `unexpected ${syntheticToken}` }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP address");
      const result = await runClient({
        action: "api",
        method: "POST",
        path: "/tokens",
        body: { inherit_agent_grants: true },
      }, {
        ...process.env,
        HOME: fixtureRoot,
        COMPANION_API_URL: `http://127.0.0.1:${address.port}/v1`,
        COMPANION_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
        COMPANION_DELEGATION_TOKEN: syntheticToken,
      });

      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain(syntheticToken);
      expect(result.stdout).toContain("response body withheld");
      expect(result.stderr).toBe("");
      expect(existsSync(join(fixtureRoot, ".companion", "credentials.json"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("installs a checksum-pinned public release directly with the delegated PAT", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-delegation-public-install-"));
    const projectRoot = join(fixtureRoot, "project");
    mkdirSync(projectRoot, { recursive: true });
    const zip = zipSync({
      "SKILL.md": new TextEncoder().encode(
        "---\nname: delegated-public\ndescription: Delegated public install fixture.\n---\n\n# Delegated public install\n",
      ),
    });
    const checksum = `sha256:${createHash("sha256").update(zip).digest("hex")}`;
    const packageHeaders: Array<Record<string, string | undefined>> = [];
    const server = createServer((request, response) => {
      if (request.url === "/v1/public/skills/share-token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          slug: "delegated-public",
          public_release: { version: "1.0.0", checksum, size_bytes: zip.byteLength },
        }));
        return;
      }
      packageHeaders.push({
        authorization: request.headers.authorization,
        target: request.headers["x-companion-delegation-target"] as string | undefined,
      });
      response.writeHead(200, {
        "content-type": "application/zip",
        "cache-control": "private, no-store",
        "x-companion-public-version": "1.0.0",
      });
      response.end(Buffer.from(zip));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const syntheticToken = "cmp_pat_synthetic_public_install";
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP address");
      const result = await runClient({
        action: "public-install",
        token: "share-token",
        version: "1.0.0",
        checksum,
        sizeBytes: zip.byteLength,
        tool: "codex",
        scope: "project",
        projectRoot,
        confirmInstall: true,
      }, {
        ...process.env,
        HOME: fixtureRoot,
        COMPANION_API_URL: `http://127.0.0.1:${address.port}/v1`,
        COMPANION_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
        COMPANION_DELEGATION_TOKEN: syntheticToken,
        COMPANION_DELEGATION_TARGET_ID: "conductor-workspace-1",
      });

      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).not.toContain(syntheticToken);
      expect(result.stderr).toBe("");
      expect(packageHeaders).toEqual([{
        authorization: `Bearer ${syntheticToken}`,
        target: "conductor-workspace-1",
      }]);
      expect(existsSync(join(projectRoot, ".codex", "skills", "delegated-public", "SKILL.md"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
