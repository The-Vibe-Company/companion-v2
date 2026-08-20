import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS,
  COMPANION_ROUTINE_MAX_PER_COMPANION,
  COMPANION_ROUTINE_MIN_INTERVAL_MS,
  COMPANION_TOOL_RUN_TIMEOUT_MS,
} from "@companion/contracts";
import { COMPANION_RUNTIME_ERROR_MAX_LENGTH } from "@companion/core";

import {
  AsciiBoxCompanionRuntime,
  BOX_PROVIDER_STATES,
  BoxRuntimeConfigurationError,
  BoxRuntimeProviderError,
  COMPANION_OUTBOX_INSTRUCTIONS,
  composeDaemonFailureDetail,
  composedInstructions,
  mintBoxDesktopUrl,
  observedBoxStateFromProvider,
  parseOutboxManifest,
  resolvePiPackages,
} from "./boxCompanionRuntime";
import { companionPiLayoutIdentity } from "./companionRuntimeImage";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Box desktop mint", () => {
  it("mints a fresh VNC URL for every join", async () => {
    let sequence = 0;
    const vnc = vi.fn(async () => ({ desktopUrl: `https://desktop.test/vnc/${++sequence}` }));
    const input = {
      vnc,
      webrtc: vi.fn(async () => ({ desktopUrl: "https://desktop.test/webrtc" })),
      budgetMs: 100,
      pause: vi.fn(async () => undefined),
      now: () => 0,
    };

    await expect(mintBoxDesktopUrl(input)).resolves.toEqual({
      url: "https://desktop.test/vnc/1",
      provisioning: false,
      transport: "vnc",
    });
    await expect(mintBoxDesktopUrl(input)).resolves.toEqual({
      url: "https://desktop.test/vnc/2",
      provisioning: false,
      transport: "vnc",
    });
    expect(input.webrtc).not.toHaveBeenCalled();
  });

  it("waits for VNC until its budget is spent, then falls back to WebRTC", async () => {
    let now = 0;
    const pause = vi.fn(async () => { now += 10; });
    const vnc = vi.fn(async () => ({ provisioning: true }));
    const webrtc = vi.fn(async () => ({ url: "https://desktop.test/webrtc" }));

    await expect(mintBoxDesktopUrl({
      vnc,
      webrtc,
      budgetMs: 20,
      pause,
      now: () => now,
    })).resolves.toEqual({
      url: "https://desktop.test/webrtc",
      provisioning: false,
      transport: "webrtc",
    });
    expect(vnc).toHaveBeenCalledTimes(2);
    expect(webrtc).toHaveBeenCalledOnce();
  });

  it("falls back immediately when the provider build refuses VNC", async () => {
    await expect(mintBoxDesktopUrl({
      vnc: async () => {
        throw new BoxRuntimeProviderError("VNC unsupported", 400);
      },
      webrtc: async () => ({ desktopUrl: "https://desktop.test/webrtc" }),
      budgetMs: 100,
      pause: async () => undefined,
    })).resolves.toEqual({
      url: "https://desktop.test/webrtc",
      provisioning: false,
      transport: "webrtc",
    });
  });
});

