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
/** Printed by the adapter's staging command when Pi's auth file already exists on the Box disk. */
const AUTH_PRESENT_MARKER = "companion-provider-auth-present";

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
        const command = String(body.command);
        commands.push(command);
        return json({
          success: true,
          exitCode: 0,
          // The resumed disk still carries the Pi auth file Companion wrote before it was archived.
          stdout: command.includes("is-active")
            ? "active\n"
            : command.includes(AUTH_PRESENT_MARKER) ? `${AUTH_PRESENT_MARKER}\n` : "",
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

  it("replaces the assigned Box when its Pi setup failed and rewrites provider auth", async () => {
    const failed = {
      id: "bx_pdddbvx9",
      name: "Companion 11111111-1111-4111-8111-111111111111",
      state: "idle",
      desktopAvailable: false,
      setupStatus: "failed",
      setupError: "pi: command not found",
    };
    const files = new Map<string, string>();
    const assigned: string[] = [];
    let retiredName: unknown;
    let retiredStop: Record<string, unknown> | undefined;
    let createdName: unknown;
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_pdddbvx9") && method === "GET") return json({ box: failed });
      if (url.endsWith("/boxes/bx_pdddbvx9") && method === "PATCH") {
        retiredName = body.name;
        return json({ box: { ...failed, name: String(body.name) } });
      }
      if (url.endsWith("/boxes/bx_pdddbvx9/stop") && method === "POST") {
        retiredStop = body;
        return json({ box: { ...failed, state: "archiving" } }, 202);
      }
      if (url.endsWith("/boxes") && method === "POST") {
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } }, 202);
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "PATCH") {
        createdName = body.name;
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } });
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") {
        files.set(String(body.path), String(body.content));
        return json({ ok: true });
      }
      if (url.endsWith("/boxes/bx_23456789/commands") && method === "POST") {
        return json({
          success: true,
          exitCode: 0,
          stdout: String(body.command).includes("is-active") ? "active\n" : "",
          stderr: "",
        });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    const result = await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_pdddbvx9",
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      // The control plane recorded the failed Box at the current layout and generation, so the
      // replacement disk still has to receive Pi's auth file.
      replaceProviderAuth: false,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async (boxId) => {
        assigned.push(boxId);
      },
    });

    expect(String(retiredName)).toMatch(
      /^Retired Companion 11111111-1111-4111-8111-111111111111 \d+$/,
    );
    expect(retiredStop).toEqual({ force: true });
    expect(createdName).toBe("Companion 11111111-1111-4111-8111-111111111111");
    expect(assigned).toEqual(["bx_23456789"]);
    expect(files.get(".companion/pi/auth.json"))
      .toBe("{\"anthropic\":{\"type\":\"api_key\",\"key\":\"provider-secret\"}}\n");
    // The replacement Box owns the deterministic name, and no name lookup could re-adopt the
    // retired disk even if the provider refused to rename it.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/boxes?limit=200")))
      .toBe(false);
    expect(result).toEqual({
      boxId: "bx_23456789",
      runtimeState: "running",
      daemonState: "running",
      desktopAvailable: true,
    });
  });

  it("writes Pi auth onto a disk that has none even when the caller skipped the rewrite", async () => {
    const writtenPaths: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") {
        writtenPaths.push(String(body.path));
        return json({ ok: true });
      }
      if (url.endsWith("/commands") && method === "POST") {
        // The staging command reports no auth file, as on a replacement disk an earlier start
        // provisioned but never finished configuring.
        return json({
          success: true,
          exitCode: 0,
          stdout: String(body.command).includes("is-active") ? "active\n" : "",
          stderr: "",
        });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    const result = await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      // The control plane recorded this Box at the current layout and generation.
      replaceProviderAuth: false,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    expect(writtenPaths).toContain(".companion/pi/auth.json");
    expect(result.runtimeState).toBe("running");
  });

  it("replaces a Box whose Pi setup failed even when the provider refuses the rename", async () => {
    const failed = {
      ...box,
      id: "bx_pdddbvx9",
      name: "Companion 11111111-1111-4111-8111-111111111111",
      state: "idle",
      setupStatus: "failed",
    };
    let stopped = false;
    let createdBox = false;
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_pdddbvx9") && method === "GET") return json({ box: failed });
      if (url.endsWith("/boxes/bx_pdddbvx9") && method === "PATCH") {
        return json({ code: "box_immutable", message: "name cannot be changed" }, 409);
      }
      if (url.endsWith("/boxes/bx_pdddbvx9/stop") && method === "POST") {
        stopped = true;
        return json({ box: { ...failed, state: "archiving" } }, 202);
      }
      if (url.endsWith("/boxes") && method === "POST") {
        createdBox = true;
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } }, 202);
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "PATCH") return json({ box });
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/boxes/bx_23456789/commands") && method === "POST") {
        return json({
          success: true,
          exitCode: 0,
          stdout: String(body.command).includes("is-active") ? "active\n" : "",
          stderr: "",
        });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    const result = await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_pdddbvx9",
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: true,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    expect(stopped).toBe(true);
    expect(createdBox).toBe(true);
    expect(result.boxId).toBe("bx_23456789");
  });

  it("retires an archived Box whose Pi setup failed instead of resuming it", async () => {
    let renamed = "";
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_asleepbad") && method === "GET") {
        return json({
          box: {
            ...box,
            id: "bx_asleepbad",
            name: "Companion 11111111-1111-4111-8111-111111111111",
            state: "archived",
            setupStatus: "failed",
          },
        });
      }
      if (url.endsWith("/boxes/bx_asleepbad") && method === "PATCH") {
        renamed = String(body.name);
        return json({ box: { ...box, id: "bx_asleepbad", state: "archived" } });
      }
      if (url.endsWith("/boxes") && method === "POST") {
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } }, 202);
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "PATCH") return json({ box });
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/boxes/bx_23456789/commands") && method === "POST") {
        return json({
          success: true,
          exitCode: 0,
          stdout: String(body.command).includes("is-active") ? "active\n" : "",
          stderr: "",
        });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    const result = await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_asleepbad",
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: true,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    expect(renamed).toMatch(/^Retired Companion 11111111-1111-4111-8111-111111111111 \d+$/);
    // An archived Box is already stopped, and its broken disk must never be resumed.
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/resume"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/bx_asleepbad/stop")))
      .toBe(false);
    expect(result.boxId).toBe("bx_23456789");
  });

  it("replaces the assigned Box when it entered the terminal error state", async () => {
    const created: string[] = [];
    const retired: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_broken00") && method === "GET") {
        return json({ box: { ...box, id: "bx_broken00", state: "error" } });
      }
      if (url.endsWith("/boxes/bx_broken00") && method === "PATCH") {
        retired.push(String(body.name));
        return json({ box: { ...box, id: "bx_broken00", state: "error" } });
      }
      if (url.endsWith("/boxes/bx_broken00/stop") && method === "POST") {
        return json({ box: { ...box, id: "bx_broken00", state: "archiving" } }, 202);
      }
      if (url.endsWith("/boxes") && method === "POST") {
        created.push(String(body.setupScript));
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } }, 202);
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "PATCH") return json({ box });
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/boxes/bx_23456789/commands") && method === "POST") {
        return json({
          success: true,
          exitCode: 0,
          stdout: String(body.command).includes("is-active") ? "active\n" : "",
          stderr: "",
        });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    const result = await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_broken00",
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: true,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    expect(retired).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toContain("pi --mode rpc --session-dir");
    expect(String(created[0])).not.toContain("bx_broken00");
    expect(result.boxId).toBe("bx_23456789");
    expect(result.runtimeState).toBe("running");
  });

  it("replaces an assigned Box the provider no longer knows about", async () => {
    let listed = 0;
    let createdBox = false;
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_deleted0") && method === "GET") {
        return json({ code: "not_found", message: "box not found" }, 404);
      }
      if (url.includes("/boxes?limit=200") && method === "GET") {
        listed += 1;
        return json({ boxes: [] });
      }
      if (url.endsWith("/boxes") && method === "POST") {
        createdBox = true;
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } }, 202);
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "PATCH") return json({ box });
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/boxes/bx_23456789/commands") && method === "POST") {
        return json({
          success: true,
          exitCode: 0,
          stdout: String(body.command).includes("is-active") ? "active\n" : "",
          stderr: "",
        });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    const result = await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_deleted0",
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: true,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    expect(listed).toBe(1);
    expect(createdBox).toBe(true);
    expect(result.boxId).toBe("bx_23456789");
  });

  it("keeps a Box whose Pi setup is still running instead of replacing it", async () => {
    let reads = 0;
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        reads += 1;
        if (reads < 3) {
          return json({ box: { ...box, state: "provisioning", setupStatus: "running" } });
        }
        return json({ box });
      }
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        return json({
          success: true,
          exitCode: 0,
          stdout: String(body.command).includes("is-active") ? "active\n" : "",
          stderr: "",
        });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    const result = await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: true,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    expect(result.boxId).toBe("bx_23456789");
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/boxes") && init?.method === "POST")).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/stop"))).toBe(false);
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

