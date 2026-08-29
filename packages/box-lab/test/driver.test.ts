import { describe, expect, it } from "vitest";

import { BoxLabSourceUnavailableError } from "../src/driver";
import { BOX_LAB_LIMA_CONFIG, LimaDriver } from "../src/limaDriver";
import { evaluateCgroupV2Domain, OciSystemdDriver } from "../src/ociSystemdDriver";
import type { ProcessInvocation, ProcessResult, ProcessRunner } from "../src/process";

const success: ProcessResult = {
  exitCode: 0,
  signal: null,
  stdout: "ok\n",
  stderr: "",
  timedOut: false,
};

class RecordingRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];

  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.calls.push(invocation);
    return success;
  }
}

class ScriptedRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];
  readonly #steps: Array<ProcessResult | Error>;

  constructor(steps: Array<ProcessResult | Error>) {
    this.#steps = [...steps];
  }

  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.calls.push(invocation);
    const step = this.#steps.shift();
    if (!step) throw new Error("Scripted process runner was exhausted");
    if (step instanceof Error) throw step;
    return step;
  }
}

function ociDriver(runner: ProcessRunner, engine: "docker" | "podman" = "docker"): OciSystemdDriver {
  return new OciSystemdDriver({
    runner,
    engine,
    image: "companion-box-lab-systemd:test-0123456789ab",
    resourcePrefix: "companion-box-lab-test-0123456789ab",
    workspaceScope: "test-0123456789ab",
  });
}