describe("narrow AsciiBoxCompanionRuntime", () => {
  it("fails closed when the Box service key is absent", () => {
    expect(() => new AsciiBoxCompanionRuntime({})).toThrow(BoxRuntimeConfigurationError);
  });

  it("observes, resumes, archives, updates TTL, and mints desktop without implicit creation", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    let state: "archived" | "ready" | "archiving" = "archived";
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      requests.push({ method, url, body });
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({ box: box(state) });
      }
      if (url.endsWith("/boxes/bx_23456789/resume") && method === "POST") {
        state = "ready";
        return response({ box: box(state) });
      }
      if (url.endsWith("/boxes/bx_23456789/commands") && method === "POST") {
        return response(commandResult("inactive\ncompanion-pi-broker-unready\n"));
      }
      if (url.endsWith("/boxes/bx_23456789") && method === "PATCH") return response({ box: box(state) });
      if (url.endsWith("/boxes/bx_23456789/stop") && method === "POST") {
        state = "archiving";
        return response({ box: box(state) });
      }
      if (url.endsWith("/boxes/bx_23456789/desktop?vnc=1") && method === "POST") {
        return response({ desktopUrl: "https://desktop.test/vnc" });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));
    const runtime = runtimeClient();

    await expect(runtime.existingBoxStatus({ boxId: "bx_23456789" })).resolves.toEqual({
      boxId: "bx_23456789",
      state: "archived",
    });
    await expect(runtime.resumeExistingBox({ boxId: "bx_23456789" })).resolves.toMatchObject({
      boxId: "bx_23456789",
      runtimeState: "stopped",
      daemonState: "stopped",
    });
    await runtime.refreshTtl({ boxId: "bx_23456789", ttlSeconds: 21_600 });
    await expect(runtime.desktop({ boxId: "bx_23456789" })).resolves.toEqual({
      url: "https://desktop.test/vnc",
      provisioning: false,
      transport: "vnc",
    });
    await expect(runtime.archiveExistingBox({ boxId: "bx_23456789" })).resolves.toEqual({
      boxId: "bx_23456789",
      state: "archiving",
    });

    expect(requests.some((request) => request.url.endsWith("/boxes") && request.method === "POST"))
      .toBe(false);
    expect(requests.find((request) => request.method === "PATCH")?.body)
      .toEqual({ ttlSeconds: 21_600 });
    const archiveCleanup = requests.findIndex((request) =>
      request.url.endsWith("/commands")
      && typeof request.body === "object"
      && request.body !== null
      && "command" in request.body
      && String(request.body.command).includes("control-bundle-v1.json"));
    const archiveRequest = requests.findIndex((request) => request.url.endsWith("/stop"));
    expect(archiveCleanup).toBeGreaterThanOrEqual(0);
    expect(archiveCleanup).toBeLessThan(archiveRequest);
  });

  it("waits for Pi readiness inside one Box command instead of polling the provider", async () => {
    const commands: Array<{ command: string; timeoutSeconds: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_rawUrl: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { command: string; timeoutSeconds: number };
      commands.push(body);
      if (body.command.includes("for companion_pi_probe")) {
        return response(commandResult(
          "active\ncompanion-pi-broker-ready\ncompanion-pi-invocation invocation-1\n",
        ));
      }
      return response(commandResult());
    }));
    const runtime = new AsciiBoxCompanionRuntime({
      COMPANION_BOX_API_KEY: "box_test",
      COMPANION_PI_DAEMON_ACTIVE_TIMEOUT_MS: "1000",
    });

    await expect(runtime.restartPiDaemon({ boxId: "bx_23456789" })).resolves.toEqual({
      state: "idle",
      invocationId: "invocation-1",
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toContain("seq 1 10");
    expect(commands[0]?.command).toContain("sleep 0.1");
    expect(commands[0]?.command).toContain(
      'stat -c \'%a\' "$HOME/.companion/pi" 2>/dev/null || true',
    );
    expect(commands[0]?.timeoutSeconds).toBe(120);
  });

  it("expunges persistent and runtime provider credentials for disposable Box cleanup", async () => {
    let command = "";
    vi.stubGlobal("fetch", vi.fn(async (_rawUrl: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { command: string };
      command = body.command;
      return response(commandResult());
    }));

    await expect(runtimeClient().clearPersistedProviderAuth({ boxId: "bx_23456789" }))
      .resolves.toBeUndefined();
    expect(command).toContain('rm -f "$HOME/.companion/pi/auth.json"');
    expect(command).toContain('"$HOME/.companion/runtime/state/providers.env"');
    expect(command).toContain('"$HOME/.companion/runtime/state/control-bundle-v1.json"');
    expect(command).toContain('"/run/user/$(id -u)/companion/providers.env"');
  });

  it("removes the secret-bearing control bundle when apply command submission fails", async () => {
    const commands: string[] = [];
    let rejectedApply = false;
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({ box: box("ready") });
      }
      if (url.endsWith("/files") && method === "PUT") return response({ ok: true });
      if (url.endsWith("/commands") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { command: string };
        commands.push(body.command);
        if (body.command.includes("COMPANION_CONTROL_APPLY") && !rejectedApply) {
          rejectedApply = true;
          throw new Error("control apply transport failed");
        }
        return response(commandResult("companion-box-runnable\n"));
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    }));

    await expect(runtimeClient().stageExistingBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 1,
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: { provider: { token: "ephemeral-test-token" } },
      replaceProviderAuth: true,
      modelId: "glm-4.6",
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
    })).rejects.toThrow("control apply transport failed");

    expect(commands.at(-1)).toBe(
      'rm -f "$HOME/.companion/runtime/state/control-bundle-v1.json"',
    );
  });

  it("dispatches only correlated layout-14 commands and validates monotonic journal pages", async () => {
    const commandTypes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_rawUrl: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { command: string };
      const command = decodeBrokerCommand(body.command);
      commandTypes.push(String(command.type));
      const id = String(command.id);
      if (command.type === "prompt") {
        return response(commandResult(JSON.stringify({
          id,
          type: "response",
          command: "prompt",
          success: true,
          data: {
            attemptId: command.attemptId,
            invocationId: "invocation-1",
            piAcknowledged: true,
            initialCursor: 0,
            clearOutbox: true,
          },
        }) + "\n"));
      }
      if (command.type === "runtime_state") {
        return response(commandResult(JSON.stringify({
          id,
          type: "response",
          command: "runtime_state",
          success: true,
          data: {
            invocationId: "invocation-1",
            activeAttemptId: "attempt-1",
            tailCursor: 1,
            acknowledgedCursor: 0,
            modelInput: ["text", "image"],
            counters: zeroCounters(),
          },
        }) + "\n"));
      }
      if (command.type === "read_events") {
        return response(commandResult(JSON.stringify({
          id,
          type: "response",
          command: "read_events",
          success: true,
          data: {
            events: [{
              sequence: 1,
              invocationId: "invocation-1",
              attemptId: "attempt-1",
              kind: "pi_event",
              event: { type: "agent_start" },
            }],
            nextCursor: 1,
            acknowledgedCursor: 0,
            hasMore: false,
          },
        }) + "\n"));
      }
      if (command.type === "ack_events") {
        return response(commandResult(JSON.stringify({
          id,
          type: "response",
          command: "ack_events",
          success: true,
          data: { acknowledgedCursor: 1 },
        }) + "\n"));
      }
      throw new Error(`unexpected broker command ${String(command.type)}`);
    }));
    const runtime = runtimeClient();

    await expect(runtime.dispatchPrompt({
      boxId: "bx_23456789",
      attemptId: "attempt-1",
      requestId: "prompt-1",
      message: "do work",
    })).resolves.toEqual({
      outcome: "accepted",
      attemptId: "attempt-1",
      invocationId: "invocation-1",
      initialCursor: 0,
    });
    await expect(runtime.brokerState({ boxId: "bx_23456789" })).resolves.toMatchObject({
      invocationId: "invocation-1",
      modelInput: ["text", "image"],
    });
    await expect(runtime.readEvents({ boxId: "bx_23456789", after: 0 })).resolves.toMatchObject({
      nextCursor: 1,
      acknowledgedCursor: 0,
      events: [expect.objectContaining({ sequence: 1, attemptId: "attempt-1" })],
    });
    await expect(runtime.ackEvents({ boxId: "bx_23456789", through: 1 })).resolves.toEqual({
      acknowledgedCursor: 1,
    });
    expect(commandTypes).toEqual(["prompt", "runtime_state", "read_events", "ack_events"]);
  });

  it("keeps a lost prompt acknowledgement ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("synthetic transport loss");
    }));
    await expect(runtimeClient().dispatchPrompt({
      boxId: "bx_23456789",
      attemptId: "attempt-ambiguous",
      message: "possibly written",
    })).resolves.toEqual({
      outcome: "ambiguous",
      code: "pi_ack_ambiguous",
      message: "Pi prompt acknowledgement is unavailable",
    });
  });

  it("sends exactly one abortable resume request without polling Box or Pi", async () => {
    const controller = new AbortController();
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => { commandStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/boxes/bx_23456789/resume") && init?.method === "POST") {
        commandStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const observation = runtime.resumeExistingBox({ boxId: "bx_23456789", signal: controller.signal });
    await started;
    const stopped = new Error("runtime handoff");
    controller.abort(stopped);

    await expect(observation).rejects.toBe(stopped);
  });

  it("propagates abort while reading broker state for Pi status", async () => {
    const controller = new AbortController();
    let brokerStarted!: () => void;
    const started = new Promise<void>((resolve) => { brokerStarted = resolve; });
    let commandCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/commands") && init?.method === "POST") {
        commandCount += 1;
        if (commandCount === 1) {
          return response({
            success: true,
            exitCode: 0,
            stdout: "active\ncompanion-pi-broker-ready\n",
            stderr: "",
          });
        }
        brokerStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      throw new Error(`unexpected Box request: ${init?.method ?? "GET"} ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const status = runtime.piDaemonStatus({ boxId: "bx_23456789", signal: controller.signal });
    await started;
    const stopped = new Error("runtime handoff");
    controller.abort(stopped);

    await expect(status).rejects.toBe(stopped);
  });
});

describe("provider Box lifecycle states", () => {
  it("maps every documented provider state and does not treat provisioned as ready", () => {
    expect(BOX_PROVIDER_STATES).toEqual([
      "init",
      "provisioning",
      "provisioned",
      "cloning",
      "ready",
      "idle",
      "running",
      "archiving",
      "archived",
      "error",
    ]);
    expect(observedBoxStateFromProvider("init")).toBe("initializing");
    expect(observedBoxStateFromProvider("provisioning")).toBe("provisioning");
    expect(observedBoxStateFromProvider("provisioned")).toBe("provisioning");
    expect(observedBoxStateFromProvider("cloning")).toBe("provisioning");
    expect(observedBoxStateFromProvider("ready")).toBe("ready");
    expect(observedBoxStateFromProvider("idle")).toBe("idle");
    expect(observedBoxStateFromProvider("running")).toBe("running");
    expect(observedBoxStateFromProvider("archiving")).toBe("archiving");
    expect(observedBoxStateFromProvider("archived")).toBe("archived");
    expect(observedBoxStateFromProvider("error")).toBe("error");
  });

  it("reads live GET box.info and resume box.resuming envelopes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({
          ok: true,
          type: "box.info",
          box: box("idle"),
        });
      }
      if (url.endsWith("/boxes/bx_23456789/resume") && method === "POST") {
        return response({
          ok: true,
          type: "box.resuming",
          box: box("ready"),
        }, 202);
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }));

    const runtime = runtimeClient();
    await expect(runtime.existingBoxStatus({ boxId: "bx_23456789" })).resolves.toEqual({
      boxId: "bx_23456789",
      state: "idle",
    });
  });

  it("rejects a durable Box id that does not belong to the expected Companion generation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      box: {
        ...box("archived"),
        name: "Companion 22222222-2222-4222-8222-222222222222 g1",
      },
    })));

    await expect(runtimeClient().existingBoxStatus({
      boxId: "bx_23456789",
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 1,
    })).rejects.toThrow("durable Box identity does not match");
  });
});

describe("bounded daemon diagnostics", () => {
  it("keeps a stable, one-line failure inside the persistence limit", () => {
    const detail = composeDaemonFailureDetail([
      "companion-pi-state failed",
      "companion-pi-status Active: failed (Result: exit-code)",
      "companion-pi-restarts 123456",
      `companion-pi-stderr ${"x".repeat(500)}`,
    ].join("\n"));
    expect(detail).not.toContain("\n");
    expect(`Pi daemon is not running after start${detail}`.length)
      .toBeLessThanOrEqual(COMPANION_RUNTIME_ERROR_MAX_LENGTH);
  });
});

function runtimeClient(): AsciiBoxCompanionRuntime {
  return new AsciiBoxCompanionRuntime({
    COMPANION_BOX_API_KEY: "box_test",
    COMPANION_BOX_POLL_INTERVAL_MS: "1",
    COMPANION_BOX_READY_TIMEOUT_MS: "100",
    COMPANION_BOX_DESKTOP_MINT_BUDGET_MS: "10",
  });
}

describe("default Pi packages on the Box disk", () => {
  const layoutCommands: Array<{ command: string; timeoutSeconds: number }> = [];
  const stagedFiles = new Map<string, string>();

  /** Stage a Box and hand back the layout script the adapter wrote to its disk. */
  async function stagedLayoutScript(
    env: Record<string, string> = {},
    mcpCredentials: Array<{ env_key: string; value: string }> = [],
    companionSkillChecksum?: string,
  ): Promise<string> {
    stagedFiles.clear();
    layoutCommands.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") return response({ box: box("ready") });
      if (url.endsWith("/files") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { path: string; content: string };
        stagedFiles.set(body.path, body.content);
        if (body.path.endsWith("control-bundle-v1.json")) {
          const bundle = JSON.parse(body.content) as {
            files: Array<{ path: string; content: string }>;
          };
          for (const file of bundle.files) {
            stagedFiles.set(file.path, Buffer.from(file.content, "base64").toString("utf8"));
          }
        }
        return response({ ok: true });
      }
      if (url.endsWith("/commands") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          command: string;
          timeoutSeconds: number;
        };
        if (body.command.includes("ensure-pi-layout.sh") || body.command.includes("git-credential-github")) {
          layoutCommands.push(body);
        }
        return response(commandResult("companion-box-runnable\n"));
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    }));

    await new AsciiBoxCompanionRuntime(
      { COMPANION_BOX_API_KEY: "box_test", ...env },
      companionSkillChecksum ? { companionSkillChecksum } : undefined,
    )
      .stageExistingBox({
        companionId: "11111111-1111-4111-8111-111111111111",
        runtimeGeneration: 1,
        orgId: "22222222-2222-4222-8222-222222222222",
        boxId: "bx_23456789",
        clientSurface: "web",
        providerAuth: {},
        replaceProviderAuth: false,
        modelId: "glm-4.6",
        mcpCredentials,
        mcpAccounts: [],
        skills: [],
      });
    const script = stagedFiles.get(".companion/bin/ensure-pi-layout.sh");
    if (!script) throw new Error("staging did not write the Pi layout script");
    return script;
  }

  it("rebuilds a requested reusable Skill tree when its archive checksum marker is stale", async () => {
    const stagedPaths: string[] = [];
    const commands: string[] = [];
    const runtime = runtimeClient();
    const layoutMarker = runtime.layoutIdentity().fullMarker;
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const method = init?.method ?? "GET";
      if (url.endsWith("/boxes/bx_23456789") && method === "GET") {
        return response({ box: box("ready") });
      }
      if (url.endsWith("/files") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { path: string };
        stagedPaths.push(body.path);
        return response({ ok: true });
      }
      if (url.endsWith("/commands") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { command: string };
        commands.push(body.command);
        if (body.command.includes("pi-layout.version")) return response(commandResult(`${layoutMarker}\n`));
        return response(commandResult("companion-box-runnable\n"));
      }
      throw new Error(`unexpected Box request: ${method} ${url}`);
    }));

    const staged = await runtime.stageExistingBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 1,
      orgId: "22222222-2222-4222-8222-222222222222",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: {},
      replaceProviderAuth: false,
      modelId: "glm-4.6",
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [{
        slug: "companion",
        version: "1.0.0",
        checksum: `sha256:${"1".repeat(64)}`,
        archive: Buffer.from("updated-companion-skill"),
      }],
      reuseSkills: true,
    });

    expect(staged.stagingMode).toBe("skills");
    expect(stagedPaths).toContain(
      ".companion/runtime/state/skill-archives/companion.tar.gz.b64",
    );
    expect(commands.some((command) => command.includes("skills-tree.version.next"))).toBe(true);
  });

  it("installs the pinned default set beside the adapter, and qmd without being able to fail", async () => {
    const script = await stagedLayoutScript();

    expect(script).toContain('> "$HOME/.boxignore"');
    const encodedBoxIgnore = /printf '%s' '([^']+)' \| base64 --decode > "\$HOME\/\.boxignore"/
      .exec(script)?.[1];
    expect(encodedBoxIgnore).toBeTruthy();
    expect(Buffer.from(encodedBoxIgnore!, "base64").toString("utf8"))
      .toContain(".companion/runtime/state/control-bundle-v1.json");

    for (const spec of [
      "npm:pi-mcp-adapter@2.12.1",
      "npm:pi-web-access@0.24.0",
      "npm:pi-subagents@0.51.0",
      "npm:pi-memory@0.4.2",
    ]) {
      expect(script).toContain(`"$pi_bin" install '${spec}'`);
    }
    // Semantic search is an optimization for memory, so its install may not end a staging: it runs
    // outside `set -e` and reports on stdout, which Box does not promote to a setup failure.
    expect(script).toContain(
      `npm install --global --prefix "$HOME/.companion/tools" '@tobilu/qmd@2.8.3'`,
    );
    expect(script).toMatch(/set \+e\nnpm install --global/);
    expect(script).not.toMatch(/npm install --global[^\n]*>&2/);
    // Memory has to survive one Pi restart and one Box wake, so it lives on the persistent disk.
    expect(script).toContain('export PI_MEMORY_DIR="$root/memory"');
    // Jiti's compiled extension cache must survive /tmp being discarded on archive/resume, and the
    // image bake pre-populates it once instead of charging the first user message.
    expect(script).toContain('export TMPDIR="$root/tmp"');
    expect(script).toContain("export JITI_RESPECT_TMPDIR_ENV=1");
    expect(script).toContain('timeout 90 "$pi_bin" --help');
    expect(script).toContain("pi-startup-cache.version");
    expect(script).toContain('!= "$expected_layout"');
    expect(script).toContain('\"$expected_layout\" > \"$startup_cache_marker\"');
    // Appended, not prepended: the resolved Pi directory stays ahead of the optional prefix.
    expect(script).toContain('PATH="$PATH:$HOME/.companion/tools/bin"');
    expect(script).toContain('if [ ! -x "$NODE_BIN" ]; then');
    expect(script).toContain('NODE_BIN="$(command -v node 2>/dev/null || true)"');
    // npm's own words never reach stdout, which is what the control plane falls back to for the
    // reason a later step failed.
    expect(script).not.toContain("awk 'NF { line=$0 } END { print line }' \"$qmd_log\"");
  });

  it("is a script bash can parse, with and without the optional install", async () => {
    // The layout script is generated from a template literal, so no shell linter in CI ever sees
    // it. A quoting slip in it is a Box that fails every staging, which is every message.
    const variants: Array<Record<string, string>> = [
      {},
      { COMPANION_PI_INSTALL_COMMAND: "curl -fsSL https://pi.test/install | bash" },
    ];
    for (const env of variants) {
      const script = await stagedLayoutScript(env);
      const parsed = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      expect(parsed.stderr).toBe("");
      expect(parsed.status).toBe(0);
    }
  });

  it("gives the relayout longer than a turn's own cold start, so the install is never lost", async () => {
    await stagedLayoutScript();

    // The marker is written only after the install finishes. A budget that stops it short is a Box
    // that repeats the same work on every wake and can never record it.
    expect(layoutCommands).toEqual([
      expect.objectContaining({ timeoutSeconds: 300 }),
    ]);
  });

  it("stages a GitHub git credential helper only when a GitHub token is present", async () => {
    await stagedLayoutScript();
    expect(stagedFiles.get(".companion/bin/git-credential-github")).toBeUndefined();

    await stagedLayoutScript({}, [{ env_key: "GITHUB_TOKEN", value: "gho_test_token" }]);
    const helper = stagedFiles.get(".companion/bin/git-credential-github");
    expect(helper).toContain("protocol=https");
    expect(helper).toContain("host=github.com");
    expect(helper).toContain("$GITHUB_TOKEN");
    expect(helper).not.toContain("gho_test_token");
    expect(layoutCommands.some((command) => command.command.includes("credential.helper"))).toBe(true);
  });

  it("makes every pin part of the layout marker, so an existing Box relayouts on its next wake", async () => {
    // The marker is the whole update system: changing a pin is what a Box holding the old one
    // cannot short-circuit past. Overlay is hashed separately so a broker change does not reinstall
    // packages.
    const identity = companionPiLayoutIdentity({
      layoutVersion: 14,
      packages: resolvePiPackages({}),
      qmdPackage: "@tobilu/qmd@2.8.3",
      minimumPiVersion: "0.84.2",
    });
    const script = await stagedLayoutScript();
    expect(script).toContain(`base_layout='${identity.baseMarker}'`);
    expect(script).toContain(`expected_layout='${identity.fullMarker}'`);
    expect(script).toContain("companion-layout-unchanged");
    expect(script).toContain("companion-layout-overlay");
    expect(script).toContain("companion-layout-base");
    expect(script.indexOf("companion-layout-overlay"))
      .toBeLessThan(script.indexOf(`"$pi_bin" install`));
  });

  it("writes the baked Companion skill checksum into the installed broker marker", async () => {
    const checksum = "sha256:companion-skill-contract";
    const script = await stagedLayoutScript({}, [], checksum);
    expect(script).toContain(`:skill=${checksum}:boot=`);
    expect(script).not.toContain(":skill=none:boot=");
  });

  it("gives a deployment no way to drop what a Companion can do", async () => {
    // Web access, delegation, and memory are the Companion, not a deployment setting. The only pin
    // an environment can still move is the MCP adapter, which was configurable before any of this.
    const script = await stagedLayoutScript({
      COMPANION_PI_DEFAULT_PACKAGES: "none",
      COMPANION_PI_QMD_PACKAGE: "none",
    });

    for (const spec of [
      "npm:pi-web-access@0.24.0",
      "npm:pi-subagents@0.51.0",
      "npm:pi-memory@0.4.2",
    ]) {
      expect(script).toContain(`"$pi_bin" install '${spec}'`);
    }
    expect(script).toContain("npm install --global");
    expect(script).not.toContain("qmd=none");
    expect(resolvePiPackages({ COMPANION_PI_DEFAULT_PACKAGES: "none" }))
      .toEqual(resolvePiPackages({}));
  });

  it("refuses an adapter specification that is not a package name", () => {
    for (const spec of ["npm:pi-memory@0.4.2; rm -rf /", "$(id)", "pi memory", "a".repeat(201)]) {
      expect(() => new AsciiBoxCompanionRuntime({
        COMPANION_BOX_API_KEY: "box_test",
        COMPANION_PI_MCP_ADAPTER_PACKAGE: spec,
      })).toThrow(BoxRuntimeConfigurationError);
    }
    // A deployment that pinned a range before this existed keeps working.
    expect(resolvePiPackages({ COMPANION_PI_MCP_ADAPTER_PACKAGE: "npm:pi-mcp-adapter@^2.12.1" })[0])
      .toBe("npm:pi-mcp-adapter@^2.12.1");
  });
});

describe("staged Companion instructions", () => {
  it("always tells Pi how to show an image, with or without a persona", () => {
    expect(composedInstructions("Answer briefly.")).toContain(COMPANION_OUTBOX_INSTRUCTIONS);
    expect(composedInstructions(null)).toContain(COMPANION_OUTBOX_INSTRUCTIONS);
    expect(composedInstructions("   ")).toContain(COMPANION_OUTBOX_INSTRUCTIONS);
    expect(composedInstructions("   ")).not.toContain("# This Companion");
  });

  it("places a persona exactly once, in the trailing section, and omits that section when absent", () => {
    const persona = "Answer briefly.";
    const withPersona = composedInstructions(persona);
    expect(withPersona.endsWith(`# This Companion\n\n${persona}\n`)).toBe(true);
    expect(withPersona.indexOf(persona)).toBe(withPersona.lastIndexOf(persona));
    expect(composedInstructions(null)).not.toContain("# This Companion");
    expect(composedInstructions(undefined)).not.toContain("# This Companion");
  });

  it("includes Skills Hub and the config catalog on web and mobile_web, not on native_mobile", () => {
    for (const surface of ["web", "mobile_web"] as const) {
      const text = composedInstructions(null, surface);
      expect(text).toContain("Skills Hub");
      expect(text).toContain("config-catalog.json");
      expect(text).toContain("- Plugins:");
      expect(text).toContain("- Routines:");
      expect(text).toContain(COMPANION_OUTBOX_INSTRUCTIONS);
      expect(text).toContain("ask_user");
      expect(text).toContain("propose_config");
      expect(text).toContain("propose_routine");
    }
    const native = composedInstructions(null, "native_mobile");
    expect(native).not.toContain("Skills Hub");
    expect(native).not.toContain("config-catalog.json");
    expect(native).not.toContain("- Plugins:");
    expect(native).not.toContain("- Skills:");
    expect(native).toContain("- Routines:");
    expect(native).toContain(COMPANION_OUTBOX_INSTRUCTIONS);
    expect(native).toContain("ask_user");
    expect(native).toContain("propose_config");
    expect(native).toContain("propose_routine");
  });

  it("interpolates tool-run timeout constants rather than literals", () => {
    const text = composedInstructions();
    expect(text).toContain(
      `stopped after ${COMPANION_TOOL_RUN_TIMEOUT_MS / 1_000} seconds, or ${COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS / 60_000} minutes for shell commands and subagents`,
    );
    expect(text).toContain(
      `At most ${COMPANION_ROUTINE_MAX_PER_COMPANION} per Companion, at least ${COMPANION_ROUTINE_MIN_INTERVAL_MS / 60_000} minutes apart.`,
    );
  });

  it("does not tell Pi that memory is wiped or that tool runs are invisible", () => {
    const text = composedInstructions();
    expect(text).toContain("~/.companion/runtime/memory");
    expect(text).toContain("Staging does not wipe it.");
    expect(text).toContain("~/.companion/pi and ~/.companion/runtime/state");
    expect(text).not.toContain("The person does not see your tool calls");
    expect(text).not.toContain("or your reasoning");
    expect(text).toContain("compact cards for each tool run");
    expect(text).toContain("collapsible block");
  });
});

