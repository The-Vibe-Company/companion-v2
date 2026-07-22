import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const clientPath = fileURLToPath(new URL("../skill/scripts/companion-agent-client.mjs", import.meta.url));

function runClient(
  input: unknown,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [clientPath], { env, stdio: ["pipe", "pipe", "pipe"] });
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
    const result = spawnSync(process.execPath, [clientPath], {
      input: "{}",
      encoding: "utf8",
      env: process.env,
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: "expected one JSON request on stdin" });
    expect(result.stderr).toBe("");
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
});