describe("OCI systemd driver", () => {
  it("passes hostile Box text as one contained argv and never asks for a host shell", async () => {
    const runner = new RecordingRunner();
    const prefix = "companion-box-lab-test-0123456789ab";
    const driver = new OciSystemdDriver({
      runner,
      engine: "docker",
      image: "companion-box-lab-systemd:test-0123456789ab",
      resourcePrefix: prefix,
      workspaceScope: "test-0123456789ab",
    });
    const resourceName = `${prefix}-bx_23456789`;
    const hostile = "printf safe; touch /tmp/inside-box; $(touch /tmp/still-inside-box)";

    await driver.execute({ resourceName, command: hostile, timeoutSeconds: 12 });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ executable: "docker" });
    expect(runner.calls[0]!.args).toEqual([
      "exec", "--workdir", "/home/user", "--user", "user",
      "--env", "HOME=/home/user", "--env", "USER=user", "--env", "SHELL=/bin/bash",
      resourceName,
      "timeout", "--signal=TERM", "--kill-after=5s", "12s",
      "bash", "--noprofile", "--norc", "-c", expect.stringContaining("status=$?"),
      "box-lab-command", `umask 0022\n${hostile}`,
    ]);
    expect(runner.calls[0]!.args.at(-3)).not.toContain(hostile);
    expect(runner.calls[0]).toMatchObject({ captureGuestCommandControl: true });
    expect(runner.calls[0]!.env).toBeUndefined();
    expect(runner.calls[0]!.args.some((argument) => /^[a-f0-9]{64}$/.test(argument))).toBe(false);
    expect("shell" in runner.calls[0]!).toBe(false);
  });

  it("keeps a completed guest exit 124 distinct from an actual timeout", async () => {
    const runner = new RecordingRunner();
    runner.run = async (invocation) => {
      runner.calls.push(invocation);
      return {
        ...success,
        exitCode: 124,
        stdout: "guest-output\n",
        stderr: "guest-error\n",
        guestCommandControl: { started: true, completedExitCode: 124 },
      };
    };
    const driver = ociDriver(runner);
    const resourceName = "companion-box-lab-test-0123456789ab-bx_23456789";

    await expect(driver.execute({ resourceName, command: "exit 124", timeoutSeconds: 12 }))
      .resolves.toEqual({
        success: false,
        exitCode: 124,
        stdout: "guest-output\n",
        stderr: "guest-error\n",
        timedOut: false,
      });

    const timedOutRunner = new ScriptedRunner([{
      ...success,
      exitCode: 124,
      stdout: "partial output\n",
      stderr: "",
    }]);
    const timedOutDriver = ociDriver(timedOutRunner);
    await expect(timedOutDriver.execute({ resourceName, command: "sleep 30", timeoutSeconds: 1 }))
      .resolves.toMatchObject({ success: false, exitCode: null, timedOut: true });
  });

  it("does not accept an unmatched control completion as proof of guest exit 124", async () => {
    const runner = new RecordingRunner();
    runner.run = async (invocation) => {
      runner.calls.push(invocation);
      return {
        ...success,
        exitCode: 124,
        stderr: "guest-controlled lookalike",
        guestCommandControl: { started: true, completedExitCode: null },
      };
    };
    const driver = ociDriver(runner);

    await expect(driver.execute({
      resourceName: "companion-box-lab-test-0123456789ab-bx_23456789",
      command: "exit 124",
      timeoutSeconds: 12,
    })).resolves.toMatchObject({
      success: false,
      exitCode: null,
      timedOut: true,
    });
  });

  it("rejects resource names from another workspace before process execution", async () => {
    const runner = new RecordingRunner();
    const driver = new OciSystemdDriver({
      runner,
      engine: "docker",
      image: "companion-box-lab-systemd:test",
      resourcePrefix: "companion-box-lab-owned-0123456789ab",
      workspaceScope: "owned-0123456789ab",
    });

    await expect(driver.delete("companion-box-lab-other-bx_23456789"))
      .rejects.toThrow(/outside this workspace scope/);
    expect(runner.calls).toEqual([]);
  });

  it.each([
    {
      label: "a Docker container",
      engine: "docker" as const,
      target: "container" as const,
      stderr: "Error response from daemon: No such container: companion-box-lab-test-0123456789ab-bx_23456789\n",
    },
    {
      label: "a Docker snapshot image with its implicit tag",
      engine: "docker" as const,
      target: "snapshot" as const,
      stderr: "Error response from daemon: No such image: companion-box-lab-test-0123456789ab-snapshot-ready:latest\n",
    },
    {
      label: "a Podman snapshot image",
      engine: "podman" as const,
      target: "snapshot" as const,
      stderr: "Error: companion-box-lab-test-0123456789ab-snapshot-ready: image not known\n",
    },
  ])("treats an explicit missing $label as an idempotent deletion", async ({ engine, target, stderr }) => {
    const runner = new ScriptedRunner([{ ...success, exitCode: 1, stdout: "", stderr }]);
    const driver = ociDriver(runner, engine);

    if (target === "container") {
      await expect(driver.delete("companion-box-lab-test-0123456789ab-bx_23456789"))
        .resolves.toBeUndefined();
    } else {
      await expect(driver.deleteSnapshot("companion-box-lab-test-0123456789ab-snapshot-ready"))
        .resolves.toBeUndefined();
    }

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.args.slice(0, 2)).toEqual([
      target === "container" ? "container" : "image",
      "inspect",
    ]);
  });

  it.each([
    {
      label: "a timeout",
      result: { ...success, exitCode: null, stdout: "", stderr: "", timedOut: true },
      code: "process_timeout",
    },
    {
      label: "a permission error",
      result: { ...success, exitCode: 1, stdout: "", stderr: "permission denied" },
      code: "process_permission_denied",
    },
    {
      label: "an unavailable daemon",
      result: { ...success, exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" },
      code: "process_unavailable",
    },
    {
      label: "an invalid inventory failure",
      result: { ...success, exitCode: 125, stdout: "", stderr: "invalid inspect response" },
      code: "process_failed",
    },
  ])("does not mistake $label for an absent container", async ({ result, code }) => {
    const runner = new ScriptedRunner([result]);
    const driver = ociDriver(runner);

    await expect(driver.delete("companion-box-lab-test-0123456789ab-bx_23456789"))
      .rejects.toMatchObject({ name: "ProcessExecutionError", code });
    expect(runner.calls).toHaveLength(1);
  });

  it("does not swallow ProcessRunner failures while inspecting a snapshot", async () => {
    const runner = new ScriptedRunner([new Error("process runner failed")]);
    const driver = ociDriver(runner);

    await expect(driver.deleteSnapshot("companion-box-lab-test-0123456789ab-snapshot-ready"))
      .rejects.toThrow("process runner failed");
    expect(runner.calls).toHaveLength(1);
  });

  it("accepts an explicit disappearance between container inspection and removal", async () => {
    const resourceName = "companion-box-lab-test-0123456789ab-bx_23456789";
    const runner = new ScriptedRunner([
      success,
      {
        ...success,
        exitCode: 1,
        stdout: "",
        stderr: `Error response from daemon: No such container: ${resourceName}\n`,
      },
    ]);
    const driver = ociDriver(runner);

    await expect(driver.delete(resourceName)).resolves.toBeUndefined();
    expect(runner.calls.map((call) => call.args[0])).toEqual(["container", "rm"]);
  });

  it("force-removes a snapshot image that may still be referenced by a clone", async () => {
    const snapshot = "companion-box-lab-test-0123456789ab-snapshot-ready";
    const runner = new ScriptedRunner([success, success]);
    const driver = ociDriver(runner);

    await expect(driver.deleteSnapshot(snapshot)).resolves.toBeUndefined();
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["image", "inspect", snapshot],
      ["image", "rm", "--force", snapshot],
    ]);
  });

  it("resets only resources carrying the exact workspace label", async () => {
    const runner = new RecordingRunner();
    runner.run = async (invocation) => {
      runner.calls.push(invocation);
      if (invocation.args[0] === "ps") return { ...success, stdout: "container-a\ncontainer-b\n" };
      if (invocation.args[0] === "images") return { ...success, stdout: "image-a\n" };
      return success;
    };
    const driver = new OciSystemdDriver({
      runner,
      engine: "docker",
      image: "companion-box-lab-systemd:test",
      resourcePrefix: "companion-box-lab-owned-0123456789ab",
      workspaceScope: "owned-0123456789ab",
    });

    await driver.reset();

    expect(runner.calls[0]!.args).toContain("label=dev.companion.box-lab.workspace=owned-0123456789ab");
    expect(runner.calls.some((call) => call.args.includes("prune"))).toBe(false);
    expect(runner.calls.filter((call) => call.args[0] === "rm").map((call) => call.args.at(-1)))
      .toEqual(["container-a", "container-b"]);
  });

  it("fails immediately with a safe diagnostic when systemd exits before readiness", async () => {
    const readinessFailure = {
      ...success,
      exitCode: 1,
      stdout: "",
      stderr: "provider-token-that-must-not-leak",
    };
    const runner = new ScriptedRunner([
      success,
      success,
      readinessFailure,
      { ...success, stdout: "false 255\n" },
    ]);
    const driver = ociDriver(runner);
    const resourceName = "companion-box-lab-test-0123456789ab-bx_23456789";

    const creation = driver.create(resourceName);

    await expect(creation).rejects.toMatchObject({
      name: "ProcessExecutionError",
      code: "systemd_container_exited",
      message: "Box Lab systemd container exited before readiness (exit 255)",
    });
    await expect(creation).rejects.not.toThrow(/provider-token/);
    expect(runner.calls.map((call) => call.args[0])).toEqual([
      "image",
      "run",
      "exec",
      "container",
    ]);
  });

  it("turns readiness inspection failures into stable diagnostics", async () => {
    const runner = new ScriptedRunner([
      success,
      { ...success, exitCode: 1, stdout: "", stderr: "not ready" },
      new Error("host path and secret must stay private"),
    ]);
    const driver = ociDriver(runner);

    await expect(driver.start("companion-box-lab-test-0123456789ab-bx_23456789"))
      .rejects.toMatchObject({
        name: "ProcessExecutionError",
        code: "process_unavailable",
        message: "Box Lab container readiness could not query the local virtualization service",
      });
  });

  it("recognizes domain and incompatible threaded cgroup v2 hierarchies", () => {
    expect(evaluateCgroupV2Domain("domain\n", "domain\n")).toMatchObject({ ok: true });
    expect(evaluateCgroupV2Domain("domain threaded\n", "domain\n")).toMatchObject({ ok: true });
    expect(evaluateCgroupV2Domain("domain threaded\n", "threaded\n")).toMatchObject({
      ok: false,
      detail: "Current execution cgroup is threaded; OCI systemd requires a domain parent",
    });
    expect(evaluateCgroupV2Domain("domain\n", "domain invalid\n")).toMatchObject({
      ok: false,
      detail: "Current execution cgroup is domain invalid; OCI systemd requires a domain parent",
    });
  });
});

