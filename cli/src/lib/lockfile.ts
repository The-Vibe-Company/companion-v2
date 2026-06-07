import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { lockfileSchema, type Lockfile, type LockedSkill } from "@companion/contracts";

export const LOCKFILE_NAME = "companion.lock";

/** Walk up from `start` to the nearest companion.lock (git/npm-style). */
export function findLockfileDir(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, LOCKFILE_NAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function emptyLockfile(url = "", orgId: string | null = null): Lockfile {
  return { lockfileVersion: 1, registry: { url, orgId }, skills: {} };
}

export async function loadLockfile(dir: string): Promise<Lockfile> {
  try {
    const raw = JSON.parse(await readFile(join(dir, LOCKFILE_NAME), "utf8"));
    return lockfileSchema.parse(raw);
  } catch {
    return emptyLockfile();
  }
}

export async function saveLockfile(dir: string, lock: Lockfile): Promise<void> {
  await writeFile(join(dir, LOCKFILE_NAME), `${JSON.stringify(lock, null, 2)}\n`);
}

export function upsertLockedSkill(lock: Lockfile, skill: LockedSkill): void {
  lock.skills[skill.name] = skill;
}
