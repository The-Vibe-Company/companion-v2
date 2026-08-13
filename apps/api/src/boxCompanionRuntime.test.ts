import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANION_RUNTIME_ERROR_MAX_LENGTH } from "@companion/core";
import {
  AsciiBoxCompanionRuntime,
  BoxRuntimeConfigurationError,
} from "./boxCompanionRuntime";
import { companionRuntimeErrorMessage } from "./companionRuntimeError";

const box = {
  id: "bx_23456789",
  state: "ready",
  desktopAvailable: true,
  setupStatus: "done",
};
/** Printed by the adapter's staging command when Pi's auth file already exists on the Box disk. */
const AUTH_PRESENT_MARKER = "companion-provider-auth-present";
const PROVIDER_FILE_REMOVAL = "rm -f \"$HOME/.companion/runtime/state/providers.env\"";
/** The layout script is staged on disk and run as a file, so the command itself stays this short. */
const LAYOUT_SCRIPT_PATH = ".companion/bin/ensure-pi-layout.sh";
const LAYOUT_RUN_COMMAND = `bash "$HOME/${LAYOUT_SCRIPT_PATH}"`;

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
    expect(String(createBody?.setupScript)).toContain("exec \"$PI_BIN\" --mode rpc --session-dir");
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
    // A payload the file API accepts whole is written whole; only an oversized one is split.
    expect([...files.keys()].filter((path) => path.includes(".part"))).toEqual([]);
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

  it("stages a skill archive too large for one file write as parts a short command joins", async () => {
    // Production wake died writing a single ~12.7 MiB base64 body; this archive base64s to ~6.7 MiB,
    // which the file API refuses the same way.
    const archive = Buffer.alloc(5 * 1024 * 1024, "companion-skill-archive-payload");
    const encoded = archive.toString("base64");
    const archivePath = ".companion/runtime/state/skill-archives/incident-summary.tar.gz.b64";
    const writes: { path: string; content: string; encoding?: string }[] = [];
    const commands: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") {
        const content = String(body.content);
        // The provider rejects any body over its cap, so the adapter may never send one.
        if (Buffer.byteLength(content, "utf8") > 5_242_880) {
          return json({
            code: "file_too_large",
            message: `File is too large for write_file (${content.length} bytes > 5242880).`,
          }, 413);
        }
        writes.push({
          path: String(body.path),
          content,
          ...(body.encoding ? { encoding: String(body.encoding) } : {}),
        });
        return json({ ok: true });
      }
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        commands.push(command);
        return json({
          success: true,
          exitCode: 0,
          stdout: command.includes("is-active") ? "active\n" : "",
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
      skills: [{
        slug: "incident-summary",
        version: "1.2.3",
        checksum: `sha256:${"a".repeat(64)}`,
        archive,
      }],
      onBoxAssigned: async () => undefined,
    });

    // The skill is staged, never skipped or truncated, and no request approaches the provider's cap.
    const parts = writes.filter((write) => write.path.startsWith(`${archivePath}.part`));
    expect(parts.map((part) => part.path)).toEqual([
      `${archivePath}.part0`,
      `${archivePath}.part1`,
      `${archivePath}.part2`,
    ]);
    for (const write of writes) {
      expect(Buffer.byteLength(write.content, "utf8")).toBeLessThan(5_242_880);
    }
    expect(parts.every((part) => part.encoding === "base64")).toBe(true);
    // What the parts reassemble into is exactly the base64 the extract loop decodes.
    expect(Buffer.concat(parts.map((part) => Buffer.from(part.content, "base64"))).toString("utf8"))
      .toBe(encoded);
    expect(writes.some((write) => write.path === archivePath)).toBe(false);
    const join = commands.find((command) => command.includes(`${archivePath}.part0`));
    expect(join).toBe(
      `set -e; cd "$HOME"; cat '${archivePath}.part0' '${archivePath}.part1' `
      + `'${archivePath}.part2' > '${archivePath}'; `
      + `rm -f '${archivePath}.part0' '${archivePath}.part1' '${archivePath}.part2'`,
    );
    // The archive body may never travel as a command string, which is what mangles a large payload;
    // the join is one short line, like the staged layout script's.
    for (const command of commands) expect(command).not.toContain(encoded.slice(0, 128));
    expect(join!.length).toBeLessThan(600);
    // The joined file carries the name the existing extract loop globs, and the parts are gone
    // before it runs.
    const extract = commands.findIndex((command) => command.includes("skills.next"));
    expect(commands[extract]).toContain("*.tar.gz.b64");
    expect(commands.indexOf(join!)).toBeLessThan(extract);
    expect(result.runtimeState).toBe("running");
  });

  it("injects labeled MCP accounts alongside a 13 MiB chunked skill archive", async () => {
    // Production wakes a catalogue skill of this size, and THE-321's labeled MCP accounts are
    // written by the same #writeFile the archive chunking lives in: the small config files must
    // still land whole while the archive splits, and no secret may reach a command string.
    const archive = Buffer.alloc(13 * 1024 * 1024, "relecture-catalogue-payload");
    const encoded = archive.toString("base64");
    const archivePath = ".companion/runtime/state/skill-archives/relecture-catalogue.tar.gz.b64";
    const writes: { path: string; content: string; encoding?: string }[] = [];
    const commands: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") {
        const content = String(body.content);
        if (Buffer.byteLength(content, "utf8") > 5_242_880) {
          return json({
            code: "file_too_large",
            message: `File is too large for write_file (${content.length} bytes > 5242880).`,
          }, 413);
        }
        writes.push({
          path: String(body.path),
          content,
          ...(body.encoding ? { encoding: String(body.encoding) } : {}),
        });
        return json({ ok: true });
      }
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        commands.push(command);
        return json({
          success: true,
          exitCode: 0,
          stdout: command.includes("is-active") ? "active\n" : "",
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
      mcpCredentials: [
        { env_key: "LINEAR_TOKEN_WORK", value: "linear-work-secret" },
        { env_key: "LINEAR_TOKEN_PERSONAL", value: "linear-personal-secret" },
      ],
      mcpAccounts: [
        {
          id: "linear-work",
          label: "Linear work",
          transport: "http",
          url: "https://mcp.example.test/linear",
          headers: { Authorization: "LINEAR_TOKEN_WORK" },
          lifecycle: "lazy",
          direct_tools: false,
        },
        {
          id: "linear-personal",
          label: "Linear personal",
          transport: "http",
          url: "https://mcp.example.test/linear",
          headers: { Authorization: "LINEAR_TOKEN_PERSONAL" },
          lifecycle: "lazy",
          direct_tools: false,
        },
      ],
      skills: [{
        slug: "relecture-catalogue",
        version: "4.5.6",
        checksum: `sha256:${"b".repeat(64)}`,
        archive,
      }],
      onBoxAssigned: async () => undefined,
    });

    // A 13 MiB archive base64s past the cap several times over, so it splits into 3 MiB parts.
    const parts = writes.filter((write) => write.path.startsWith(`${archivePath}.part`));
    expect(parts.map((part) => part.path)).toEqual(
      Array.from({ length: 6 }, (_, index) => `${archivePath}.part${index}`),
    );
    expect(parts.every((part) => part.encoding === "base64")).toBe(true);
    for (const write of writes) {
      expect(Buffer.byteLength(write.content, "utf8")).toBeLessThan(5_242_880);
    }
    // The archive is delivered whole: reassembling the parts yields the exact base64 the extract
    // loop decodes, so nothing was truncated by the split.
    expect(Buffer.concat(parts.map((part) => Buffer.from(part.content, "base64"))).toString("utf8"))
      .toBe(encoded);
    const join = commands.find((command) => command.includes(`${archivePath}.part0`));
    expect(join).toContain(`cat '${archivePath}.part0'`);
    expect(join).toContain(`> '${archivePath}'`);
    expect(join!.length).toBeLessThan(1200);

    // MCP injection composes with the chunked write: both config files are small, so they land
    // whole in one PUT each rather than being split.
    const written = new Map(writes.map((write) => [write.path, write.content]));
    expect([...written.keys()].filter((path) => path.startsWith(".companion/pi/mcp.json.part")))
      .toEqual([]);
    const mcpConfig = written.get(".companion/pi/mcp.json") ?? "";
    expect(mcpConfig).toContain("${LINEAR_TOKEN_WORK}");
    expect(mcpConfig).toContain("${LINEAR_TOKEN_PERSONAL}");
    const accounts = written.get(".companion/runtime/state/mcp-accounts.json") ?? "";
    expect(accounts).toContain("Linear work");
    expect(accounts).toContain("Linear personal");

    // No secret and no archive body may travel as a command string.
    for (const command of commands) {
      expect(command).not.toContain("linear-work-secret");
      expect(command).not.toContain("linear-personal-secret");
      expect(command).not.toContain("provider-secret");
      expect(command).not.toContain(encoded.slice(0, 128));
    }
    expect(mcpConfig).not.toContain("linear-work-secret");
    expect(mcpConfig).not.toContain("linear-personal-secret");
    expect(result.runtimeState).toBe("running");
  });

  it("names the file the Box refused when a write exceeds the provider's cap", async () => {
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") {
        if (String(body.path).endsWith(".tar.gz.b64")) {
          return json({
            code: "file_too_large",
            message: "File is too large for write_file (13308656 bytes > 5242880).",
          }, 413);
        }
        return json({ ok: true });
      }
      if (url.endsWith("/commands") && method === "POST") {
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    // The provider names the limit but not the file, so a stored line that only repeats it cannot
    // say which payload overflowed.
    await expect(runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: true,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [{
        slug: "incident-summary",
        version: "1.2.3",
        checksum: `sha256:${"a".repeat(64)}`,
        archive: Buffer.from("archive"),
      }],
      onBoxAssigned: async () => undefined,
    })).rejects.toThrow(
      "Box rejected the write of .companion/runtime/state/skill-archives/incident-summary.tar.gz.b64:"
      + " File is too large for write_file (13308656 bytes > 5242880).",
    );
  });

  it("names the shell's own complaint when the Pi layout command fails", async () => {
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        if (String(body.command).includes(LAYOUT_SCRIPT_PATH)) {
          return json({
            success: false,
            exitCode: 127,
            stdout: "",
            stderr: "/home/user/.companion/bin/ensure-pi-layout.sh: line 21: pi: command not found\n",
          });
        }
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    // A bare "Pi runtime layout failed to install" cost a production probe to diagnose; the stored
    // line now carries the exit code and the last thing the shell said.
    await expect(runtime.start({
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
    })).rejects.toThrow(
      "Pi runtime layout failed to install (exit 127): "
      + "/home/user/.companion/bin/ensure-pi-layout.sh: line 21: pi: command not found",
    );
  });

  it("stages the layout script as a file and never sends the script body as a command", async () => {
    const commands: string[] = [];
    const files = new Map<string, string>();
    let createdSetupScript = "";
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.includes("/boxes?limit=200") && method === "GET") return json({ boxes: [] });
      if (url.endsWith("/boxes") && method === "POST") {
        createdSetupScript = String(body.setupScript);
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } }, 202);
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "PATCH") return json({ box });
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") {
        files.set(String(body.path), String(body.content));
        return json({ ok: true });
      }
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        commands.push(command);
        if (command === LAYOUT_RUN_COMMAND) expect(body.timeoutSeconds).toBe(180);
        return json({
          success: true,
          exitCode: 0,
          stdout: command.includes("is-active") ? "active\n" : "",
          stderr: "",
        });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_PI_INSTALL_COMMAND: "npm install --global @earendil-works/pi-coding-agent@1.2.3",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: null,
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: true,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    // The script the create path installs as a file is the same text the repair path stages, so a
    // Box can only ever be laid out by one script.
    expect(files.get(LAYOUT_SCRIPT_PATH)).toBe(createdSetupScript);
    expect(commands).toContain('mkdir -p "$HOME/.companion/bin"');
    expect(commands).toContain(LAYOUT_RUN_COMMAND);
    // The directory has to exist before the file API can land the script in it.
    expect(commands.indexOf('mkdir -p "$HOME/.companion/bin"'))
      .toBeLessThan(commands.indexOf(LAYOUT_RUN_COMMAND));
    // The create setupScript runs as a file with a shebang and succeeds; the identical text sent as
    // a command string does not survive the transport, so no command may carry the script body.
    for (const command of commands) {
      expect(command).not.toContain("COMPANION_PI_DAEMON");
      expect(command).not.toContain("COMPANION_PI_SERVICE");
      expect(command).not.toContain("expected_layout");
      expect(command).not.toContain("pi-layout.version");
      expect(command).not.toContain("<<");
    }
    // Both commands the repair does send are short, quote-light lines, unlike the staged script.
    for (const command of commands.filter((sent) => sent.includes(".companion/bin"))) {
      expect(command.length).toBeLessThan(100);
    }
    expect(createdSetupScript.length).toBeGreaterThan(2_500);
  });

  it("short-circuits an already-laid-out disk before it resolves pi", async () => {
    let createdSetupScript = "";
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.includes("/boxes?limit=200") && method === "GET") return json({ boxes: [] });
      if (url.endsWith("/boxes") && method === "POST") {
        createdSetupScript = String(body.setupScript);
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } }, 202);
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "PATCH") return json({ box });
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        return json({
          success: true,
          exitCode: 0,
          stdout: command.includes("is-active") ? "active\n" : "",
          stderr: "",
        });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_PI_INSTALL_COMMAND: "npm install --global @earendil-works/pi-coding-agent@1.2.3",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: null,
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: true,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    // Repairing a Box that is already correct must not depend on anything the layout already has.
    const markerIndex = createdSetupScript.indexOf("[ -f \"$layout_marker\" ]");
    const piResolveIndex = createdSetupScript.indexOf("command -v pi");
    expect(markerIndex).toBeGreaterThan(-1);
    expect(piResolveIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBeLessThan(piResolveIndex);
    // The supervised daemon gets a minimal PATH from the systemd user manager, so Pi is resolved at
    // layout time and pinned both in the wrapper and on the unit.
    expect(createdSetupScript).toContain("pi_bin=\"$(command -v pi)\"");
    expect(createdSetupScript).toContain("exec \"$PI_BIN\" --mode rpc");
    expect(createdSetupScript).toContain("Environment=PATH=");
  });

  it("keeps systemctl out of the create setupScript and loads the unit once the Box is ready", async () => {
    const commands: string[] = [];
    let createdSetupScript = "";
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.includes("/boxes?limit=200") && method === "GET") return json({ boxes: [] });
      if (url.endsWith("/boxes") && method === "POST") {
        createdSetupScript = String(body.setupScript);
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } }, 202);
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "PATCH") return json({ box });
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        commands.push(command);
        return json({
          success: true,
          exitCode: 0,
          stdout: command.includes("is-active") ? "active\n" : "",
          stderr: "",
        });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_PI_INSTALL_COMMAND: "npm install --global @earendil-works/pi-coding-agent@1.2.3",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: null,
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: true,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    // A Box has no user D-Bus session while it runs its create setupScript, so any systemctl call
    // there fails the whole setup even when Pi installed correctly.
    expect(createdSetupScript).not.toMatch(/systemctl/);
    expect(createdSetupScript).not.toMatch(/loginctl/);
    expect(createdSetupScript).toContain("/.config/systemd/user/companion-pi-daemon.service");
    expect(createdSetupScript).toContain("npm install --global @earendil-works/pi-coding-agent@1.2.3");
    const restart = commands.find((command) => command.includes("restart companion-pi-daemon.service"));
    expect(restart).toBeDefined();
    expect(restart).toContain("systemctl --user daemon-reload");
    expect(restart).toContain('companion_user_runtime_dir="/run/user/$(id -u)"');
    expect(restart).toContain('export XDG_RUNTIME_DIR="$companion_user_runtime_dir"');
    expect(restart).not.toContain("${XDG_RUNTIME_DIR:-");
    expect(restart).toContain('export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"');
    expect(restart).toContain("loginctl enable-linger");
    expect(restart).toContain("systemctl --user show-environment");
    expect(restart).toMatch(
      /for _ in \$\(seq 1 20\); do\n\s+companion_export_user_bus\n\s+if systemctl --user show-environment/,
    );
    expect(restart).toContain("trap 'rm -f \"$credential_file\"' EXIT");
    expect(restart!.indexOf("restart companion-pi-daemon.service"))
      .toBeLessThan(restart!.lastIndexOf('rm -f "$credential_file"'));
    expect(restart).toContain("trap - EXIT");
    // Every Box command runs in its own shell, so the status probe locates the bus again too.
    const userManagerCommands = commands.filter((command) => command.includes("systemctl --user"));
    expect(userManagerCommands.length).toBeGreaterThan(0);
    for (const command of userManagerCommands) {
      expect(command).toContain('export XDG_RUNTIME_DIR="$companion_user_runtime_dir"');
      expect(command).not.toContain("${XDG_RUNTIME_DIR:-");
    }
  });

  it("fails the daemon start with a distinct message when no user bus can be reached", async () => {
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        if (command.includes("restart companion-pi-daemon.service")) {
          return json({
            success: false,
            exitCode: 1,
            stdout: "",
            stderr: "Companion cannot reach the systemd user bus on this Box\n",
          });
        }
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
    });

    await expect(runtime.start({
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
    })).rejects.toThrow("Pi daemon failed to start");
  });

  it("waits for a restarted Pi daemon that is still activating instead of failing the wake", async () => {
    const probes: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        if (command.includes("is-active") && !command.includes("companion_label")) {
          probes.push(command);
          // systemd forks ExecStart and returns from `restart` before Type=simple is up, so the
          // first probes legitimately answer `activating`.
          return json({
            success: true,
            exitCode: 0,
            stdout: probes.length < 3 ? "activating\n" : "active\n",
            stderr: "",
          });
        }
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "5000",
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

    // The wake succeeds on the probe that observes `active`, and the Box is never replaced or
    // stopped on the way there.
    expect(probes.length).toBeGreaterThanOrEqual(3);
    expect(result).toMatchObject({ runtimeState: "running", daemonState: "running" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/stop"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/boxes") && init?.method === "POST")).toBe(false);
  });

  it("rides out the crash-restarts a failing Pi recovers from instead of latching their failure", async () => {
    // Replays a wake that reported the daemon down in production: Pi exited 1 twice and systemd's
    // own `Restart=on-failure` brought it up healthy on the third try, so the unit answers
    // `failed` between attempts. A wait that stopped at the first non-running answer would call
    // that recovered daemon dead.
    const journal = ["activating", "failed", "activating", "active"];
    const probes: string[] = [];
    const restarts: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        if (command.includes("systemctl --user restart")) restarts.push(command);
        if (command.includes("is-active") && !command.includes("companion_label")) {
          probes.push(command);
          return json({
            success: true,
            exitCode: 0,
            stdout: `${journal[Math.min(probes.length - 1, journal.length - 1)]}\n`,
            stderr: "",
          });
        }
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "5000",
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

    expect(result).toMatchObject({ runtimeState: "running", daemonState: "running" });
    // The wait has to outlast the `failed` answer rather than stop on it.
    expect(probes.length).toBe(journal.length);
    // Only the wake's own restart is issued: re-restarting on a later probe would knock the
    // recovered daemon back into the same crash window.
    expect(restarts).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/stop"))).toBe(false);
  });

  it("names the unit status and Pi's own stderr when the daemon never becomes active", async () => {
    const commands: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        commands.push(command);
        if (command.includes("companion_label")) {
          return json({
            success: true,
            exitCode: 0,
            // Verbatim shape of the labeled command's output, systemd's own indentation included.
            stdout: [
              "companion-pi-state failed",
              "companion-pi-status      Active: failed (Result: exit-code) since Thu 2026-08-13"
              + " 07:12:03 UTC; 1s ago",
              "companion-pi-status     Process: 4242 ExecStart=/home/user/.companion/bin/pi-daemon"
              + " (code=exited, status=1/FAILURE)",
              "companion-pi-stderr pi: error: unknown option '--skill'",
              "",
            ].join("\n"),
            stderr: "",
          });
        }
        if (command.includes("is-active")) {
          // A crash-looping unit answers `activating` between restarts and never settles.
          return json({ success: true, exitCode: 0, stdout: "activating\n", stderr: "" });
        }
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "20",
    });

    const error = await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: true,
      mcpCredentials: [{ env_key: "GITHUB_TOKEN_WORK", value: "mcp-secret" }],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    }).then(
      (): never => {
        throw new Error("start returned running for a daemon that never became active");
      },
      (thrown: unknown) => thrown as Error,
    );

    // The bare sentence cost a production probe to diagnose: the stored line has to say what the
    // unit reported and what Pi complained about.
    expect(error.message).toContain("Pi daemon is not running after start");
    expect(error.message).toContain("is-active: failed");
    expect(error.message).toContain("Active: failed (Result: exit-code)");
    expect(error.message).toContain("pi.stderr.log: pi: error: unknown option '--skill'");
    // The control plane keeps only the first sanitized line of bounded length, so the detail has to
    // survive that unchanged rather than be truncated away or redacted as credential-shaped text.
    expect(error.message.split("\n")).toHaveLength(1);
    expect(companionRuntimeErrorMessage(error)).toBe(error.message);
    // Diagnosing the failure may not read the credential files or archive the Box.
    const diagnostic = commands.find((command) => command.includes("companion_label")) ?? "";
    expect(diagnostic).toContain("logs/pi.stderr.log");
    // The log outlives the start that wrote it, so it is only read when this start wrote it:
    // reporting an untouched log would attribute an earlier run's line to this failure.
    expect(diagnostic).toContain("-mmin -2");
    expect(diagnostic).not.toContain("providers.env");
    expect(diagnostic).not.toContain("auth.json");
    for (const command of commands) expect(command).not.toContain("mcp-secret");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/stop"))).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/boxes") && init?.method === "POST")).toBe(false);
  });

  it("reports the exit status systemd recorded when Pi died without writing to its stderr log", async () => {
    // The production shape: Pi exited 1 twice and left a 0-byte stderr log, so the labeled tail
    // prints nothing and the only account of the failure is systemd's own.
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        if (command.includes("companion_label")) {
          return json({
            success: true,
            exitCode: 0,
            stdout: [
              "companion-pi-state activating",
              "companion-pi-status      Active: activating (auto-restart) (Result: exit-code) since"
              + " Thu 2026-08-13 07:34:59 UTC; 1s ago",
              "companion-pi-status     Process: 4242 ExecStart=/home/user/.companion/bin/pi-daemon"
              + " (code=exited, status=1/FAILURE)",
              "",
            ].join("\n"),
            stderr: "",
          });
        }
        if (command.includes("is-active")) {
          return json({ success: true, exitCode: 0, stdout: "activating\n", stderr: "" });
        }
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "20",
    });

    const error = await runtime.start({
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
    }).then(
      (): never => {
        throw new Error("start returned running for a daemon that never became active");
      },
      (thrown: unknown) => thrown as Error,
    );

    // An empty log costs the wake nothing: the fragment is left out rather than reported blank,
    // and the exit status spends the room it would have taken.
    expect(error.message).not.toContain("pi.stderr.log");
    expect(error.message).toContain("Active: activating (auto-restart) (Result: exit-code)");
    // The exit code, not the ExecStart path the line opens with.
    expect(error.message).toContain("exit: code=exited, status=1/FAILURE");
    expect(error.message).not.toContain("ExecStart");
    expect(error.message.split("\n")).toHaveLength(1);
    expect(companionRuntimeErrorMessage(error)).toBe(error.message);
  });

  it("keeps every daemon failure fragment inside the line the Companion row stores", async () => {
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        if (command.includes("companion_label")) {
          // A unit whose every line runs long: systemd status lines carry timestamps and full
          // ExecStart paths, and a Pi stack line is longer still.
          return json({
            success: true,
            exitCode: 0,
            stdout: [
              `companion-pi-state ${"deactivating-and-then-some".repeat(4)}`,
              `companion-pi-status Active: ${"failed (Result: exit-code) since ".repeat(6)}`,
              `companion-pi-status Process: 4242 ExecStart=${"/very/long/path".repeat(6)}`
              + " (code=exited, status=1/FAILURE)",
              `companion-pi-stderr pi: error: ${"could not open the session directory ".repeat(6)}`,
              "",
            ].join("\n"),
            stderr: "",
          });
        }
        if (command.includes("is-active")) {
          return json({ success: true, exitCode: 0, stdout: "activating\n", stderr: "" });
        }
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "20",
    });

    const error = await runtime.start({
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
    }).then(
      (): never => {
        throw new Error("start returned running for a daemon that never became active");
      },
      (thrown: unknown) => thrown as Error,
    );

    // The fragments share one stored line, so a long status must not cost the stderr line: the
    // sanitizer has to pass the whole message through rather than truncate its tail away.
    expect(companionRuntimeErrorMessage(error)).toBe(error.message);
    expect(error.message.length).toBeLessThanOrEqual(COMPANION_RUNTIME_ERROR_MAX_LENGTH);
    expect(error.message).toContain("is-active: deactivating");
    expect(error.message).toContain("Active: failed (Result: exit-code)");
    // systemd's account is the only one that always exists, so it survives the squeeze whole and
    // Pi's log — supplementary, and absent for the failures that motivated this — is what clamps.
    expect(error.message).toContain("exit: code=exited, status=1/FAILURE");
    expect(error.message).toContain("pi.stderr.log: pi: error: could not open");
    expect(error.message.indexOf("exit:")).toBeLessThan(error.message.indexOf("pi.stderr.log:"));
  });

  it("reads each systemd status line by what it says rather than where it landed", async () => {
    // Only the process line comes back. Reading the status lines positionally would report that
    // line as the unit's verdict, putting an ExecStart path where `Active:` belongs.
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        if (command.includes("companion_label")) {
          return json({
            success: true,
            exitCode: 0,
            stdout: "companion-pi-state failed\n"
              + "companion-pi-status     Process: 4242"
              + " ExecStart=/home/user/.companion/bin/pi-daemon (code=exited, status=203/EXEC)\n",
            stderr: "",
          });
        }
        if (command.includes("is-active")) {
          return json({ success: true, exitCode: 0, stdout: "failed\n", stderr: "" });
        }
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "20",
    });

    const error = await runtime.start({
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
    }).then(
      (): never => {
        throw new Error("start returned running for a daemon that never became active");
      },
      (thrown: unknown) => thrown as Error,
    );

    expect(error.message).toContain("is-active: failed");
    expect(error.message).toContain("exit: code=exited, status=203/EXEC");
    expect(error.message).not.toContain("ExecStart");
  });

  it("stays inside the stored line for any mix of fragments the Box reports", async () => {
    // The fragments are clamped against a shared allowance, so the arithmetic has to hold for
    // every combination of present, absent, short, and overlong lines rather than the few shapes
    // production has shown so far. A message over the limit loses its tail to the sanitizer.
    // Prose-shaped filler: an unbroken run of 40+ word characters is credential-shaped and would
    // be redacted, which is a different behavior than the length arithmetic under test here.
    const filler = (size: number): string => "chars ".repeat(size).slice(0, size).trim();
    const sizes = [0, 1, 40, 400];
    for (const stateSize of sizes) {
      for (const activeSize of sizes) {
        for (const stderrSize of sizes) {
          for (const exitSize of sizes) {
            const stdout = [
              stateSize ? `companion-pi-state ${filler(stateSize)}` : "",
              activeSize ? `companion-pi-status Active: ${filler(activeSize)}` : "",
              exitSize
                ? `companion-pi-status Process: 42 ExecStart=/x (code=${filler(exitSize)})`
                : "",
              stderrSize ? `companion-pi-stderr ${filler(stderrSize)}` : "",
            ].filter(Boolean).join("\n");
            const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
              const url = String(rawUrl);
              const method = init?.method ?? "GET";
              const body = init?.body
                ? JSON.parse(String(init.body)) as Record<string, unknown>
                : {};
              if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
              if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
              if (url.endsWith("/commands") && method === "POST") {
                const command = String(body.command);
                if (command.includes("companion_label")) {
                  return json({ success: true, exitCode: 0, stdout, stderr: "" });
                }
                if (command.includes("is-active")) {
                  return json({ success: true, exitCode: 0, stdout: "activating\n", stderr: "" });
                }
                return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
              }
              throw new Error(`unexpected Box request: ${method} ${url}`);
            });
            vi.stubGlobal("fetch", fetchMock);
            const runtime = new AsciiBoxCompanionRuntime({
              COMPANION_BOX_API_KEY: "box_test",
              COMPANION_BOX_POLL_INTERVAL_MS: "1",
              COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "1",
            });

            const error = await runtime.start({
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
            }).then(
              (): never => {
                throw new Error("start returned running for a daemon that never became active");
              },
              (thrown: unknown) => thrown as Error,
            );

            expect(error.message.length).toBeLessThanOrEqual(COMPANION_RUNTIME_ERROR_MAX_LENGTH);
            // Nothing the Box printed may survive as a second line or be dropped by the sanitizer.
            expect(companionRuntimeErrorMessage(error)).toBe(error.message);
          }
        }
      }
    }
  });

  it("keeps the generic daemon failure when the Box cannot answer the diagnostic", async () => {
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        if (command.includes("companion_label")) {
          return json({ code: "box_direct_failed", message: "command transport failed" }, 502);
        }
        if (command.includes("is-active")) {
          return json({ success: true, exitCode: 0, stdout: "inactive\n", stderr: "" });
        }
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "20",
    });

    // A Box that will not run the diagnostic still has to fail the wake with its own reason rather
    // than replacing it with the transport error.
    await expect(runtime.start({
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
    })).rejects.toThrow("Pi daemon is not running after start");
  });

  it("never starts a Box or a daemon from the status and desktop paths", async () => {
    const commands: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/commands") && method === "POST") {
        commands.push(String(body.command));
        // The daemon is down, which a read-only path reports rather than repairs.
        return json({ success: true, exitCode: 0, stdout: "inactive\n", stderr: "" });
      }
      if (url.includes("/desktop") && method === "POST") {
        return json({ desktopUrl: "https://desktop.example.test/session", provisioning: false });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_BOX_POLL_INTERVAL_MS: "1",
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "5000",
    });

    const status = await runtime.status({ boxId: "bx_23456789" });
    const desktop = await runtime.desktop({ boxId: "bx_23456789" });

    expect(status).toMatchObject({ runtimeState: "stopped", daemonState: "stopped" });
    expect(desktop).toEqual({ url: "https://desktop.example.test/session", provisioning: false });
    // The wake poll belongs to start alone: status reads the daemon once and neither path restarts
    // the unit, creates a Box, or resumes one.
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("is-active");
    expect(commands[0]).not.toContain("restart companion-pi-daemon.service");
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/boxes") && init?.method === "POST")).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/resume"))).toBe(false);
  });

  it("recovers a deterministically named archived Box before restarting Pi", async () => {
    const commands: string[] = [];
    const writtenPaths: string[] = [];
    const writtenFiles = new Map<string, string>();
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
        writtenFiles.set(String(body.path), String(body.content));
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
    // The resumed disk is repaired against the current adapter version, from the staged file.
    expect(writtenFiles.get(LAYOUT_SCRIPT_PATH)).toContain("pi-layout.version");
    expect(writtenFiles.get(LAYOUT_SCRIPT_PATH)).toContain("pi-mcp-adapter@2.12.1");
    expect(commands).toContain(LAYOUT_RUN_COMMAND);
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
    expect(created[0]).toContain("exec \"$PI_BIN\" --mode rpc --session-dir");
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

  it("archives a Box whose Pi unit was never loaded instead of failing the stop", async () => {
    let stopCommand = "";
    let archived = false;
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/commands") && method === "POST") {
        stopCommand = String(body.command);
        // The Box never started Pi, so the shell guard exits 0 without stopping anything.
        return json({ success: true, exitCode: 0, stdout: "", stderr: "" });
      }
      if (url.endsWith("/boxes/bx_23456789/stop") && method === "POST") {
        archived = true;
        return json({ box: { ...box, state: "archiving" } }, 202);
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const result = await runtime.stop({ boxId: "bx_23456789" });

    expect(stopCommand).toContain("systemctl --user show-environment");
    expect(stopCommand).toContain('companion_user_runtime_dir="/run/user/$(id -u)"');
    expect(stopCommand).toContain('export XDG_RUNTIME_DIR="$companion_user_runtime_dir"');
    expect(stopCommand).not.toContain("${XDG_RUNTIME_DIR:-");
    expect(stopCommand).toContain("systemctl --user stop companion-pi-daemon.service >/dev/null 2>&1 || true");
    expect(stopCommand).toContain("is-active --quiet companion-pi-daemon.service");
    expect(archived).toBe(true);
    expect(result).toMatchObject({ runtimeState: "stopping", daemonState: "stopped" });
  });

  it("refuses to archive a Box whose Pi daemon is still active after the stop", async () => {
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/commands") && method === "POST") {
        return json({
          success: false,
          exitCode: 1,
          stdout: "",
          stderr: "Pi daemon is still active after stop\n",
        });
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.stop({ boxId: "bx_23456789" })).rejects.toThrow("Pi daemon failed to stop");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/bx_23456789/stop"))).toBe(false);
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
      command === PROVIDER_FILE_REMOVAL)).toBe(true);
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
      command === PROVIDER_FILE_REMOVAL)).toBe(true);
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
    expect(commands[0]).toContain('companion_user_runtime_dir="/run/user/$(id -u)"');
    expect(commands[0]).toContain('export XDG_RUNTIME_DIR="$companion_user_runtime_dir"');
    expect(commands[0]).not.toContain("${XDG_RUNTIME_DIR:-");
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

