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
    const files = new Map<string, string>();
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
        files.set(String(body.path), String(body.content));
        return json({ ok: true });
      }
      if (url.endsWith("/commands") && init?.method === "POST") {
        const command = String(body.command);
        if (command.includes("skills.next")) expect(body.timeoutSeconds).toBe(180);
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
      clientSurface: "web",
      providerAuth: {
        anthropic: { type: "api_key", key: "provider-secret" },
      },
      replaceProviderAuth: true,
      mcpCredentials: [
        { env_key: "GITHUB_TOKEN_WORK", value: "mcp-secret" },
      ],
      mcpAccounts: [{
        id: "github-work",
        label: "GitHub work",
        transport: "stdio",
        command: "github-mcp-server",
        args: ["stdio"],
        env: { GITHUB_TOKEN: "GITHUB_TOKEN_WORK" },
        lifecycle: "lazy",
        direct_tools: false,
      }],
      skills: [{
        slug: "incident-summary",
        version: "1.2.3",
        checksum: `sha256:${"a".repeat(64)}`,
        archive: Buffer.from("archive"),
      }],
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
    expect(String(createBody?.setupScript)).toContain("npm:pi-mcp-adapter@2.12.1");
    expect(String(createBody?.setupScript)).toContain("--no-skills");
    expect(String(createBody?.setupScript)).not.toContain("OpenCode");
    expect(fileBody).toEqual({
      path: ".companion/runtime/state/providers.env",
      content: "GITHUB_TOKEN_WORK=\"mcp-secret\"\n",
    });
    expect(files.get(".companion/pi/auth.json"))
      .toBe("{\"anthropic\":{\"type\":\"api_key\",\"key\":\"provider-secret\"}}\n");
    expect(files.get(".companion/runtime/state/skill-archives/incident-summary.tar.gz.b64"))
      .toBe(Buffer.from("archive").toString("base64"));
    expect(files.get(".companion/pi/mcp.json")).toContain("${GITHUB_TOKEN_WORK}");
    expect(files.get(".companion/pi/mcp.json")).not.toContain("mcp-secret");
    expect(files.get(".companion/pi/mcp.json")).not.toContain("provider-secret");
    expect(files.get(".companion/runtime/state/mcp-accounts.json")).toContain("GitHub work");
    expect(assigned).toHaveBeenCalledWith("bx_23456789");
    expect(result).toEqual({
      boxId: "bx_23456789",
      runtimeState: "running",
      daemonState: "running",
      desktopAvailable: true,
    });
  });

  it("recovers a deterministically named archived Box before restarting Pi", async () => {
    const commands: string[] = [];
    const writtenPaths: string[] = [];
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
      if (url.endsWith("/files") && init?.method === "PUT") {
        writtenPaths.push(String(body.path));
        return json({ ok: true });
      }
      if (url.endsWith("/commands") && init?.method === "POST") {
        commands.push(String(body.command));
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
      clientSurface: "mobile_web",
      providerAuth: {},
      replaceProviderAuth: false,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    expect(result.runtimeState).toBe("running");
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/resume") && init?.method === "POST")).toBe(true);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/boxes") && init?.method === "POST")).toBe(false);
    expect(writtenPaths).not.toContain(".companion/pi/auth.json");
    expect(commands.some((command) =>
      command.includes("pi-layout.version") && command.includes("pi-mcp-adapter@2.12.1"))).toBe(true);
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
      clientSurface: "web",
      providerAuth: {
        anthropic: { type: "api_key", key: "provider-secret" },
      },
      replaceProviderAuth: true,
      mcpCredentials: [
        { env_key: "GITHUB_TOKEN_WORK", value: "mcp-secret" },
      ],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    })).rejects.toThrow("command transport failed");

    expect(commands.some((command) =>
      command === "rm -f \"$HOME/.companion/runtime/state/providers.env\"")).toBe(true);
  });

  it("best-effort removes the provider file when skill preparation transport fails", async () => {
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
        if (command.includes("skills.next")) {
          return json({ code: "box_direct_failed", message: "prepare transport failed" }, 502);
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
      clientSurface: "web",
      providerAuth: {
        anthropic: { type: "api_key", key: "provider-secret" },
      },
      replaceProviderAuth: true,
      mcpCredentials: [
        { env_key: "GITHUB_TOKEN_WORK", value: "mcp-secret" },
      ],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    })).rejects.toThrow("prepare transport failed");

    expect(commands.some((command) =>
      command === "rm -f \"$HOME/.companion/runtime/state/providers.env\"")).toBe(true);
  });

  it("writes one JSONL prompt into the Pi FIFO without touching Box lifecycle", async () => {
    const commands: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/commands") && init?.method === "POST") {
        commands.push(String(body.command));
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await runtime.prompt({
      boxId: "bx_23456789",
      message: "Summarize the incident",
      requestId: "msg:1",
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("is-active --quiet companion-pi-daemon.service");
    expect(commands[0]).toContain("state/pi.rpc.in");
    expect(commands[0]).toContain(
      '{"id":"msg:1","type":"prompt","message":"Summarize the incident","streamingBehavior":"followUp"}',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses a prompt as a conflict when the Pi daemon is not running", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({ success: false, exitCode: 3, stdout: "", stderr: "inactive" })));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.prompt({
      boxId: "bx_23456789",
      message: "Anyone home?",
      requestId: "msg:2",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("reads the Pi event log from the requested offset and reports the offset it used", async () => {
    let command = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      command = String(body.command);
      // A rebuilt disk shrank the log, so the Box script restarted from the top.
      return json({ success: true, exitCode: 0, stdout: "0\n{\"type\":\"agent_settled\"}\n", stderr: "" });
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const result = await runtime.readEvents({ boxId: "bx_23456789", offset: 4_096 });

    expect(command).toContain("offset=4096");
    expect(command).toContain("logs/pi.rpc.ndjson");
    expect(result).toEqual({ chunk: "{\"type\":\"agent_settled\"}\n", offset: 0 });
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
      clientSurface: "web",
      providerAuth: {},
      replaceProviderAuth: true,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => {
        throw new Error("database unavailable");
      },
    })).rejects.toThrow("database unavailable");

    expect(stopped).toBe(true);
  });
});

