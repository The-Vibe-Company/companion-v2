import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AsciiBoxCompanionRuntime,
  BoxRuntimeConfigurationError,
} from "./boxCompanionRuntime";

const box = {
  id: "bx_23456789",
  state: "ready",
  desktopAvailable: true,
  setupStatus: "done",
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("AsciiBoxCompanionRuntime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails closed when the Box service key is absent", () => {
    expect(() => new AsciiBoxCompanionRuntime({})).toThrow(BoxRuntimeConfigurationError);
  });

  it("creates a no-env Box, installs Pi, and writes owner-only provider auth", async () => {
    let fileBody: Record<string, unknown> | undefined;
    let createBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.includes("/boxes?limit=200") && (!init?.method || init.method === "GET")) {
        return json({ boxes: [] });
      }
      if (url.endsWith("/boxes") && init?.method === "POST") {
        createBody = body;
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } }, 202);
      }
      if (url.endsWith("/boxes/bx_23456789") && init?.method === "PATCH") {
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } });
      }
      if (url.endsWith("/files") && init?.method === "PUT") {
        fileBody = body;
        return json({ ok: true });
      }
      if (url.endsWith("/commands") && init?.method === "POST") {
        const command = String(body.command);
        if (command.includes("is-active")) {
          return json({ success: true, exitCode: 0, stdout: "active\n", stderr: "" });
        }
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      if (url.endsWith("/boxes/bx_23456789")) return json({ box });
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_PI_INSTALL_COMMAND: "npm install --global @earendil-works/pi-coding-agent@1.2.3",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });
    const assigned = vi.fn(async () => undefined);

    const result = await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: null,
      providerAuth: {
        anthropic: { type: "api_key", key: "secret-value" },
      },
      onBoxAssigned: assigned,
    });

    expect(createBody).toMatchObject({
      noEnv: true,
      ttlSeconds: 300,
      env: {
        COMPANION_ID: "11111111-1111-4111-8111-111111111111",
        COMPANION_ORG_ID: "22222222-2222-4222-8222-222222222222",
      },
    });
    expect(String(createBody?.setupScript)).toContain("pi --mode rpc --session-dir");
    expect(String(createBody?.setupScript)).toContain("ExecStart=%h/.companion/bin/pi-daemon");
    expect(String(createBody?.setupScript)).not.toContain("OpenCode");
    expect(fileBody).toEqual({
      path: ".pi/agent/auth.json",
      content: "{\"anthropic\":{\"type\":\"api_key\",\"key\":\"secret-value\"}}\n",
    });
    expect(assigned).toHaveBeenCalledWith("bx_23456789");
    expect(result).toEqual({
      boxId: "bx_23456789",
      runtimeState: "running",
      daemonState: "running",
      desktopAvailable: true,
    });
  });

  it("recovers a deterministically named archived Box before restarting Pi", async () => {
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.includes("/boxes?limit=200") && (!init?.method || init.method === "GET")) {
        if (!url.includes("cursor=page-2")) {
          return json({
            boxes: [],
            pageInfo: { hasMore: true, nextCursor: "page-2" },
          });
        }
        return json({
          boxes: [{
            ...box,
            name: "Companion 11111111-1111-4111-8111-111111111111",
            state: "archived",
          }],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      if (url.endsWith("/boxes/bx_23456789") && (!init?.method || init.method === "GET")) {
        return json({ box });
      }
      if (url.endsWith("/resume") && init?.method === "POST") {
        expect(body).toEqual({ noEnv: true, ttlSeconds: 3600 });
        return json({ box: { ...box, state: "provisioning" } }, 202);
      }
      if (url.endsWith("/files") && init?.method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && init?.method === "POST") {
        return json({
          success: true,
          exitCode: 0,
          stdout: String(body.command).includes("is-active") ? "active\n" : "",
          stderr: "",
        });
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    const result = await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: null,
      providerAuth: {},
      onBoxAssigned: async () => undefined,
    });

    expect(result.runtimeState).toBe("running");
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/resume") && init?.method === "POST")).toBe(true);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/boxes") && init?.method === "POST")).toBe(false);
  });

  it("reports archived status without executing a command or waking the Box", async () => {
    const fetchMock = vi.fn(async () =>
      json({ box: { ...box, state: "archived", desktopAvailable: false } }));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const result = await runtime.status({ boxId: "bx_23456789" });

    expect(result).toMatchObject({ runtimeState: "stopped", daemonState: "stopped" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("best-effort removes the provider file when daemon start transport fails", async () => {
    const commands: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && (!init?.method || init.method === "GET")) {
        return json({ box });
      }
      if (url.endsWith("/files") && init?.method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && init?.method === "POST") {
        const command = String(body.command);
        commands.push(command);
        if (command.includes("restart companion-pi-daemon")) {
          return json({ code: "box_direct_failed", message: "command transport failed" }, 502);
        }
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      providerAuth: {
        anthropic: { type: "api_key", key: "secret-value" },
      },
      onBoxAssigned: async () => undefined,
    })).rejects.toThrow("command transport failed");

    expect(commands.some((command) =>
      command === "rm -f \"$HOME/.pi/agent/auth.json\"")).toBe(true);
  });

  it("best-effort archives a newly created Box when its id cannot be persisted", async () => {
    let stopped = false;
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.includes("/boxes?limit=200") && (!init?.method || init.method === "GET")) {
        return json({ boxes: [] });
      }
      if (url.endsWith("/boxes") && init?.method === "POST") {
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } }, 202);
      }
      if (url.endsWith("/boxes/bx_23456789") && init?.method === "PATCH") {
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } });
      }
      if (url.endsWith("/stop") && init?.method === "POST") {
        stopped = true;
        return json({ box: { ...box, state: "archiving" } }, 202);
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: null,
      providerAuth: {},
      onBoxAssigned: async () => {
        throw new Error("database unavailable");
      },
    })).rejects.toThrow("database unavailable");

    expect(stopped).toBe(true);
  });
});