describe("Pi outbox manifest", () => {
  const digest = "a".repeat(64);

  function manifest(...lines: string[]): string {
    return [
      "companion-outbox-manifest-begin",
      ...lines,
      "companion-outbox-manifest-end",
      "",
    ].join("\n");
  }

  it("reads one entry per file and decodes its name", () => {
    const encoded = Buffer.from("plot 1.png", "utf8").toString("base64");
    expect(parseOutboxManifest(manifest(`${digest} 2048 ${encoded}`))).toEqual([{
      name: "plot 1.png",
      encodedName: encoded,
      byteSize: 2048,
      sha256: digest,
    }]);
  });

  it("ignores a shell banner outside the sentinels rather than reading it as content", () => {
    const encoded = Buffer.from("ok.png", "utf8").toString("base64");
    const stdout = ["motd: welcome", manifest(`${digest} 10 ${encoded}`), "bye"].join("\n");
    expect(parseOutboxManifest(stdout)).toHaveLength(1);
  });

  it("drops a line it cannot parse and a name that could escape the outbox", () => {
    expect(parseOutboxManifest(manifest(
      "not a manifest line",
      `${digest} 10 ${Buffer.from("../escape.png", "utf8").toString("base64")}`,
      `${digest} 10 ${Buffer.from("nested/deep.png", "utf8").toString("base64")}`,
    ))).toEqual([]);
  });

  it("reports a zero-byte file rather than hiding it", () => {
    // Dropping it here would make a failed or truncated Pi write invisible to everyone. The
    // harvester filters it and counts it as a shortfall instead.
    expect(parseOutboxManifest(manifest(
      `${digest} 0 ${Buffer.from("empty.png", "utf8").toString("base64")}`,
    ))).toEqual([expect.objectContaining({ name: "empty.png", byteSize: 0 })]);
  });

  it("refuses a response whose sentinels are missing", () => {
    expect(() => parseOutboxManifest("companion-outbox-manifest-begin\n")).toThrow(
      BoxRuntimeProviderError,
    );
  });
});

