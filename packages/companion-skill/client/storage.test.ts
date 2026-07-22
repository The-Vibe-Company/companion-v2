import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import type { AgentConnection, HostIdentity } from "@auth/agent";
import { afterEach, describe, expect, it } from "vitest";

import {
  credentialsPath,
  loadCredentialsV3,
  migrateCredentialsV2ToV3,
  PrivateFileStorage,
  saveAgentCredentialReference,
} from "./storage.js";

const originalCompanionHome = process.env.COMPANION_HOME;

afterEach(() => {
  if (originalCompanionHome === undefined) delete process.env.COMPANION_HOME;
  else process.env.COMPANION_HOME = originalCompanionHome;
});

describe("credentials schema v3", () => {
  it("preserves old PATs only as explicit legacy credentials", () => {
    const migrated = migrateCredentialsV2ToV3({
      schemaVersion: 2,
      activeWorkspaceId: "workspace-1",
      workspaces: {
        "workspace-1": {
          apiUrl: "https://companion.example/v1",
          token: "cmp_pat_keep_me",
          updatedAt: "2026-07-21T00:00:00.000Z",
        },
      },
    });

    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.workspaces["workspace-1"]).toEqual({
      apiUrl: "https://companion.example/v1",
      legacyPat: {
        token: "cmp_pat_keep_me",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
      updatedAt: "2026-07-21T00:00:00.000Z",
    });
    expect(JSON.stringify(migrated)).not.toContain("privateKey");
  });

  it("migrates the on-disk file atomically with private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "companion-agent-credentials-"));
    process.env.COMPANION_HOME = root;
    mkdirSync(root, { recursive: true });
    writeFileSync(
      credentialsPath(),
      JSON.stringify({
        schemaVersion: 2,
        activeWorkspaceId: "workspace-1",
        workspaces: {
          "workspace-1": { apiUrl: "https://companion.example/v1", token: "cmp_pat_old" },
        },
      }),
      { mode: 0o600 },
    );

    const migrated = loadCredentialsV3();
    expect(migrated.schemaVersion).toBe(3);
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8")).schemaVersion).toBe(3);
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it("serializes TypeScript connects with Python credential writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "companion-agent-concurrent-"));
    process.env.COMPANION_HOME = root;
    mkdirSync(root, { recursive: true });
    writeFileSync(
      credentialsPath(),
      `${JSON.stringify({
        schemaVersion: 3,
        activeWorkspaceId: "workspace-1",
        workspaces: {
          "workspace-1": { apiUrl: "https://one.example/v1" },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const marker = join(root, "python-writer-ready");
    const python = spawn("python3", ["-c", `
import json, os, pathlib, tempfile, time
root = pathlib.Path(os.environ["COMPANION_HOME"])
lock = root / ".credentials.lock"
lock.mkdir(mode=0o700)
path = root / "credentials.json"
payload = json.loads(path.read_text(encoding="utf-8"))
(root / "python-writer-ready").write_text("ready", encoding="utf-8")
time.sleep(0.25)
payload["activeWorkspaceId"] = "workspace-2"
payload["workspaces"]["workspace-2"] = {"apiUrl": "https://two.example/v1"}
fd, temp_name = tempfile.mkstemp(prefix=".credentials.json.", suffix=".tmp", dir=root)
with os.fdopen(fd, "w", encoding="utf-8") as stream:
    json.dump(payload, stream)
    stream.write("\\n")
    stream.flush()
    os.fsync(stream.fileno())
os.replace(temp_name, path)
lock.rmdir()
`], {
      env: { ...process.env, COMPANION_HOME: root },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    python.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const exit = new Promise<number | null>((resolve) => python.once("exit", resolve));

    const markerDeadline = Date.now() + 2_000;
    while (!existsSync(marker) && Date.now() < markerDeadline) await delay(10);
    expect(existsSync(marker)).toBe(true);

    saveAgentCredentialReference({
      workspaceId: "workspace-3",
      apiUrl: "https://three.example/v1",
      issuer: "https://three.example",
      agentId: "agent-3",
    });

    expect(await exit, stderr).toBe(0);
    const stored = JSON.parse(readFileSync(credentialsPath(), "utf8")) as {
      workspaces: Record<string, unknown>;
    };
    expect(Object.keys(stored.workspaces).sort()).toEqual([
      "workspace-1",
      "workspace-2",
      "workspace-3",
    ]);
  });
});

describe("private Agent Auth SDK storage", () => {
  it("keeps host and agent private keys outside credentials.json in mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "companion-agent-storage-"));
    process.env.COMPANION_HOME = root;
    const storage = new PrivateFileStorage(join(root, "agent-auth"));
    const host = {
      keypair: {
        publicKey: { kty: "OKP", crv: "Ed25519", x: "public" },
        privateKey: { kty: "OKP", crv: "Ed25519", x: "public", d: "private-host" },
      },
      createdAt: Date.now(),
    } satisfies HostIdentity;
    const agent = {
      agentId: "agent-1",
      hostId: "host-1",
      providerName: "Companion",
      issuer: "https://companion.example/auth",
      mode: "delegated",
      agentKeypair: {
        publicKey: { kty: "OKP", crv: "Ed25519", x: "public-agent" },
        privateKey: { kty: "OKP", crv: "Ed25519", x: "public-agent", d: "private-agent" },
      },
      capabilityGrants: [],
      createdAt: Date.now(),
    } satisfies AgentConnection;

    await storage.setHostIdentity(host);
    await storage.setAgentConnection(agent.agentId, agent);

    expect(statSync(join(storage.root, "host.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(storage.root, "agents", "agent-1.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(storage.root, "agents", "agent-1.json"), "utf8")).toContain("private-agent");
  });
});
