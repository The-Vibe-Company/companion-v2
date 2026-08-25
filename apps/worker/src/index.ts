import "./sentry";
import { Sentry } from "./sentry";
import { closeDb } from "@companion/db";
import { keepWorkerProcessAliveWhenIdle, startWorkerSupervisors } from "./supervisors";

async function main(): Promise<void> {
  const { billing, github, skillDatabases, routines, apns } = await startWorkerSupervisors();
  if (!billing && !github && !skillDatabases && !routines && !apns) {
    console.info("worker idle: no supervisor is configured");
  }
  const idleKeepAlive = keepWorkerProcessAliveWhenIdle({ billing, github, skillDatabases, routines, apns });

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      if (idleKeepAlive) clearInterval(idleKeepAlive);
      await Promise.allSettled([
        billing?.stop(),
        github?.stop(),
        skillDatabases?.stop(),
        routines?.stop(),
        apns?.stop(),
      ]);
      await closeDb();
      resolve();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  });
}

main().catch(async (error: Error) => {
  Sentry.captureException(error);
  console.error("worker failed to start");
  await Sentry.flush(2000);
  process.exitCode = 1;
});