describe("Pi outbox transfer", () => {
  const bytes = Buffer.from("a PNG that spans more than one chunk".repeat(40), "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const encodedName = Buffer.from("plot.png", "utf8").toString("base64");

  function stubOutboxTransport(
    options: { truncateChunkTo?: number; timeouts?: number[] } = {},
  ) {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (!url.endsWith("/commands")) throw new Error(`unexpected Box request: ${url}`);
      const sent = JSON.parse(String(init?.body)) as { command: string; timeoutSeconds: number };
      const command = sent.command;
      commands.push(command);
      options.timeouts?.push(sent.timeoutSeconds);
      const chunk = /bs=(\d+)/.exec(command);
      const skip = /skip=(\d+)/.exec(command);
      if (!chunk?.[1] || !skip?.[1]) throw new Error("not a chunk read");
      const size = Number(chunk[1]);
      const slice = bytes.subarray(Number(skip[1]) * size, (Number(skip[1]) + 1) * size);
      const body = options.truncateChunkTo === undefined
        ? slice
        : slice.subarray(0, options.truncateChunkTo);
      return response(commandResult([
        "companion-outbox-chunk-begin",
        body.toString("base64"),
        "companion-outbox-chunk-end",
        "",
      ].join("\n")));
    }));
    return commands;
  }

  it("reassembles a file from its chunks and proves it against the manifest digest", async () => {
    stubOutboxTransport();
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const file = await runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "plot.png", encodedName, byteSize: bytes.byteLength, sha256: digest },
    });

    expect(file.bytes.equals(bytes)).toBe(true);
  });

  it("gives up on a file whose chunks keep arriving truncated instead of storing them", async () => {
    // The command transport has a demonstrated habit of mangling large bodies. A short chunk still
    // decodes as valid base64, so only the whole-file digest catches it.
    const commands = stubOutboxTransport({ truncateChunkTo: 16 });
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "plot.png", encodedName, byteSize: bytes.byteLength, sha256: digest },
    })).rejects.toThrow(BoxRuntimeProviderError);
    expect(commands.length).toBeGreaterThan(0);
  });

  it("never lets a Pi-chosen filename reach a shell", async () => {
    const commands = stubOutboxTransport();
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });
    const hostile = Buffer.from("a\"; rm -rf ~; echo \".png", "utf8").toString("base64");

    await runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "ignored", encodedName: hostile, byteSize: bytes.byteLength, sha256: digest },
    }).catch(() => undefined);

    // The command carries the name as base64 and decodes it on the Box, so nothing quotable travels.
    expect(commands[0]).toContain(hostile);
    expect(commands[0]).not.toContain("rm -rf ~");
  });

  it("recovers a chunk that arrives mangled once, without abandoning the file", async () => {
    // Truncation is the transport's known failure mode, and a short chunk still decodes as valid
    // base64 -- so the retry has to be driven by the whole-file digest, and it has to actually retry.
    let firstChunkReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const command = (JSON.parse(String(init?.body)) as { command: string }).command;
      const size = Number(/bs=(\d+)/.exec(command)![1]);
      const skip = Number(/skip=(\d+)/.exec(command)![1]);
      const slice = bytes.subarray(skip * size, (skip + 1) * size);
      const mangled = skip === 0 && ++firstChunkReads === 1;
      return response(commandResult([
        "companion-outbox-chunk-begin",
        (mangled ? slice.subarray(0, 8) : slice).toString("base64"),
        "companion-outbox-chunk-end",
        "",
      ].join("\n")));
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const file = await runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "plot.png", encodedName, byteSize: bytes.byteLength, sha256: digest },
    });

    expect(file.bytes.equals(bytes)).toBe(true);
    expect(firstChunkReads).toBe(2);
  });

  it("stops reading once the harvest budget is spent", async () => {
    // The budget has to bound the retries, not just the gaps between chunks: three 120s command
    // attempts on one hung chunk would otherwise hold a settled turn far past it.
    const commands = stubOutboxTransport();
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "plot.png", encodedName, byteSize: bytes.byteLength, sha256: digest },
      deadlineAt: new Date(Date.now() - 1),
    })).rejects.toThrow(BoxRuntimeProviderError);
    expect(commands).toHaveLength(0);
  });

  it("shrinks a read's own timeout to what is left of the budget", async () => {
    // Checking the deadline between attempts is not enough: an attempt that starts one second inside
    // it would still run a 120s command, so a hung read holds the settled turn -- and its
    // "replying..." state -- two minutes past the bound the caller derived from its lease authority.
    const timeouts: number[] = [];
    stubOutboxTransport({ timeouts });
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "plot.png", encodedName, byteSize: bytes.byteLength, sha256: digest },
      deadlineAt: new Date(Date.now() + 8_000),
    });

    expect(timeouts.length).toBeGreaterThan(0);
    for (const timeout of timeouts) expect(timeout).toBeLessThanOrEqual(8);
  });

  it("refuses an entry whose encoded name is not base64", async () => {
    stubOutboxTransport();
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.readOutboxFile({
      boxId: "bx_23456789",
      entry: { name: "x", encodedName: "not base64!", byteSize: 1, sha256: digest },
    })).rejects.toThrow(BoxRuntimeProviderError);
  });
});

