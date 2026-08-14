import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANION_RUNTIME_ERROR_MAX_LENGTH } from "@companion/core";
import {
  AsciiBoxCompanionRuntime,
  BoxRuntimeConfigurationError,
  BoxRuntimeProviderError,
  COMPANION_PI_EVENT_READ_LIMIT,
  composeDaemonFailureDetail,
  PI_DAEMON_FAILURE_MESSAGE,
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
const RUNTIME_PROVIDER_FILE = '"/run/user/$(id -u)/companion/providers.env"';
/** The layout script is staged on disk and run as a file, so the command itself stays this short. */
const LAYOUT_SCRIPT_PATH = ".companion/bin/ensure-pi-layout.sh";
const LAYOUT_RUN_COMMAND = `bash "$HOME/${LAYOUT_SCRIPT_PATH}"`;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

/**
 * Run one Box command the way a Box runs it — bash, with the Box's HOME — and answer in the
 * provider's envelope. The Pi event read is a shell script whose failure modes are shell failure
 * modes, so the reads below execute the script the adapter sends rather than assert on its text.
 */
function runOnBoxDisk(command: string, home: string, pathPrefix?: string): Promise<{
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const path = process.env.PATH ?? "/usr/bin:/bin";
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", command],
      {
        env: { HOME: home, PATH: pathPrefix ? `${pathPrefix}:${path}` : path },
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        const exitCode = typeof code === "number" ? code : error ? 1 : 0;
        resolve({ success: exitCode === 0, exitCode, stdout, stderr });
      },
    );
  });
}

/** A throwaway Box HOME holding the log the Pi daemon writes, or no log at all for `null`. */
async function boxDiskWithPiLog(contents: string | null): Promise<{ home: string; log: string }> {
  const home = await mkdtemp(join(tmpdir(), "companion-pi-log-"));
  const logs = join(home, ".companion", "runtime", "logs");
  await mkdir(logs, { recursive: true });
  const log = join(logs, "pi.rpc.ndjson");
  if (contents !== null) await writeFile(log, contents);
  return { home, log };
}

/** Read events against one of those disks, reporting the status the script exited with. */
async function readEventsOnBoxDisk(input: {
  home: string;
  offset: number;
  pathPrefix?: string;
}): Promise<{ chunk: string; offset: number; exitCode: number }> {
  let exitCode = -1;
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const executed = await runOnBoxDisk(String(body.command), input.home, input.pathPrefix);
    exitCode = executed.exitCode;
    return json(executed);
  }));
  const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });
  const chunk = await runtime.readEvents({ boxId: "bx_23456789", offset: input.offset });
  return { ...chunk, exitCode };
}

/**
 * The layout script the adapter stages on a Box, captured from one wake. It is the same text the
 * create `setupScript` carries, and running it is the only way to get the daemon wrapper it writes.
 */
async function stagedPiLayoutScript(): Promise<string> {
  let script = "";
  vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = String(rawUrl);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
    if (url.endsWith("/files") && method === "PUT") {
      if (String(body.path) === LAYOUT_SCRIPT_PATH) script = String(body.content);
      return json({ ok: true });
    }
    if (url.endsWith("/commands") && method === "POST") {
      return json({
        success: true,
        exitCode: 0,
        stdout: String(body.command).includes("is-active") ? "active\n" : "",
        stderr: "",
      });
    }
    throw new Error(`unexpected Box request: ${method} ${url}`);
  }));
  const runtime = new AsciiBoxCompanionRuntime({
    COMPANION_BOX_API_KEY: "box_test",
    COMPANION_PI_INSTALL_COMMAND: "printf 'pi is preinstalled\\n'",
    COMPANION_BOX_POLL_INTERVAL_MS: "1",
  });
  await runtime.start({
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
  vi.unstubAllGlobals();
  return script;
}

/**
 * A throwaway Box HOME whose Pi layout the staged script installed for real, so the daemon wrapper
 * under test is the one a Box runs rather than a copy of it. Pi is a stub that records the argv it
 * was handed, because what the wrapper does before and instead of reaching Pi is the behavior here.
 */
async function boxDiskWithPiDaemon(): Promise<{
  home: string;
  daemon: string;
  stderrLog: string;
  argv: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "companion-pi-daemon-"));
  const bin = await mkdtemp(join(tmpdir(), "companion-pi-bin-"));
  const argv = join(home, "pi-argv.log");
  await writeFile(
    join(bin, "pi"),
    "#!/bin/sh\n"
    + `printf '%s\\n' "$*" >> ${JSON.stringify(argv)}\n`
    + "exit 0\n",
  );
  await chmod(join(bin, "pi"), 0o755);
  const script = join(home, LAYOUT_SCRIPT_PATH);
  await mkdir(join(home, ".companion", "bin"), { recursive: true });
  await writeFile(script, await stagedPiLayoutScript());
  const installed = await runOnBoxDisk(`bash ${JSON.stringify(script)}`, home, bin);
  expect(installed.exitCode).toBe(0);
  return {
    home,
    daemon: join(home, ".companion", "bin", "pi-daemon"),
    stderrLog: join(home, ".companion", "runtime", "logs", "pi.stderr.log"),
    argv,
  };
}

