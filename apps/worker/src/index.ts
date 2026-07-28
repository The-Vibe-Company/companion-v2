import { closeDb } from "@companion/db";
import { keepWorkerProcessAliveWhenIdle, startWorkerSupervisors } from "./supervisors";

async function main(): Promise<void> {
  const { billing, runs, github, projects } = await startWorkerSupervisors();
  if (!billing && !runs && !github && !projects) {
    console.info("worker idle: no supervisor is configured");
  }
  const idleKeepAlive = keepWorkerProcessAliveWhenIdle({ billing, runs, github, projects });

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      if (idleKeepAlive) clearInterval(idleKeepAlive);
      // Run shutdown stops claims/heartbeats and leaves active leases to expire for safe resume.
      await Promise.allSettled([
        billing?.stop(),
        runs?.stop(),
        github?.stop(),
        projects?.stop(),
      ]);
      await closeDb();
      resolve();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  });
}

main().catch(() => {
  console.error("worker failed to start");
  process.exitCode = 1;
});
