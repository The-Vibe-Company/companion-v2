import { describe, expect, it, vi } from "vitest";
import type { Supervisor } from "./billingSupervisor";
import { startWorkerSupervisors } from "./supervisors";

const supervisor = (): Supervisor => ({ stop: vi.fn(async () => undefined) });

describe("worker supervisor isolation", () => {
  it("starts RunSkill maintenance when billing is disabled", async () => {
    const runs = supervisor();
    const result = await startWorkerSupervisors({
      billing: vi.fn(async () => null),
      runs: vi.fn(async () => runs),
    });
    expect(result).toEqual({ billing: null, runs });
  });

  it("starts RunSkill maintenance even when billing startup fails", async () => {
    const runs = supervisor();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await startWorkerSupervisors({
      billing: vi.fn(async () => { throw new Error("billing unavailable"); }),
      runs: vi.fn(async () => runs),
    });
    expect(result).toEqual({ billing: null, runs });
    expect(error).toHaveBeenCalledWith("billing supervisor failed to start");
    error.mockRestore();
  });
});
