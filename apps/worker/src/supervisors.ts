import { startBillingSupervisor, type Supervisor } from "./billingSupervisor";
import { startRunSupervisor } from "./runSupervisor";
import { startGitHubSupervisor } from "./githubSupervisor";

type SupervisorStart = () => Promise<Supervisor | null>;

async function startSafely(name: string, start: SupervisorStart): Promise<Supervisor | null> {
  try {
    return await start();
  } catch {
    // Supervisors are isolated: one optional subsystem failing configuration must not stop another.
    console.error(`${name} supervisor failed to start`);
    return null;
  }
}

export async function startWorkerSupervisors(input: {
  billing?: SupervisorStart;
  runs?: SupervisorStart;
  github?: SupervisorStart;
} = {}): Promise<{ billing: Supervisor | null; runs: Supervisor | null; github: Supervisor | null }> {
  const [billing, runs, github] = await Promise.all([
    startSafely("billing", input.billing ?? startBillingSupervisor),
    startSafely("run", input.runs ?? startRunSupervisor),
    startSafely("GitHub sync", input.github ?? startGitHubSupervisor),
  ]);
  return { billing, runs, github };
}

/**
 * An unresolved Promise does not keep Node's event loop alive. Keep an intentionally idle worker
 * process available for health/deployment supervision when every optional subsystem is disabled.
 */
export function keepWorkerProcessAliveWhenIdle(input: {
  billing: Supervisor | null;
  runs: Supervisor | null;
  github?: Supervisor | null;
}): ReturnType<typeof setInterval> | null {
  if (input.billing || input.runs || input.github) return null;
  return setInterval(() => undefined, 60_000);
}
