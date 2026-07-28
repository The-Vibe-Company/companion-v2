import { describe, expect, it, vi } from "vitest";
import type { Supervisor } from "./billingSupervisor";
import { keepWorkerProcessAliveWhenIdle, startWorkerSupervisors } from "./supervisors";

const supervisor = (): Supervisor => ({ stop: vi.fn(async () => undefined) });

describe("worker supervisor isolation", () => {
  it("starts RunSkill maintenance when billing is disabled", async () => {
    const runs = supervisor();
    const result = await startWorkerSupervisors({
      billing: vi.fn(async () => null),
      runs: vi.fn(async () => runs),
      github: vi.fn(async () => null),
      projects: vi.fn(async () => null),
    });
    expect(result).toEqual({ billing: null, runs, github: null, projects: null });
  });

  it("starts RunSkill maintenance even when billing startup fails", async () => {
    const runs = supervisor();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await startWorkerSupervisors({
      billing: vi.fn(async () => { throw new Error("billing unavailable"); }),
      runs: vi.fn(async () => runs),
      github: vi.fn(async () => null),
      projects: vi.fn(async () => null),
    });
    expect(result).toEqual({ billing: null, runs, github: null, projects: null });
    expect(error).toHaveBeenCalledWith("billing supervisor failed to start");
    error.mockRestore();
  });

  it("keeps the process alive when every optional supervisor is disabled", () => {
    const idle = keepWorkerProcessAliveWhenIdle({ billing: null, runs: null });
    try {
      expect(idle).not.toBeNull();
      expect(idle?.hasRef()).toBe(true);
      expect(keepWorkerProcessAliveWhenIdle({ billing: supervisor(), runs: null })).toBeNull();
    } finally {
      if (idle) clearInterval(idle);
    }
  });
});
