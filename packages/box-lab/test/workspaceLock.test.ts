import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  BoxLabPreparedProcessIdentity,
  BoxLabProcessIdentity,
  BoxLabProcessObservation,
} from "../src/processIdentity";
import {
  acquireBoxLabActivityLease,
  acquireBoxLabResetLease,
  boxLabWorkspaceLockDirectory,
} from "../src/workspaceLock";

const CURRENT_OWNER_PID = 41_414;
const CURRENT_BEACON_PID = 42_424;
const CURRENT_NONCE = "a".repeat(32);
const OLD_NONCE = "b".repeat(32);
const TOKEN = "c".repeat(32);

const PREPARED_IDENTITY: BoxLabPreparedProcessIdentity = {
  ownerPid: CURRENT_OWNER_PID,
  beaconPid: CURRENT_BEACON_PID,
  nonce: CURRENT_NONCE,
};

function defaultObservation(pid: number): BoxLabProcessObservation {
  return pid === CURRENT_BEACON_PID
    ? { state: "live", nonce: CURRENT_NONCE }
    : { state: "live", nonce: null };
}

function fakeIdentity(
  observe: (pid: number) => BoxLabProcessObservation = defaultObservation,
  prepare: () => Promise<BoxLabPreparedProcessIdentity> = async () => PREPARED_IDENTITY,
): BoxLabProcessIdentity {
  return {
    ownerPid: CURRENT_OWNER_PID,
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
  it("reclaims a lease when its beacon PID now belongs to a different process session", async () => {
    const { lockDirectory, stateDirectory } = await temporaryWorkspace();
    const oldOwnerPid = 51_515;
    const reusedBeaconPid = 52_525;
    let resetLease: Awaited<ReturnType<typeof acquireBoxLabResetLease>> | undefined;
    try {
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(
        `${lockDirectory}/activity-v3-${oldOwnerPid}-${reusedBeaconPid}-${OLD_NONCE}-${TOKEN}.lease`,
        `${oldOwnerPid} ${reusedBeaconPid} ${OLD_NONCE}\n`,
      );
      const identity = fakeIdentity((pid) => {
        if (pid === reusedBeaconPid) return { state: "live", nonce: CURRENT_NONCE };
        if (pid === oldOwnerPid) return { state: "dead" };
        return defaultObservation(pid);
      });

      resetLease = await acquireBoxLabResetLease(stateDirectory, identity);

      const names = await readdir(lockDirectory);
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(new RegExp(
        `^reset-v3-${CURRENT_OWNER_PID}-${CURRENT_BEACON_PID}-${CURRENT_NONCE}-`,
      ));
    } finally {
      await resetLease?.release();
      await rm(lockDirectory, { recursive: true, force: true });
      await rm(join(stateDirectory, ".."), { recursive: true, force: true });
    }
  });

  it("keeps a lease when a reused beacon PID belongs to another process but its owner is live", async () => {
    const { lockDirectory, stateDirectory } = await temporaryWorkspace();
    const ownerPid = 51_515;
    const reusedBeaconPid = 52_525;
    try {
      const activeName = `activity-v3-${ownerPid}-${reusedBeaconPid}-${OLD_NONCE}-${TOKEN}.lease`;
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(
        `${lockDirectory}/${activeName}`,
        `${ownerPid} ${reusedBeaconPid} ${OLD_NONCE}\n`,
      );
      const identity = fakeIdentity((pid) => {
        if (pid === reusedBeaconPid) return { state: "live", nonce: CURRENT_NONCE };
        if (pid === ownerPid) return { state: "live", nonce: null };
        return defaultObservation(pid);
      });

      await expect(acquireBoxLabResetLease(stateDirectory, identity))
        .rejects.toMatchObject({ code: "box_lab_workspace_active" });
      await expect(readdir(lockDirectory)).resolves.toEqual([activeName]);
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
      await rm(join(stateDirectory, ".."), { recursive: true, force: true });
    }
  });

  it("keeps a live lease when beacon PID and process-session nonce both match", async () => {
    const { lockDirectory, stateDirectory } = await temporaryWorkspace();
    try {
      const activeName =
        `activity-v3-${CURRENT_OWNER_PID}-${CURRENT_BEACON_PID}-${CURRENT_NONCE}-${TOKEN}.lease`;
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(
        `${lockDirectory}/${activeName}`,
        `${CURRENT_OWNER_PID} ${CURRENT_BEACON_PID} ${CURRENT_NONCE}\n`,
      );

      await expect(acquireBoxLabResetLease(stateDirectory, fakeIdentity()))
        .rejects.toMatchObject({ code: "box_lab_workspace_active" });
      await expect(readdir(lockDirectory)).resolves.toEqual([activeName]);
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
      await rm(join(stateDirectory, ".."), { recursive: true, force: true });
    }
  });

  it("fails closed when a current-format lease beacon cannot be inspected", async () => {
    const { lockDirectory, stateDirectory } = await temporaryWorkspace();
    const unknownBeaconPid = 52_525;
    try {
      const activeName =
        `activity-v3-51515-${unknownBeaconPid}-${OLD_NONCE}-${TOKEN}.lease`;
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(`${lockDirectory}/${activeName}`, `51515 ${unknownBeaconPid} ${OLD_NONCE}\n`);
      const identity = fakeIdentity((pid) => pid === unknownBeaconPid
        ? { state: "unknown" }
        : defaultObservation(pid));

      await expect(acquireBoxLabResetLease(stateDirectory, identity))
        .rejects.toMatchObject({ code: "box_lab_workspace_active" });
      await expect(readdir(lockDirectory)).resolves.toEqual([activeName]);
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
      await rm(join(stateDirectory, ".."), { recursive: true, force: true });
    }
  });

  it("keeps a lease whose beacon died unexpectedly while its owner remains live", async () => {
    const { lockDirectory, stateDirectory } = await temporaryWorkspace();
    const ownerPid = 51_515;
    const deadBeaconPid = 52_525;
    try {
      const activeName = `activity-v3-${ownerPid}-${deadBeaconPid}-${OLD_NONCE}-${TOKEN}.lease`;
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(`${lockDirectory}/${activeName}`, `${ownerPid} ${deadBeaconPid} ${OLD_NONCE}\n`);
      const identity = fakeIdentity((pid) => {
        if (pid === deadBeaconPid) return { state: "dead" };
        if (pid === ownerPid) return { state: "live", nonce: null };
        return defaultObservation(pid);
      });

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
      const identity = fakeIdentity((pid) => pid === legacyPid
        ? observation
        : defaultObservation(pid));

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

  it("keeps a live v2 process-title lease during migration", async () => {
    const { lockDirectory, stateDirectory } = await temporaryWorkspace();
    const ownerPid = 62_626;
    try {
      const v2Name = `activity-v2-${ownerPid}-${OLD_NONCE}-${TOKEN}.lease`;
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(`${lockDirectory}/${v2Name}`, `${ownerPid} ${OLD_NONCE}\n`);
      const identity = fakeIdentity((pid) => pid === ownerPid
        ? { state: "live", nonce: null }
        : defaultObservation(pid));

      await expect(acquireBoxLabResetLease(stateDirectory, identity))
        .rejects.toMatchObject({ code: "box_lab_workspace_active" });
      await expect(readdir(lockDirectory)).resolves.toEqual([v2Name]);
    } finally {
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