describe("Pi outbox maintenance", () => {
  function stubCommands(result: { success: boolean } = { success: true }) {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (!url.endsWith("/commands")) throw new Error(`unexpected Box request: ${url}`);
      commands.push((JSON.parse(String(init?.body)) as { command: string }).command);
      return result.success
        ? response(commandResult())
        : response({ success: false, exitCode: 1, stdout: "", stderr: "refused" });
    }));
    return commands;
  }

  it("creates the outbox and empties it, so a harvest can only find this turn's files", async () => {
    const commands = stubCommands();
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await runtime.clearOutbox({ boxId: "bx_23456789" });

    // mkdir before delete: a Box provisioned before the outbox existed gains it here rather than
    // needing a forced restage.
    expect(commands[0]).toContain('mkdir -p "$dir"');
    expect(commands[0]).toContain('find "$dir" -mindepth 1 -delete');
  });

  it("fails loudly when the Box will not empty its outbox", async () => {
    stubCommands({ success: false });
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.clearOutbox({ boxId: "bx_23456789" }))
      .rejects.toThrow(BoxRuntimeProviderError);
  });

  it("fails loudly when the Box will not list its outbox", async () => {
    stubCommands({ success: false });
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await expect(runtime.listOutbox({ boxId: "bx_23456789" }))
      .rejects.toThrow(BoxRuntimeProviderError);
  });
});