/** The line the failure diagnostic would report from this disk's Pi stderr log. */
async function reportedStderrLine(stderrLog: string): Promise<string> {
  const lines = (await readFile(stderrLog, "utf8"))
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

/** A directory holding one command that fails, shadowing the Box's own copy for this read. */
async function binWithFailingCommand(name: string, exitCode: number, message: string): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "companion-pi-bin-"));
  const script = join(bin, name);
  await writeFile(script, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(message)} >&2\nexit ${exitCode}\n`);
  await chmod(script, 0o755);
  return bin;
}

/**
 * A reader that writes one line of what it was handed and then fails the way a reader whose stdout
 * stopped accepting bytes does: some of the read landed, and the status still says it went wrong.
 */
async function binWithCappedCommand(name: string, exitCode: number): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "companion-pi-bin-"));
  const script = join(bin, name);
  await writeFile(
    script,
    `#!/bin/sh\nIFS= read -r line\nprintf '%s\\n' "$line"\n`
    + `printf '%s\\n' ${JSON.stringify(`${name}: error writing 'standard output': Broken pipe`)} >&2\n`
    + `exit ${exitCode}\n`,
  );
  await chmod(script, 0o755);
  return bin;
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

  it("returns an already active current-layout daemon without injecting or starting it again", async () => {
    const commands: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        commands.push(command);
        return json({
          success: true,
          exitCode: 0,
          stdout: command.includes("companion-pi-warm-ready")
            ? "companion-pi-warm-ready\n"
            : "",
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
      // The route sends false only when this Box records the current layout and provider generation.
      replaceProviderAuth: false,
      mcpCredentials: [{ env_key: "GITHUB_TOKEN_WORK", value: "new-secret-not-injected" }],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    expect(result).toMatchObject({ runtimeState: "running", daemonState: "running" });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("is-active --quiet companion-pi-daemon.service");
    expect(commands[0]).toContain('[ -f "$XDG_RUNTIME_DIR/companion/providers.env" ]');
    expect(commands[0]).not.toContain("systemctl --user start companion-pi-daemon.service");
    expect(commands[0]).not.toContain("systemctl --user restart companion-pi-daemon.service");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/files"))).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) =>
      String(JSON.parse(String(init?.body ?? "{}")).command ?? "").includes("skills.next"))).toBe(false);
  });

  it("does not take the warm fast path when layout or provider auth needs replacement", async () => {
    const commands: string[] = [];
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

    await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "rotated-provider-secret" } },
      replaceProviderAuth: true,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    expect(commands.some((command) => command.includes("companion-pi-warm-ready"))).toBe(false);
    expect(commands.some((command) =>
      command.includes("systemctl --user start companion-pi-daemon.service"))).toBe(true);
    expect(commands.every((command) =>
      !command.includes("systemctl --user restart companion-pi-daemon.service"))).toBe(true);
    expect(writtenPaths).toContain(".companion/pi/auth.json");
    expect(writtenPaths).toContain(".companion/runtime/state/providers.env");
  });

  /**
   * THE-340: production wakes claimed `provisioning` against Boxes that sat at `idle` and never
   * moved. `idle` is a state a Box normally runs commands from, so a start that finds one has to
   * discover from the Box itself whether this one does, and resume it when it does not.
   */
  describe("a Box whose state reads ready but will not run commands", () => {
    /**
     * One idle Box that refuses every command until it is resumed, and — when `resumable` is false —
     * refuses them afterwards too. The refusal is either the provider's own envelope saying the
     * command did not run or an error from the command endpoint itself; a parked machine can produce
     * either, and neither may be read as a wake in progress.
     */
    function idleBoxRefusingCommands(input: {
      resumable: boolean;
      refusal: "envelope" | "transport";
    }) {
      const commands: string[] = [];
      let resumed = false;
      const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
        const url = String(rawUrl);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
          return json({ box: { ...box, state: resumed ? "ready" : "idle" } });
        }
        if (url.endsWith("/resume") && method === "POST") {
          resumed = input.resumable;
          return json({ box: { ...box, state: resumed ? "ready" : "idle" } }, 202);
        }
        if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
        if (url.endsWith("/commands") && method === "POST") {
          const command = String(body.command);
          commands.push(command);
          if (!resumed) {
            // What a parked Box answers with: either an envelope reporting the command never ran, or
            // no answer at all from the provider's own command endpoint.
            return input.refusal === "envelope"
              ? json({
                success: false,
                exitCode: 255,
                stdout: "",
                stderr: "box is not running",
              })
              : json({ code: "box_not_running", message: "Box is not running" }, 409);
          }
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
      return { commands, fetchMock };
    }

    const startInput = {
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web" as const,
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: true,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    };

    it.each([
      ["reports the command never ran", "envelope" as const],
      ["will not answer the command endpoint", "transport" as const],
    ])("resumes an idle Box that %s and starts Pi on it", async (_case, refusal) => {
      const { commands, fetchMock } = idleBoxRefusingCommands({ resumable: true, refusal });
      const runtime = new AsciiBoxCompanionRuntime({
        COMPANION_BOX_API_KEY: "box_test",
        COMPANION_BOX_POLL_INTERVAL_MS: "1",
      });

      const result = await runtime.start(startInput);

      expect(result).toMatchObject({ runtimeState: "running", daemonState: "running" });
      expect(fetchMock.mock.calls.some(([url, init]) =>
        String(url).endsWith("/boxes/bx_23456789/resume") && init?.method === "POST")).toBe(true);
      // The wake it was resumed for then ran, rather than the resume being its own reported outcome.
      expect(commands.some((command) =>
        command.includes("systemctl --user start companion-pi-daemon.service"))).toBe(true);
    });

    it("fails the start with what an unresumable idle Box said instead of reporting provisioning", async () => {
      idleBoxRefusingCommands({ resumable: false, refusal: "envelope" });
      const runtime = new AsciiBoxCompanionRuntime({
        COMPANION_BOX_API_KEY: "box_test",
        COMPANION_BOX_POLL_INTERVAL_MS: "1",
      });

      // A Box that will not run this start's first command even after a resume is a failed wake with
      // a reason on it, which is what the Companion row records and what the sender is shown.
      await expect(runtime.start(startInput)).rejects.toMatchObject({
        status: 502,
        message: expect.stringContaining("did not run this start's first command"),
      });
      await expect(runtime.start(startInput)).rejects.toMatchObject({
        message: expect.stringContaining("box is not running"),
      });
    });

    it("returns a warm idle Box without resuming the machine its Pi is already running on", async () => {
      const commands: string[] = [];
      const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
        const url = String(rawUrl);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
          return json({ box: { ...box, state: "idle" } });
        }
        if (url.endsWith("/commands") && method === "POST") {
          const command = String(body.command);
          commands.push(command);
          return json({
            success: true,
            exitCode: 0,
            stdout: command.includes("companion-pi-warm-ready") ? "companion-pi-warm-ready\n" : "",
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

      const result = await runtime.start({ ...startInput, replaceProviderAuth: false });

      expect(result).toMatchObject({ runtimeState: "running", daemonState: "running" });
      // The warm answer is the reachability proof, so the fast path still costs exactly one command
      // and never restarts the turn that daemon may be in the middle of.
      expect(commands).toHaveLength(1);
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/resume"))).toBe(false);
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/files"))).toBe(false);
    });
  });

  /**
   * THE-340: the lifecycle caller gives one wake a deadline, and the adapter is what has to end when
   * it does. Every Box call and every poll interval runs on that signal, because a start that keeps
   * working against a Box nobody is waiting on is what held the `provisioning` claim open.
   */
  describe("a start the caller's budget cancels", () => {
    const startInput = {
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web" as const,
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: true,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    };

    it("stops waiting for a Box to become ready as soon as the budget ends", async () => {
      // A Box that never leaves setup: without the budget the start owns this wait for the adapter's
      // whole ready timeout, which is the two minutes a stalled wake spent doing nothing.
      const fetchMock = vi.fn(async (rawUrl: string | URL | Request) => {
        if (String(rawUrl).endsWith("/boxes/bx_23456789")) {
          return json({ box: { ...box, state: "provisioning", setupStatus: "running" } });
        }
        throw new Error(`unexpected Box request: ${String(rawUrl)}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const runtime = new AsciiBoxCompanionRuntime({
        COMPANION_BOX_API_KEY: "box_test",
        COMPANION_BOX_POLL_INTERVAL_MS: "50",
        COMPANION_BOX_READY_TIMEOUT_MS: "600000",
      });
      const budget = new AbortController();
      const deadline = new Error("wake budget spent");

      const started = runtime.start({ ...startInput, signal: budget.signal });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      budget.abort(deadline);

      // Which cancellation surfaces depends on what the start was waiting on; the lifecycle caller
      // reports the budget it spent rather than this, and what matters here is that the wait ended.
      await expect(started).rejects.toThrow(/abort/i);
      // The wait ended on the abort rather than on the poll interval that came after it.
      const answered = fetchMock.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fetchMock.mock.calls).toHaveLength(answered);
    });

    /**
     * The one call a cancelled wake still has to make. A Box recovered by name is recorded nowhere
     * until the control plane accepts its id, so a deadline that lands on that write leaves a Box
     * awake with nothing pointing at it — and a stop that inherited the deadline would put nothing to
     * sleep.
     */
    it("puts a Box it could not record to sleep even though the budget already ended", async () => {
      const answered: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
        const url = String(rawUrl);
        const method = init?.method ?? "GET";
        // The provider is reached through `fetch`, so a request carrying a spent signal never runs.
        if (init?.signal?.aborted) throw init.signal.reason;
        answered.push(`${method} ${new URL(url).pathname}`);
        if (url.includes("/boxes?") && method === "GET") {
          return json({
            boxes: [{
              ...box,
              name: `Companion ${startInput.companionId}`,
              state: "idle",
            }],
          });
        }
        if (url.endsWith("/stop") && method === "POST") return json({ ok: true });
        throw new Error(`unexpected Box request: ${method} ${url}`);
      }));
      const runtime = new AsciiBoxCompanionRuntime({
        COMPANION_BOX_API_KEY: "box_test",
        COMPANION_BOX_POLL_INTERVAL_MS: "1",
      });
      const budget = new AbortController();
      const deadline = new Error("wake budget spent");

      // What the lifecycle caller does at its deadline: the assignment is refused, because the reason
      // this wake failed is already on the Companion row and must stay there.
      const started = runtime.start({
        ...startInput,
        boxId: null,
        signal: budget.signal,
        onBoxAssigned: async () => {
          budget.abort(deadline);
          throw deadline;
        },
      });

      await expect(started).rejects.toBe(deadline);
      expect(answered.some((request) =>
        request.startsWith("POST") && request.endsWith("/boxes/bx_23456789/stop"))).toBe(true);
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

  /**
   * A Box that accepted a write is not a Box that kept it. The reported wake died extracting a skill
   * package on a Box the provider had just brought back from `idle`, and the identical payload
   * extracted on the very next attempt against that same Box — a transfer that did not land, not a
   * package that cannot be read. The control plane knows what it sent, so these cover it noticing.
   */
  describe("an archive the Box did not keep whole", () => {
    /**
     * A Box with a disk that answers for itself. Whatever is written is what the size probe reports,
     * so a truncated write is visible to the control plane exactly as it would be on a real Box.
     */
    function boxWithDisk(options: { truncateFirstWriteOf?: string; measures?: boolean }) {
      const disk = new Map<string, string>();
      const writes: string[] = [];
      const commands: string[] = [];
      const truncated = new Set<string>();
      const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
        const url = String(rawUrl);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
        if (url.endsWith("/files") && method === "PUT") {
          const path = String(body.path);
          const content = String(body.content);
          writes.push(path);
          const short = path === options.truncateFirstWriteOf && !truncated.has(path);
          if (short) truncated.add(path);
          disk.set(path, short ? content.slice(0, content.length - 40) : content);
          return json({ ok: true });
        }
        if (url.endsWith("/commands") && method === "POST") {
          const command = String(body.command);
          commands.push(command);
          if (command.includes("companion-archive-bytes")) {
            if (!options.measures) return json({ success: false, exitCode: 127, stdout: "", stderr: "wc: not found" });
            const lines = [...disk]
              .filter(([path]) => path.endsWith(".tar.gz.b64"))
              .map(([path, content]) =>
                `companion-archive-bytes ${path.split("/").at(-1)} ${Buffer.byteLength(content, "utf8")}`);
            return json({ success: true, exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" });
          }
          return json({
            success: true,
            exitCode: 0,
            stdout: command.includes("is-active") ? "active\n" : "",
            stderr: "",
          });
        }
        throw new Error(`unexpected Box request: ${method} ${url}`);
      });
      return { fetchMock, disk, writes, commands };
    }

    const archive = Buffer.from("relecture-catalogue-payload");
    const archivePath = ".companion/runtime/state/skill-archives/relecture-catalogue.tar.gz.b64";

    const wake = (fetchMock: ReturnType<typeof vi.fn>) => {
      vi.stubGlobal("fetch", fetchMock);
      return new AsciiBoxCompanionRuntime({
        COMPANION_BOX_API_KEY: "box_test",
        COMPANION_BOX_POLL_INTERVAL_MS: "1",
      }).start({
        companionId: "11111111-1111-4111-8111-111111111111",
        orgId: "22222222-2222-4222-8222-222222222222",
        boxId: "bx_23456789",
        clientSurface: "web",
        providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
        replaceProviderAuth: true,
        mcpCredentials: [],
        mcpAccounts: [],
        skills: [{
          slug: "relecture-catalogue",
          version: "4.5.6",
          checksum: `sha256:${"b".repeat(64)}`,
          archive,
        }],
        onBoxAssigned: async () => undefined,
      });
    };

    it("sends it again rather than failing the wake over it", async () => {
      const stub = boxWithDisk({ truncateFirstWriteOf: archivePath, measures: true });

      const result = await wake(stub.fetchMock);

      // The short write is repaired before anything tries to read it, so the archive the extract
      // decodes is the one the control plane meant to stage.
      expect(stub.writes.filter((path) => path === archivePath)).toHaveLength(2);
      expect(stub.disk.get(archivePath)).toBe(archive.toString("base64"));
      const measured = stub.commands.findIndex((command) => command.includes("companion-archive-bytes"));
      const extract = stub.commands.findIndex((command) => command.includes("skills.next"));
      expect(measured).toBeGreaterThanOrEqual(0);
      expect(measured).toBeLessThan(extract);
      expect(result.runtimeState).toBe("running");
    });

    it("leaves an archive it landed whole alone", async () => {
      const stub = boxWithDisk({ measures: true });

      const result = await wake(stub.fetchMock);

      expect(stub.writes.filter((path) => path === archivePath)).toHaveLength(1);
      expect(result.runtimeState).toBe("running");
    });

    it("starts anyway when the rewrite it tried will not land either", async () => {
      // The repair is an attempt, not a requirement. The extract that follows is the better judge of
      // whether the tree can be built, so a refused rewrite must not be what ends the wake.
      const stub = boxWithDisk({ truncateFirstWriteOf: archivePath, measures: true });
      let rewrites = 0;
      const refusing = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        if (String(rawUrl).endsWith("/files") && String(body.path) === archivePath) {
          rewrites += 1;
          if (rewrites > 1) return json({ code: "internal", message: "disk is unavailable" }, 500);
        }
        return await stub.fetchMock(rawUrl, init);
      });

      const result = await wake(refusing as unknown as ReturnType<typeof vi.fn>);

      expect(rewrites).toBe(2);
      expect(stub.commands.some((command) => command.includes("skills.next"))).toBe(true);
      expect(result.runtimeState).toBe("running");
    });

    it("starts anyway on a Box that will not measure what it holds", async () => {
      // The measurement is only ever used to repair. A Box that cannot answer it is left to the
      // extract step exactly as before, because this probe may not cost a wake that would have worked.
      const stub = boxWithDisk({ measures: false });

      const result = await wake(stub.fetchMock);

      expect(stub.writes.filter((path) => path === archivePath)).toHaveLength(1);
      expect(stub.commands.some((command) => command.includes("skills.next"))).toBe(true);
      expect(result.runtimeState).toBe("running");
    });

    it("asks for the measurement on a short window rather than a start's whole budget", async () => {
      // A Box slow enough to miss this would otherwise spend a large part of the wake on a step whose
      // answer was only ever optional, so the request it makes has to say how little it will wait.
      const stub = boxWithDisk({ measures: true });
      const asked: unknown[] = [];
      const watching = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        if (String(body.command ?? "").includes("companion-archive-bytes")) {
          asked.push(body.timeoutSeconds);
        }
        return await stub.fetchMock(rawUrl, init);
      });

      await wake(watching as unknown as ReturnType<typeof vi.fn>);

      expect(asked).toEqual([10]);
    });
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

  /**
   * THE-340: production recorded this failure as the bare sentence `Pi resources failed to prepare`.
   * It names the step and nothing else, so the same stored line covered a corrupt archive, a full
   * disk, and a tree that would not swap, and the wake that hit it could not be told apart from a
   * wake that hit any other. The script's own last word is what separates them.
   */
  it("names the archive a failed skill preparation could not extract", async () => {
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        if (String(body.command).includes("skills.next")) {
          return json({
            success: false,
            exitCode: 1,
            stdout: "",
            // tar reports a bad member over three lines and ends on the one that says nothing, so the
            // script appends the slug after it. The stored reason keeps the last line only.
            stderr: "gzip: stdin: not in gzip format\ntar: Child returned status 1\n"
              + "tar: Error is not recoverable: exiting now\n"
              + "skill package relecture-catalogue did not extract\n",
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
    })).rejects.toThrow(
      "Pi resources failed to prepare (exit 1): skill package relecture-catalogue did not extract",
    );
  });

  it("names the shell's own complaint when clearing the staging directory fails", async () => {
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        // Only the staging command creates that directory; the extract command removes it.
        if (String(body.command).includes('mkdir -p "$root/state/skill-archives"')) {
          return json({
            success: false,
            exitCode: 1,
            stdout: "",
            stderr: "mkdir: cannot create directory '/home/user/.companion': No space left on device\n",
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
    })).rejects.toThrow(
      "Pi resource staging failed (exit 1): "
      + "mkdir: cannot create directory '/home/user/.companion': No space left on device",
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

  it("keeps systemctl out of setup and leaves MCP credentials in tmpfs for auto-restart", async () => {
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
    // EnvironmentFile is read for every ExecStart, including Restart=on-failure. Keeping its source
    // in %t (the user runtime tmpfs) makes credentials available to that restart without putting
    // them on the snapshotted Box disk.
    expect(createdSetupScript).toContain("EnvironmentFile=-%t/companion/providers.env");
    expect(createdSetupScript).not.toContain(
      "EnvironmentFile=-%h/.companion/runtime/state/providers.env",
    );
    const start = commands.find((command) =>
      command.includes("systemctl --user start companion-pi-daemon.service"));
    expect(start).toBeDefined();
    expect(start).toContain("systemctl --user daemon-reload");
    expect(start).toContain('companion_user_runtime_dir="/run/user/$(id -u)"');
    expect(start).toContain('export XDG_RUNTIME_DIR="$companion_user_runtime_dir"');
    expect(start).not.toContain("${XDG_RUNTIME_DIR:-");
    expect(start).toContain('export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"');
    expect(start).toContain("loginctl enable-linger");
    expect(start).toContain("systemctl --user show-environment");
    expect(start).toMatch(
      /for _ in \$\(seq 1 20\); do\n\s+companion_export_user_bus\n\s+if systemctl --user show-environment/,
    );
    expect(start).toContain('mv -f "$staged_credential_file" "$runtime_credential_file"');
    expect(start).toContain('runtime_credential_dir="$XDG_RUNTIME_DIR/companion"');
    expect(start).toContain("trap - EXIT");
    expect(start!.indexOf("systemctl --user start companion-pi-daemon.service"))
      .toBeLessThan(start!.indexOf("trap - EXIT"));
    expect(start).not.toContain("systemctl --user restart companion-pi-daemon.service");
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
        if (command.includes("start companion-pi-daemon.service")) {
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
    const starts: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        if (command.includes("systemctl --user start")) starts.push(command);
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
    // Only the wake's own start is issued: another start on a later probe would add needless work
    // while systemd is already recovering the daemon.
    expect(starts).toHaveLength(1);
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
    expect(error.message).toContain("Active: failed (Result: exit-code)");
    // `is-active` prints the word `Active:` opens with, so storing both spent the line twice on one
    // verdict. It is kept only for a unit whose status the Box would not print.
    expect(error.message).not.toContain("is-active:");
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
    // A timed-out observation does not prove systemd stopped recovering. Keep the tmpfs file so an
    // on-failure restart after this response still receives MCP credentials.
    expect(commands.some((command) => command.startsWith(PROVIDER_FILE_REMOVAL))).toBe(false);
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

  it("names the crash loop and systemd's own account when Pi wrote nothing anywhere", async () => {
    // The production wake this replaces: the daemon answered `activating` for the whole window and
    // the stored line said only that, an auto-restart, and `exit 1`. Nothing in it separated a Pi
    // that was still starting from one that had already died five times, and nothing said why.
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
            stdout: [
              "companion-pi-state activating",
              "companion-pi-status      Active: activating (auto-restart) (Result: exit-code) since"
              + " Thu 2026-08-13 21:23:14 UTC; 1s ago",
              "companion-pi-status     Process: 4242 ExecStart=/root/.companion/bin/pi-daemon"
              + " (code=exited, status=1/FAILURE)",
              "companion-pi-restarts 5",
              // Pi never wrote a line, so systemd's journal is the only account of the failure.
              "companion-pi-journal companion-pi-daemon.service: Start request repeated too quickly.",
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

    expect(error.message).toContain("Active: activating (auto-restart) (Result: exit-code)");
    expect(error.message).toContain("exit: code=exited, status=1/FAILURE");
    // A restart count is what makes a crash loop read as one instead of as a slow first start.
    expect(error.message).toContain("restarts: 5");
    expect(error.message).toContain("journal: companion-pi-daemon.service: Start request repeated");
    expect(error.message.split("\n")).toHaveLength(1);
    expect(companionRuntimeErrorMessage(error)).toBe(error.message);
    const diagnostic = commands.find((command) => command.includes("companion_label")) ?? "";
    expect(diagnostic).toContain("--property=NRestarts");
    // systemd keeps the unit's whole history, so the journal is read for the same window Pi's log is:
    // a line from an earlier wake must not be reported as the reason this one failed.
    expect(diagnostic).toContain("journalctl --user --unit companion-pi-daemon.service");
    expect(diagnostic).toContain("--since=-2min");
    expect(diagnostic).not.toContain("providers.env");
    expect(diagnostic).not.toContain("auth.json");
    for (const command of commands) expect(command).not.toContain("mcp-secret");
  });

  it("clears a latched start limit so a wake after a crash loop starts Pi again", async () => {
    // systemd stops restarting a unit that failed too often and refuses every later start until the
    // latched failure is cleared, so a Companion that crash-looped once answered the next wake with
    // systemd's own rate-limit complaint instead of starting Pi — for as long as the Box lived.
    let startAttempts = 0;
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return json({ box });
      if (url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const command = String(body.command);
        const start = command.indexOf("start companion-pi-daemon.service");
        if (start >= 0) {
          startAttempts += 1;
          const cleared = command.indexOf("reset-failed companion-pi-daemon.service");
          if (cleared < 0 || cleared > start) {
            return json({
              success: false,
              exitCode: 1,
              stdout: "",
              stderr: "Job for companion-pi-daemon.service failed because start of the service was"
                + " attempted too often\n",
            });
          }
        }
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
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    // One start attempt, and it is the one that cleared the latch first rather than a retry.
    expect(startAttempts).toBe(1);
    expect(result).toMatchObject({ runtimeState: "running", daemonState: "running" });
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
    expect(error.message).toContain("Active: failed (Result: exit-code)");
    // The `Active:` line closes with the clock time the unit entered that state, which the control
    // plane already knows from when it asked, so the timestamp is dropped rather than clamping Pi's
    // own words out of the line.
    expect(error.message).not.toContain("since");
    expect(error.message).not.toContain("is-active:");
    // systemd's account is the only one that always exists, so it survives the squeeze whole and
    // Pi's log — supplementary, and absent for the failures that motivated this — is what clamps.
    expect(error.message).toContain("exit: code=exited, status=1/FAILURE");
    expect(error.message).toContain("pi.stderr.log: pi: error: could not open the session");
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

  it("stays inside the stored line for any mix of fragments the Box reports", () => {
    // The fragments are clamped against a shared allowance, so the arithmetic has to hold for
    // every combination of present, absent, short, and overlong lines rather than the few shapes
    // production has shown so far. A message over the limit loses its tail to the sanitizer.
    // The sweep reads one stdout at a time because that is all the arithmetic depends on; the wake
    // that hands it this stdout is covered by the failures above.
    // Prose-shaped filler: an unbroken run of 40+ word characters is credential-shaped and would
    // be redacted, which is a different behavior than the length arithmetic under test here.
    const filler = (size: number): string => "chars ".repeat(size).slice(0, size).trim();
    const sizes = [0, 1, 40, 400];
    for (const stateSize of sizes) {
      for (const activeSize of sizes) {
        for (const stderrSize of sizes) {
          for (const exitSize of sizes) {
            for (const journalSize of sizes) {
              const stdout = [
                stateSize ? `companion-pi-state ${filler(stateSize)}` : "",
                activeSize ? `companion-pi-status Active: ${filler(activeSize)}` : "",
                exitSize
                  ? `companion-pi-status Process: 42 ExecStart=/x (code=${filler(exitSize)})`
                  : "",
                // systemd counts restarts, so this fragment is a number or nothing at all.
                `companion-pi-restarts ${stateSize * 7}`,
                stderrSize ? `companion-pi-stderr ${filler(stderrSize)}` : "",
                journalSize ? `companion-pi-journal ${filler(journalSize)}` : "",
              ].filter(Boolean).join("\n");

              const message = `${PI_DAEMON_FAILURE_MESSAGE}${composeDaemonFailureDetail(stdout)}`;
              const error = new BoxRuntimeProviderError(message, 502);

              expect(message.length).toBeLessThanOrEqual(COMPANION_RUNTIME_ERROR_MAX_LENGTH);
              // Nothing the Box printed may survive as a second line or be dropped by the sanitizer.
              expect(companionRuntimeErrorMessage(error)).toBe(message);
            }
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
        expect(body).toEqual({ noEnv: true, ttlSeconds: 21_600 });
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
    const assigned: Array<string | null> = [];
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
    const commands: string[] = [];
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
        const command = String(body.command);
        commands.push(command);
        // The staging command reports no auth file, as on a replacement disk an earlier start
        // provisioned but never finished configuring.
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
      // The control plane recorded this Box at the current layout and generation.
      replaceProviderAuth: false,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async () => undefined,
    });

    expect(writtenPaths).toContain(".companion/pi/auth.json");
    // `active` alone is insufficient: without the warm-ready marker proving the tmpfs credential
    // file exists, the adapter repairs resources and uses the idempotent start path.
    expect(commands.some((command) => command.includes("companion-pi-warm-ready"))).toBe(true);
    expect(commands.some((command) =>
      command.includes("systemctl --user start companion-pi-daemon.service"))).toBe(true);
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

  /**
   * Product promise (THE-332): 1 Companion = 1 Box = 1 Pi. The restore that undid the shared-workspace
   * Box copied one pool Box id onto every Companion row in its scope, so a recorded id alone can name
   * a machine that belongs to a workspace or to a sibling. Adopting it would run one Pi for several
   * Companions, which is the cardinality the restore existed to remove.
   */
  it("gives each Companion its own Box when the restore left a shared workspace id on both rows", async () => {
    const orgId = "22222222-2222-4222-8222-222222222222";
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "33333333-3333-4333-8333-333333333333";
    const shared = {
      id: "bx_5neg83t4",
      name: `Companion org ${orgId}`,
      // A Box the provider reports idle is ready to take commands, so nothing else would have
      // stopped this wake from starting Pi on the machine a whole workspace was pointed at.
      state: "idle",
      desktopAvailable: false,
      setupStatus: "done",
    };
    // The two Companion rows as migration 0074 left them, updated the way the route's callback does.
    const recorded: Record<string, string | null> = { [first]: shared.id, [second]: shared.id };
    const assignments: Array<[string, string | null]> = [];
    const created: string[] = [];
    const createdNames = new Map<string, string>();
    const sharedRequests: string[] = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.includes(shared.id)) {
        sharedRequests.push(`${method} ${url.slice(url.indexOf("/boxes"))}`);
        if (method === "GET") return json({ box: shared });
        throw new Error(`the shared Box must stay untouched: ${method} ${url}`);
      }
      if (url.includes("/boxes?limit=200") && method === "GET") {
        // Everything the provider knows: the shared machine plus a third Companion's archived Box.
        return json({
          boxes: [
            shared,
            {
              ...shared,
              id: "bx_dauymk5m",
              name: "Companion 44444444-4444-4444-8444-444444444444",
              state: "archived",
            },
          ],
        });
      }
      if (url.endsWith("/boxes") && method === "POST") {
        const id = ["bx_23456789", "bx_abcdefgh"][created.length]!;
        created.push(id);
        return json({ box: { id, state: "provisioning", desktopAvailable: true, setupStatus: "pending" } }, 202);
      }
      const target = created.find((id) => url.includes(id));
      if (target && method === "PATCH") {
        createdNames.set(target, String(body.name));
        return json({ box: { ...box, id: target, name: String(body.name) } });
      }
      if (target && url.endsWith(`/boxes/${target}`) && method === "GET") {
        return json({ box: { ...box, id: target, name: createdNames.get(target) } });
      }
      if (target && url.endsWith("/files") && method === "PUT") return json({ ok: true });
      if (target && url.endsWith("/commands") && method === "POST") {
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
    const wake = (companionId: string) => runtime.start({
      companionId,
      orgId,
      boxId: recorded[companionId] ?? null,
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: false,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async (boxId) => {
        assignments.push([companionId, boxId]);
        recorded[companionId] = boxId;
      },
    });

    const wokeFirst = await wake(first);
    // The other Companion's row is untouched by this wake: it is a separate machine and a separate row.
    expect(recorded[second]).toBe(shared.id);
    const wokeSecond = await wake(second);

    expect(wokeFirst.boxId).toBe("bx_23456789");
    expect(wokeSecond.boxId).toBe("bx_abcdefgh");
    expect(recorded).toEqual({ [first]: "bx_23456789", [second]: "bx_abcdefgh" });
    expect(createdNames.get("bx_23456789")).toBe(`Companion ${first}`);
    expect(createdNames.get("bx_abcdefgh")).toBe(`Companion ${second}`);
    // Each wake clears the shared id first, so no other path can reach that machine either.
    expect(assignments).toEqual([
      [first, null],
      [first, "bx_23456789"],
      [second, null],
      [second, "bx_abcdefgh"],
    ]);
    // The shared machine is read to see whose it is and then left alone: never woken, resumed,
    // renamed, or stopped, because another Companion's row may still be pointing at it.
    expect(sharedRequests).toEqual([
      `GET /boxes/${shared.id}`,
      `GET /boxes/${shared.id}`,
    ]);
  });

  it("refuses an archived Box that carries another Companion's name instead of resuming it", async () => {
    const sibling = {
      id: "bx_sbngxyzw",
      name: "Companion 44444444-4444-4444-8444-444444444444",
      state: "archived",
      desktopAvailable: false,
      setupStatus: "done",
    };
    let createdBox = false;
    let createdName: unknown;
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.includes(sibling.id)) {
        if (method === "GET") return json({ box: sibling });
        throw new Error(`another Companion's Box must stay untouched: ${method} ${url}`);
      }
      if (url.includes("/boxes?limit=200") && method === "GET") return json({ boxes: [sibling] });
      if (url.endsWith("/boxes") && method === "POST") {
        createdBox = true;
        return json({ box: { ...box, state: "provisioning", setupStatus: "pending" } }, 202);
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "PATCH") {
        createdName = body.name;
        return json({ box });
      }
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
    const assigned: Array<string | null> = [];

    const result = await runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: sibling.id,
      clientSurface: "web",
      providerAuth: { anthropic: { type: "api_key", key: "provider-secret" } },
      replaceProviderAuth: false,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async (boxId) => {
        assigned.push(boxId);
      },
    });

    // An archived Box a sibling owns is not a disk to resume into; this Companion gets its own name.
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/resume"))).toBe(false);
    expect(createdBox).toBe(true);
    expect(createdName).toBe("Companion 11111111-1111-4111-8111-111111111111");
    expect(assigned).toEqual([null, "bx_23456789"]);
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
    expect(stopCommand).toContain(`rm -f ${RUNTIME_PROVIDER_FILE}`);
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
        if (command.includes("start companion-pi-daemon")) {
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
      command.startsWith(PROVIDER_FILE_REMOVAL))).toBe(true);
    expect(commands.some((command) => command.includes(RUNTIME_PROVIDER_FILE))).toBe(true);
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
      command.startsWith(PROVIDER_FILE_REMOVAL))).toBe(true);
    expect(commands.some((command) => command.includes(RUNTIME_PROVIDER_FILE))).toBe(true);
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

  it("refreshes the Box idle clock to six hours after a successful message", async () => {
    let patchBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/boxes/bx_23456789") && init?.method === "PATCH") {
        patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ box });
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await runtime.refreshTtl({ boxId: "bx_23456789" });

    expect(patchBody).toEqual({ ttlSeconds: 21_600 });
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

  /**
   * The wrapper systemd runs is a shell script, and the wake that failed in production failed inside
   * it: the unit reported `exit 1` and an auto-restart, and every account of the reason was empty.
   * These run the installed wrapper the way the unit does, so what it writes down when it cannot
   * reach Pi is behavior rather than intention.
   */
  describe("starting the Pi daemon against a real disk", () => {
    it("records the Pi invocation it made so a silent death is still attributable", async () => {
      const disk = await boxDiskWithPiDaemon();

      const started = await runOnBoxDisk(`bash ${JSON.stringify(disk.daemon)}`, disk.home);

      expect(started.exitCode).toBe(0);
      // Pi ran with the isolated agent directory, the Companion session directory, and no ambient
      // skills, and the wrapper wrote that invocation down before handing over to it.
      expect(await readFile(disk.argv, "utf8")).toContain("--mode rpc");
      expect(await reportedStderrLine(disk.stderrLog)).toMatch(/^pi-daemon: starting \S+pi --no-skills$/);
    });

    it("names the reason a start died before Pi ever ran", async () => {
      // Reproduces the production signature: the unit exits 1 and neither Pi's log nor its stdout
      // has anything in it, because the failure happened before the wrapper reached `exec`. Anything
      // the wrapper said went to the journal alone, and the log kept an older start's timestamp, so
      // the freshness window dropped it too and the wake reported an exit status with no reason.
      const disk = await boxDiskWithPiDaemon();
      // Something at the FIFO path the wrapper cannot replace. Any pre-`exec` failure has the same
      // shape; this one needs no permission the test user might already have.
      await mkdir(join(disk.home, ".companion", "runtime", "state", "pi.rpc.in", "held"), {
        recursive: true,
      });
      // The freshness window compares one file's timestamp against another clock reading, so the
      // reference is taken from this disk rather than from `Date.now()`: a filesystem whose timestamps
      // trail the process clock would otherwise make a log written after this point look older.
      const clock = join(disk.home, "attempted-at");
      await writeFile(clock, "");
      const attemptedAt = (await stat(clock)).mtimeMs;

      const started = await runOnBoxDisk(`bash ${JSON.stringify(disk.daemon)}`, disk.home);

      expect(started.exitCode).not.toBe(0);
      // Pi was never handed the daemon invocation; the only argv on this disk is the layout install.
      expect(await readFile(disk.argv, "utf8")).not.toContain("--mode rpc");
      // The wrapper's own account of the failure, in the log the failure diagnostic reads, with the
      // line and the command that failed rather than only the status systemd recorded.
      const reported = await reportedStderrLine(disk.stderrLog);
      expect(reported).toContain("pi-daemon: line");
      expect(reported).toContain('rm -f "$fifo"');
      expect(reported).toContain("failed with status 1");
      // And it is this start's line: the log was written now, so the freshness window keeps it.
      expect((await stat(disk.stderrLog)).mtimeMs).toBeGreaterThanOrEqual(attemptedAt);
      const detail = composeDaemonFailureDetail([
        "companion-pi-state activating",
        "companion-pi-status Active: activating (auto-restart) (Result: exit-code) since now",
        "companion-pi-status Process: 42 ExecStart=/root/.companion/bin/pi-daemon"
        + " (code=exited, status=1/FAILURE)",
        `companion-pi-stderr ${reported}`,
      ].join("\n"));
      const message = `${PI_DAEMON_FAILURE_MESSAGE}${detail}`;
      expect(message).toContain("pi.stderr.log: pi-daemon: line");
      expect(message.length).toBeLessThanOrEqual(COMPANION_RUNTIME_ERROR_MAX_LENGTH);
      expect(companionRuntimeErrorMessage(new BoxRuntimeProviderError(message, 502))).toBe(message);
    });

    it("rolls the log a crash loop keeps appending to instead of filling the disk", async () => {
      const disk = await boxDiskWithPiDaemon();
      await writeFile(disk.stderrLog, "old crash reasons\n".repeat(70_000));

      const started = await runOnBoxDisk(`bash ${JSON.stringify(disk.daemon)}`, disk.home);

      expect(started.exitCode).toBe(0);
      const rolled = await readFile(`${disk.stderrLog}.1`, "utf8");
      expect(rolled).toContain("old crash reasons");
      // The live log carries this start and nothing older, so it starts over well under the ceiling.
      const kept = await readFile(disk.stderrLog, "utf8");
      expect(kept).toContain("pi-daemon: starting");
      expect(kept).not.toContain("old crash reasons");
    });
  });

  /**
   * A read is how a live thread reaches the operator, so every state a Box disk can be in has to come
   * back as a chunk. Only a Box that could not run the read at all is a failure, and it says why.
   */
  describe("reading the Pi event log against a real disk", () => {
    const event = (index: number) => `{"type":"agent_message","text":"line ${index}"}`;

    it("reads a log longer than the read limit one chunk at a time instead of failing", async () => {
      let log = "";
      for (let index = 0; log.length < COMPANION_PI_EVENT_READ_LIMIT * 3; index += 1) {
        log += `${event(index)}\n`;
      }
      const { home } = await boxDiskWithPiLog(log);

      const first = await readEventsOnBoxDisk({ home, offset: 0 });

      // `head` stops at the read limit and closes the pipe, which kills `tail` with SIGPIPE. This read
      // exited 141 under `pipefail` and reported an unreadable log for a thread that was fine.
      expect(first.exitCode).toBe(0);
      expect(first.offset).toBe(0);
      expect(Buffer.byteLength(first.chunk, "utf8")).toBe(COMPANION_PI_EVENT_READ_LIMIT);
      expect(first.chunk.startsWith(`${event(0)}\n`)).toBe(true);

      // The bytes past the limit are not lost: the next sync resumes at the offset it stopped on.
      const next = await readEventsOnBoxDisk({ home, offset: COMPANION_PI_EVENT_READ_LIMIT });

      expect(next.exitCode).toBe(0);
      expect(next.offset).toBe(COMPANION_PI_EVENT_READ_LIMIT);
      expect(Buffer.byteLength(next.chunk, "utf8")).toBe(COMPANION_PI_EVENT_READ_LIMIT);
      expect(next.chunk).not.toBe(first.chunk);
    });

    it("reads a log the daemon has not written yet as an empty log at the top", async () => {
      const absent = await boxDiskWithPiLog(null);
      const untouched = await boxDiskWithPiLog("");

      await expect(readEventsOnBoxDisk({ home: absent.home, offset: 0 }))
        .resolves.toEqual({ chunk: "", offset: 0, exitCode: 0 });
      await expect(readEventsOnBoxDisk({ home: untouched.home, offset: 0 }))
        .resolves.toEqual({ chunk: "", offset: 0, exitCode: 0 });
    });

    it("holds the offset when the Box will not report the log size", async () => {
      // Something at the log path that does not answer as a byte stream. Rewinding to the top here
      // would reproject the whole transcript, and failing would blame a thread that is fine. This is
      // the same guard an unreadable log takes, and unlike file permissions it holds for any user.
      const { home, log } = await boxDiskWithPiLog(null);
      await mkdir(log, { recursive: true });

      await expect(readEventsOnBoxDisk({ home, offset: 4_096 }))
        .resolves.toEqual({ chunk: "", offset: 4_096, exitCode: 0 });
    });

    it.skipIf(process.getuid?.() === 0)("holds the offset when the log cannot be read", async () => {
      const { home, log } = await boxDiskWithPiLog(`${event(0)}\n`);
      await chmod(log, 0o000);

      await expect(readEventsOnBoxDisk({ home, offset: 4_096 }))
        .resolves.toEqual({ chunk: "", offset: 4_096, exitCode: 0 });
    });

    it("restarts from the top when a rebuilt disk shrank the log", async () => {
      const { home } = await boxDiskWithPiLog(`${event(0)}\n`);

      await expect(readEventsOnBoxDisk({ home, offset: 4_096 }))
        .resolves.toEqual({ chunk: `${event(0)}\n`, offset: 0, exitCode: 0 });
    });

    it("reads only the bytes after the offset it was given", async () => {
      const read = `${event(0)}\n`;
      const { home } = await boxDiskWithPiLog(`${read}${event(1)}\n`);
      const offset = Buffer.byteLength(read, "utf8");

      await expect(readEventsOnBoxDisk({ home, offset }))
        .resolves.toEqual({ chunk: `${event(1)}\n`, offset, exitCode: 0 });
    });

    it("keeps the bytes a reader that stopped partway wrote instead of failing the read", async () => {
      // What production did to this read: whatever captures the command's output stopped accepting
      // bytes before the read limit, so the reader failed on its own stdout having already written
      // some. Under `set -e` that failure skipped the script's `exit 0`, and the adapter reported the
      // chunk's last Pi event line as the reason the log could not be read.
      const { home } = await boxDiskWithPiLog(`${event(0)}\n${event(1)}\n`);
      const bin = await binWithCappedCommand("head", 1);

      const read = await readEventsOnBoxDisk({ home, offset: 0, pathPrefix: bin });

      expect(read.exitCode).toBe(0);
      expect(read.offset).toBe(0);
      // The bytes the reader did write are a chunk; the rest is read again from this offset.
      expect(read.chunk).toBe(`${event(0)}\n`);
    });

    it("holds the offset when the reader fails before writing any bytes", async () => {
      // The disk goes bad underneath the read, so the reader fails after the offset line was printed
      // and produces nothing. That is the same empty read an unreadable log takes: it resumes where
      // this sync came in rather than rewinding and reprojecting the transcript.
      const { home } = await boxDiskWithPiLog(`${event(0)}\n`);
      const bin = await binWithFailingCommand(
        "head",
        1,
        "head: error reading 'standard input': Input/output error",
      );

      await expect(readEventsOnBoxDisk({ home, offset: 0, pathPrefix: bin }))
        .resolves.toEqual({ chunk: "", offset: 0, exitCode: 0 });
    });
  });

  it("projects a capped read the Box called unsuccessful rather than failing the sync", async () => {
    // The production banner this replaces: the read printed its offset and a Pi event line, came back
    // unsuccessful with an empty stderr, and the failure detail quoted that event line as the reason
    // the log could not be read. A read carrying a resume point is a chunk whatever status came with
    // it, whether the script's own tolerance or this one caught it.
    const chunk = "{\"type\":\"extension_ui_request\",\"method\":\"setStatus\",\"statusKey\":\"mcp\"}\n";
    vi.stubGlobal("fetch", vi.fn(async () => json({
      success: false,
      exitCode: 1,
      stdout: `12\n${chunk}`,
      stderr: "",
    })));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.readEvents({ boxId: "bx_23456789", offset: 12 }))
      .resolves.toEqual({ chunk, offset: 12 });
  });

  it("fails the read when the Box printed no offset to resume from", async () => {
    // Nothing ran the read, so there is no chunk and no resume point: this is the one Pi read failure
    // the operator should see, and it names the exit status and the last line the Box printed.
    vi.stubGlobal("fetch", vi.fn(async () => json({
      success: false,
      exitCode: 137,
      stdout: "",
      stderr: "command timed out after 30s",
    })));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.readEvents({ boxId: "bx_23456789", offset: 12 })).rejects.toMatchObject({
      status: 502,
      message: "Pi event log could not be read from Box (exit 137): command timed out after 30s",
    });
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

  it("puts a name-recovered Box to sleep resumably when its id cannot be persisted", async () => {
    // The wake refuses the shared id the row carried, recovers this Companion's own Box by name, and
    // then cannot record it. That Box is awake with nothing pointing at it, so it is slept the ordinary
    // way — snapshotted, not discarded, and still deterministically named — and the next start resumes
    // the same disk. Anything that force-stopped or renamed it here would lose the thread's disk to a
    // transient write failure.
    const own = {
      ...box,
      id: "bx_ownzxyw4",
      name: "Companion 11111111-1111-4111-8111-111111111111",
    };
    const stops: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/boxes/bx_5neg83t4") && method === "GET") {
        return json({
          box: { ...box, id: "bx_5neg83t4", name: "Companion org 22222222-2222-4222-8222-222222222222" },
        });
      }
      if (url.includes("/boxes?limit=200") && method === "GET") return json({ boxes: [own] });
      if (url.endsWith(`/boxes/${own.id}/stop`) && method === "POST") {
        stops.push(body);
        return json({ box: { ...own, state: "archiving" } }, 202);
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.start({
      companionId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_5neg83t4",
      clientSurface: "web",
      providerAuth: {},
      replaceProviderAuth: false,
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
      onBoxAssigned: async (boxId) => {
        if (boxId !== null) throw new Error("database unavailable");
      },
    })).rejects.toThrow("database unavailable");

    expect(stops).toEqual([{ force: false }]);
    // No Box was created, and the recovered Box keeps the name the next start looks it up by.
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/boxes") && init?.method === "POST")).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });
});