describe("Lima x86_64 driver", () => {
  it("keeps a completed guest exit 124 distinct from an actual timeout", async () => {
    const runner = new RecordingRunner();
    runner.run = async (invocation) => {
      runner.calls.push(invocation);
      return {
        ...success,
        exitCode: 124,
        guestCommandControl: { started: true, completedExitCode: 124 },
      };
    };
    const driver = new LimaDriver({
      runner,
      resourcePrefix: "companion-box-lab-owned-0123456789ab",
      stateDirectory: "/tmp/box-lab-test",
    });

    await expect(driver.execute({
      resourceName: "companion-box-lab-owned-0123456789ab-bx_23456789",
      command: "exit 124",
      timeoutSeconds: 12,
    })).resolves.toMatchObject({ success: false, exitCode: 124, timedOut: false });
    expect(runner.calls[0]!.args.slice(0, 4)).toEqual([
      "shell", "--workdir", "/home/user", "companion-box-lab-owned-0123456789ab-bx_23456789",
    ]);
  });

  it("preserves a clone failure when the source VM restarts successfully", async () => {
    const runner = new ScriptedRunner([
      success,
      { ...success, exitCode: 7, stdout: "", stderr: "clone failed\n" },
      success,
    ]);
    const driver = new LimaDriver({
      runner,
      resourcePrefix: "companion-box-lab-owned-0123456789ab",
      stateDirectory: "/tmp/box-lab-test",
    });

    await expect(driver.saveSnapshot(
      "companion-box-lab-owned-0123456789ab-bx_23456789",
      "companion-box-lab-owned-0123456789ab-snapshot-clone-failed",
    )).rejects.toMatchObject({
      name: "ProcessExecutionError",
      code: "process_failed",
      message: "Box Lab Lima snapshot clone exited unsuccessfully (exit 7)",
    });
    expect(runner.calls.map((call) => call.args[0])).toEqual(["stop", "clone", "start"]);
  });

  it("signals an unavailable source when cloning and the subsequent restart both fail", async () => {
    const runner = new ScriptedRunner([
      success,
      { ...success, exitCode: 7, stdout: "", stderr: "clone failed\n" },
      { ...success, exitCode: 9, stdout: "", stderr: "restart failed\n" },
    ]);
    const driver = new LimaDriver({
      runner,
      resourcePrefix: "companion-box-lab-owned-0123456789ab",
      stateDirectory: "/tmp/box-lab-test",
    });

    await expect(driver.saveSnapshot(
      "companion-box-lab-owned-0123456789ab-bx_23456789",
      "companion-box-lab-owned-0123456789ab-snapshot-restart-failed",
    )).rejects.toEqual(new BoxLabSourceUnavailableError());
    expect(runner.calls.map((call) => call.args[0])).toEqual(["stop", "clone", "start"]);
  });

  it("fails closed when Lima returns a nonempty malformed inventory", async () => {
    const runner = new ScriptedRunner([{ ...success, stdout: "not-json\n" }]);
    const driver = new LimaDriver({
      runner,
      resourcePrefix: "companion-box-lab-owned-0123456789ab",
      stateDirectory: "/tmp/box-lab-test",
    });

    await expect(driver.reset()).rejects.toMatchObject({
      name: "ProcessExecutionError",
      code: "process_invalid_output",
      message: "Box Lab Lima inventory returned invalid output",
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.args).toEqual(["list", "--json"]);
  });

  it("treats an already absent Lima resource as deleted", async () => {
    const runner = new ScriptedRunner([{ ...success, stdout: "[]\n" }]);
    const driver = new LimaDriver({
      runner,
      resourcePrefix: "companion-box-lab-owned-0123456789ab",
      stateDirectory: "/tmp/box-lab-test",
    });

    await expect(driver.delete("companion-box-lab-owned-0123456789ab-bx_23456789"))
      .resolves.toBeUndefined();
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.args).toEqual(["list", "--json"]);
  });

  it("does not mistake a Lima inventory failure for an absent resource", async () => {
    const runner = new ScriptedRunner([{
      ...success,
      exitCode: 1,
      stdout: "",
      stderr: "inventory service unavailable",
    }]);
    const driver = new LimaDriver({
      runner,
      resourcePrefix: "companion-box-lab-owned-0123456789ab",
      stateDirectory: "/tmp/box-lab-test",
    });

    await expect(driver.delete("companion-box-lab-owned-0123456789ab-bx_23456789"))
      .rejects.toMatchObject({ name: "ProcessExecutionError", code: "process_failed" });
    expect(runner.calls[0]!.args).toEqual(["list", "--json"]);
  });

  it("pins the guest architecture, image, user identity, and user bus without host mounts", () => {
    expect(BOX_LAB_LIMA_CONFIG).toContain("arch: x86_64");
    expect(BOX_LAB_LIMA_CONFIG).toContain("vmType: qemu");
    expect(BOX_LAB_LIMA_CONFIG).toContain("legacyBIOS: true");
    expect(BOX_LAB_LIMA_CONFIG).toContain("node-v24.14.0-linux-x64.tar.xz");
    expect(BOX_LAB_LIMA_CONFIG).toContain("41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df");
    expect(BOX_LAB_LIMA_CONFIG).toContain("base-node-24.14.0-v1");
    expect(BOX_LAB_LIMA_CONFIG).toContain("/home/user/.bash_logout");
    expect(BOX_LAB_LIMA_CONFIG).toContain("/releases/noble/release-20260518/");
    expect(BOX_LAB_LIMA_CONFIG).toContain("digest: \"sha256:");
    expect(BOX_LAB_LIMA_CONFIG).toContain("name: user\n  uid: 1000");
    expect(BOX_LAB_LIMA_CONFIG).toContain("home: /home/user");
    expect(BOX_LAB_LIMA_CONFIG).toContain("mounts: []");
    expect(BOX_LAB_LIMA_CONFIG).toContain("systemctl start user@1000.service");
    expect(BOX_LAB_LIMA_CONFIG).toContain("test -S /run/user/1000/bus");
  });

  it("doctors the foreign-architecture guest agent separately from Lima and QEMU", async () => {
    const runner = new RecordingRunner();
    runner.run = async (invocation) => {
      runner.calls.push(invocation);
      if (invocation.executable === "limactl" && invocation.args[0] === "--version") {
        return { ...success, stdout: "limactl version 2.2.0\n" };
      }
      if (invocation.executable === "limactl" && invocation.args[0] === "info") {
        return {
          ...success,
          stdout: JSON.stringify({
            guestAgents: {
              x86_64: { location: "/opt/homebrew/share/lima/lima-guestagent.Linux-x86_64.gz" },
            },
          }),
        };
      }
      return success;
    };
    const driver = new LimaDriver({
      runner,
      resourcePrefix: "companion-box-lab-owned-0123456789ab",
      stateDirectory: "/tmp/box-lab-test",
      hostPlatform: "darwin",
      hostArchitecture: "arm64",
    });

    const checks = await driver.doctor();

    expect(checks.find((check) => check.name === "lima-x86_64-guestagent"))
      .toMatchObject({ ok: true });
    expect(runner.calls.some((call) => call.executable === "limactl" && call.args[0] === "info"))
      .toBe(true);
    expect(checks.find((check) => check.name === "host-platform"))
      .toMatchObject({ ok: true, detail: "macOS arm64 host will run a real x86_64 Linux VM" });
  });

  it("supports a native x86_64 Linux host without Homebrew-specific doctor guidance", async () => {
    const runner = new RecordingRunner();
    runner.run = async (invocation) => {
      runner.calls.push(invocation);
      if (invocation.executable === "limactl" && invocation.args[0] === "--version") {
        return { ...success, stdout: "limactl version 2.2.0\n" };
      }
      if (invocation.executable === "limactl" && invocation.args[0] === "info") {
        return { ...success, stdout: JSON.stringify({ guestAgents: {} }) };
      }
      if (invocation.executable === "qemu-system-x86_64") {
        throw Object.assign(new Error("spawn qemu-system-x86_64 ENOENT"), { code: "ENOENT" });
      }
      return success;
    };
    const driver = new LimaDriver({
      runner,
      resourcePrefix: "companion-box-lab-owned-0123456789ab",
      stateDirectory: "/tmp/box-lab-test",
      hostPlatform: "linux",
      hostArchitecture: "x64",
    });

    const checks = await driver.doctor();

    expect(checks.find((check) => check.name === "host-platform")).toMatchObject({
      ok: true,
      detail: "Linux x86_64 host will run a same-architecture Linux VM through QEMU",
    });
    expect(checks.find((check) => check.name === "lima-x86_64-guestagent")).toMatchObject({
      ok: false,
      detail: "Reinstall the native Linux x86_64 guest agent from the same Lima release",
    });
    expect(checks.find((check) => check.name === "qemu-x86_64")).toMatchObject({
      ok: false,
      detail: "QEMU x86_64 is not installed; install qemu-system-x86_64 with your Linux package manager",
    });
    expect(checks.every((check) => !check.detail.includes("brew"))).toBe(true);
  });

  it("rejects non-x86_64 Linux hosts for the x86_64 Box contract", async () => {
    const runner = new RecordingRunner();
    runner.run = async (invocation) => {
      runner.calls.push(invocation);
      if (invocation.executable === "limactl" && invocation.args[0] === "--version") {
        return { ...success, stdout: "limactl version 2.2.0\n" };
      }
      if (invocation.executable === "limactl" && invocation.args[0] === "info") {
        return {
          ...success,
          stdout: JSON.stringify({ guestAgents: { x86_64: { location: "guestagent.Linux-x86_64.gz" } } }),
        };
      }
      return success;
    };
    const driver = new LimaDriver({
      runner,
      resourcePrefix: "companion-box-lab-owned-0123456789ab",
      stateDirectory: "/tmp/box-lab-test",
      hostPlatform: "linux",
      hostArchitecture: "arm64",
    });

    const checks = await driver.doctor();

    expect(checks.find((check) => check.name === "host-platform")).toMatchObject({
      ok: false,
      detail: "Lima Box Lab requires an x86_64 Linux host; detected Linux arm64",
    });
  });

  it("rejects Lima versions older than the supported 2.2 lifecycle surface", async () => {
    const runner = new RecordingRunner();
    runner.run = async (invocation) => {
      runner.calls.push(invocation);
      if (invocation.executable === "limactl" && invocation.args[0] === "--version") {
        return { ...success, stdout: "limactl version 2.1.3\n" };
      }
      if (invocation.executable === "limactl" && invocation.args[0] === "info") {
        return {
          ...success,
          stdout: JSON.stringify({ guestAgents: { x86_64: { location: "guestagent.Linux-x86_64.gz" } } }),
        };
      }
      return success;
    };
    const driver = new LimaDriver({
      runner,
      resourcePrefix: "companion-box-lab-owned-0123456789ab",
      stateDirectory: "/tmp/box-lab-test",
    });

    const checks = await driver.doctor();

    expect(checks.find((check) => check.name === "lima"))
      .toMatchObject({ ok: false, detail: "Lima 2.2.0 or newer is required" });
  });
});
