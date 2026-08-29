import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  BoxLabProcessIdentity,
  BoxLabProcessObservation,
} from "../src/processIdentity";
import {
  acquireBoxLabActivityLease,
  acquireBoxLabResetLease,
  boxLabWorkspaceLockDirectory,
} from "../src/workspaceLock";

const CURRENT_PID = 42_424;
const CURRENT_NONCE = "a".repeat(32);
const OLD_NONCE = "b".repeat(32);
const TOKEN = "c".repeat(32);

function fakeIdentity(
  observe: (pid: number) => BoxLabProcessObservation = () => ({
    state: "live",
    nonce: CURRENT_NONCE,
  }),
  prepare: () => Promise<void> = async () => undefined,
): BoxLabProcessIdentity {
  return {
    pid: CURRENT_PID,
    nonce: CURRENT_NONCE,
    prepare,
    observe: async (pid) => observe(pid),
  };
}

async function temporaryWorkspace(): Promise<{ lockDirectory: string; stateDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), "box-lab-workspace-lock-test-"));
  const stateDirectory = join(root, "state");
  return { lockDirectory: boxLabWorkspaceLockDirectory(stateDirectory), stateDirectory };
}

describe("Box Lab workspace leases", () => {
  it("reclaims a lease when its PID now belongs to a different process session", async () => {
    const { lockDirectory, stateDirectory } = await temporaryWorkspace();
    let resetLease: Awaited<ReturnType<typeof acquireBoxLabResetLease>> | undefined;
    try {
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(
        `${lockDirectory}/activity-v2-${CURRENT_PID}-${OLD_NONCE}-${TOKEN}.lease`,
        `${CURRENT_PID} ${OLD_NONCE}\n`,
      );

      resetLease = await acquireBoxLabResetLease(stateDirectory, fakeIdentity());

      const names = await readdir(lockDirectory);
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(new RegExp(`^reset-v2-${CURRENT_PID}-${CURRENT_NONCE}-`));
    } finally {
      await resetLease?.release();
      await rm(lockDirectory, { recursive: true, force: true });
      await rm(join(stateDirectory, ".."), { recursive: true, force: true });
    }
  });

  it("keeps a live lease when PID and process-session nonce both match", async () => {
    const { lockDirectory, stateDirectory } = await temporaryWorkspace();
    try {
      const activePath =
        `${lockDirectory}/activity-v2-${CURRENT_PID}-${CURRENT_NONCE}-${TOKEN}.lease`;
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(activePath, `${CURRENT_PID} ${CURRENT_NONCE}\n`);

      await expect(acquireBoxLabResetLease(stateDirectory, fakeIdentity()))
        .rejects.toMatchObject({ code: "box_lab_workspace_active" });
      await expect(readdir(lockDirectory)).resolves.toEqual([activePath.split("/").at(-1)]);
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
      await rm(join(stateDirectory, ".."), { recursive: true, force: true });
    }
  });

  it("fails closed when a current-format lease owner cannot be inspected", async () => {
    const { lockDirectory, stateDirectory } = await temporaryWorkspace();
    const unknownPid = 52_525;
    try {
      const activeName = `activity-v2-${unknownPid}-${OLD_NONCE}-${TOKEN}.lease`;
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(`${lockDirectory}/${activeName}`, `${unknownPid} ${OLD_NONCE}\n`);
      const identity = fakeIdentity((pid) => pid === CURRENT_PID
        ? { state: "live", nonce: CURRENT_NONCE }
        : { state: "unknown" });

      await expect(acquireBoxLabResetLease(stateDirectory, identity))
        .rejects.toMatchObject({ code: "box_lab_workspace_active" });
      await expect(readdir(lockDirectory)).resolves.toEqual([activeName]);
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
      await rm(join(stateDirectory, ".."), { recursive: true, force: true });
    }
  });

  it.each([
    ["dead", { state: "dead" } satisfies BoxLabProcessObservation, false],
    ["live", { state: "live", nonce: null } satisfies BoxLabProcessObservation, true],
    ["unknown", { state: "unknown" } satisfies BoxLabProcessObservation, true],
  ])("migrates a legacy lease whose PID is %s conservatively", async (_label, observation, blocks) => {
    const { lockDirectory, stateDirectory } = await temporaryWorkspace();
    const legacyPid = 62_626;
    let resetLease: Awaited<ReturnType<typeof acquireBoxLabResetLease>> | undefined;
    try {
      const legacyName = `activity-${legacyPid}-${TOKEN}.lease`;
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(`${lockDirectory}/${legacyName}`, `${legacyPid}\n`);
      const identity = fakeIdentity((pid) => pid === CURRENT_PID
        ? { state: "live", nonce: CURRENT_NONCE }
        : observation);

      if (blocks) {
        await expect(acquireBoxLabResetLease(stateDirectory, identity))
          .rejects.toMatchObject({ code: "box_lab_workspace_active" });
        await expect(readdir(lockDirectory)).resolves.toEqual([legacyName]);
      } else {
        resetLease = await acquireBoxLabResetLease(stateDirectory, identity);
        expect(await readdir(lockDirectory)).toHaveLength(1);
      }
    } finally {
      await resetLease?.release();
      await rm(lockDirectory, { recursive: true, force: true });
      await rm(join(stateDirectory, ".."), { recursive: true, force: true });
    }
  });

  it("does not create a lease when the current process self-check fails", async () => {
    const { lockDirectory, stateDirectory } = await temporaryWorkspace();
    const failure = new Error("process identity is not observable");
    try {
      await expect(acquireBoxLabActivityLease(
        stateDirectory,
        fakeIdentity(undefined, async () => { throw failure; }),
      )).rejects.toBe(failure);
      await expect(readdir(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
      await rm(join(stateDirectory, ".."), { recursive: true, force: true });
    }
  });
});
