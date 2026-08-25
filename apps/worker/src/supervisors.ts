import { Sentry } from "./sentry";
import { startBillingSupervisor, type Supervisor } from "./billingSupervisor";
import { startGitHubSupervisor } from "./githubSupervisor";
import { startRoutineSupervisor } from "./routineSupervisor";
import { startSkillDatabaseCleanupSupervisor } from "./skillDatabaseCleanup";
import { startApnsSupervisor } from "./apnsSupervisor";

type SupervisorStart = () => Promise<Supervisor | null>;

async function startSafely(name: string, start: SupervisorStart): Promise<Supervisor | null> {
  try {
    return await start();
  } catch (error) {
    // Supervisors are isolated: one optional subsystem failing configuration must not stop another.
    Sentry.captureException(error);
    console.error(`${name} supervisor failed to start`);
    return null;
  }
}

export async function startWorkerSupervisors(input: {
  billing?: SupervisorStart;
  github?: SupervisorStart;
  skillDatabases?: SupervisorStart;
  routines?: SupervisorStart;
  apns?: SupervisorStart;
} = {}): Promise<{
  billing: Supervisor | null;
  github: Supervisor | null;
  skillDatabases: Supervisor | null;
  routines: Supervisor | null;
  apns: Supervisor | null;
}> {
  const [billing, github, skillDatabases, routines, apns] = await Promise.all([
    startSafely("billing", input.billing ?? startBillingSupervisor),
    startSafely("GitHub sync", input.github ?? startGitHubSupervisor),
    startSafely("Skill Database cleanup", input.skillDatabases ?? startSkillDatabaseCleanupSupervisor),
    startSafely("Companion routines", input.routines ?? startRoutineSupervisor),
    startSafely("Companion APNs", input.apns ?? startApnsSupervisor),
  ]);
  return { billing, github, skillDatabases, routines, apns };
}

/**
 * An unresolved Promise does not keep Node's event loop alive. Keep an intentionally idle worker
 * process available for health checks when every optional Skills Hub subsystem is disabled.
 */
export function keepWorkerProcessAliveWhenIdle(input: {
  billing: Supervisor | null;
  github?: Supervisor | null;
  skillDatabases?: Supervisor | null;
  routines?: Supervisor | null;
  apns?: Supervisor | null;
}): ReturnType<typeof setInterval> | null {
  if (input.billing || input.github || input.skillDatabases || input.routines || input.apns) return null;
  return setInterval(() => undefined, 60_000);
}