describe("staged Companion attachments", () => {
  it("replaces the message directory, writes each file, and makes them read-only", async () => {
    const commands: string[] = [];
    const files: Array<{ path: string; encoding?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith("/commands")) {
        commands.push(body.command as string);
        return response(commandResult());
      }
      if (url.endsWith("/files")) {
        files.push({ path: body.path as string, encoding: body.encoding as string | undefined });
        return response({ ok: true });
      }
      throw new Error(`unexpected Box request: ${url}`);
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    const staged = await runtime.stageAttachments({
      boxId: "bx_23456789",
      messageId: "66666666-6666-4666-8666-666666666666",
      files: [{
        position: 0,
        filename: "chart.png",
        contentType: "image/png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }],
    });

    expect(staged).toEqual([{
      position: 0,
      filename: "chart.png",
      contentType: "image/png",
      byteSize: 4,
      path: "~/attachments/66666666-6666-4666-8666-666666666666/0-chart.png",
    }]);
    // The whole staging root is replaced, so a previous message's files cannot accumulate.
    expect(commands[0]).toContain("rm -rf 'attachments'");
    expect(commands[0]).toContain("mkdir -p 'attachments/66666666-6666-4666-8666-666666666666'");
    expect(commands.at(-1)).toContain("chmod a-w");
    // Binary bytes cannot travel as a UTF-8 body, so the write is base64 whatever its size.
    expect(files).toEqual([{
      path: "attachments/66666666-6666-4666-8666-666666666666/0-chart.png",
      encoding: "base64",
    }]);
  });

  it("sends a payload whose base64 body would exceed the write limit as numbered parts", async () => {
    // The provider's limit is on the request body, and base64 is four bytes per three. A 4 MB
    // attachment is under the raw limit but over it once encoded, so it must take the parts path.
    const files: string[] = [];
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith("/commands")) {
        commands.push(body.command as string);
        return response(commandResult());
      }
      files.push(body.path as string);
      // Nothing this adapter sends may exceed the provider's body limit once encoded.
      expect((body.content as string).length).toBeLessThan(5 * 1024 * 1024);
      return response({ ok: true });
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await runtime.stageAttachments({
      boxId: "bx_23456789",
      messageId: "66666666-6666-4666-8666-666666666666",
      files: [{
        position: 0,
        filename: "big.png",
        contentType: "image/png",
        bytes: Buffer.alloc(4 * 1024 * 1024, 7),
      }],
    });

    expect(files.filter((path) => path.includes(".part"))).not.toHaveLength(0);
    expect(commands.some((command) => command.includes("cat ") && command.includes(".part0")))
      .toBe(true);
  });

  it("locks the files without locking the directory it must clear on the next stage", async () => {
    const commands: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith("/commands")) {
        commands.push(body.command as string);
        return response(commandResult());
      }
      return response({ ok: true });
    }));
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });

    await runtime.stageAttachments({
      boxId: "bx_23456789",
      messageId: "66666666-6666-4666-8666-666666666666",
      files: [{
        position: 0,
        filename: "chart.png",
        contentType: "image/png",
        bytes: Buffer.from([0x89, 0x50]),
      }],
    });

    // A recursive chmod would clear the directory's own write bit, and unlinking an entry needs
    // write on its directory -- so the next retry's `rm -rf` would fail and the message would
    // become permanently unsendable on a non-root Box user.
    const lock = commands.at(-1)!;
    expect(lock).toContain("-type f -exec chmod a-w");
    expect(lock).not.toContain("chmod -R a-w");
    // The staging root is replaced, so an earlier message's files cannot accumulate on the disk.
    expect(commands[0]).toContain("rm -rf 'attachments'");
  });

  it("refuses a message id or filename outside the stored charset", async () => {
    const runtime = new AsciiBoxCompanionRuntime({ COMPANION_BOX_API_KEY: "box_test" });
    const file = {
      position: 0,
      filename: "chart.png",
      contentType: "image/png",
      bytes: Buffer.alloc(1),
    };

    await expect(runtime.stageAttachments({
      boxId: "bx_23456789",
      messageId: "../escape",
      files: [file],
    })).rejects.toThrow(BoxRuntimeProviderError);
    await expect(runtime.stageAttachments({
      boxId: "bx_23456789",
      messageId: "66666666-6666-4666-8666-666666666666",
      files: [{ ...file, filename: "../escape.png" }],
    })).rejects.toThrow(BoxRuntimeProviderError);
  });
});

function box(state: "archived" | "ready" | "archiving" | "idle") {
  return {
    id: "bx_23456789",
    name: "Companion 11111111-1111-4111-8111-111111111111 g1",
    state,
    desktopAvailable: state === "ready",
    setupStatus: "done",
  };
}

function commandResult(stdout = "") {
  return { success: true, exitCode: 0, stdout, stderr: "" };
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function decodeBrokerCommand(command: string): Record<string, unknown> {
  const encoded = /COMPANION_PI_BROKER_COMMAND='([A-Za-z0-9+/=]+)'/.exec(command)?.[1];
  if (!encoded) throw new Error("adapter did not send a layout-14 broker command");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
}

function zeroCounters() {
  return {
    malformedLines: 0,
    oversizedLines: 0,
    unterminatedLines: 0,
    unknownEvents: 0,
    unboundEvents: 0,
    orphanResponses: 0,
  };
}
