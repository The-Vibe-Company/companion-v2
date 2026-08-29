import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { fakeModelServerSource, fakeModelSystemdUnit } from "../src/fakeModel";

const children = new Set<ChildProcess>();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null) throw new Error("Temporary fake-model listener did not expose a TCP port");
  // SAFETY: the server was explicitly bound to a numeric TCP port and an IPv4 host above.
  const tcpAddress = address as AddressInfo;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
  return tcpAddress.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  children.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    killTimer.unref();
    child.once("close", () => {
      clearTimeout(killTimer);
      resolvePromise();
    });
    child.kill("SIGTERM");
  });
}

async function waitForHealth(port: number, child: ChildProcess, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Fake model exited before readiness: ${stderr()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The child may still be binding its loopback listener.
    }
    await delay(10);
  }
  throw new Error(`Fake model did not become ready: ${stderr()}`);
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
});

describe("Box Lab fake model", () => {
  it("survives a client abort while reading a request body", async () => {
    const port = await availablePort();
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      fakeModelServerSource(port),
    ], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.add(child);
    let childStderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      childStderr += chunk.toString("utf8");
    });
    await waitForHealth(port, child, () => childStderr);

    await new Promise<void>((resolvePromise) => {
      const abortTimer = setTimeout(resolvePromise, 500);
      abortTimer.unref();
      const aborted = request({
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-length": "4096", "content-type": "application/json" },
      });
      const done = (): void => {
        clearTimeout(abortTimer);
        resolvePromise();
      };
      aborted.once("error", done);
      aborted.write('{"stream":true,');
      setTimeout(() => {
        aborted.destroy();
        done();
      }, 25).unref();
    });

    await delay(50);
    expect(child.exitCode).toBeNull();
    await expect(fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()))
      .resolves.toEqual({ ok: true });
    await stopChild(child);
  });

  it("pins a user-service PATH that includes the Box Node installation", () => {
    expect(fakeModelSystemdUnit()).toContain(
      "Environment=PATH=/home/user/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
  });
});
