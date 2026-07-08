import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLocalInventory } from "./inventory";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "companion-agent-inventory-"));
  process.env.COMPANION_HOME = home;
});

afterEach(async () => {
  delete process.env.COMPANION_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("readLocalInventory", () => {
  it("reads the workspace-keyed v2 lockfile and preserves target versions", async () => {
    await writeFile(join(home, "config.json"), JSON.stringify({ schemaVersion: 1, tools: ["codex"] }));
    await writeFile(
      join(home, "skills.lock.json"),
      JSON.stringify({
        lockfileVersion: 2,
        activeWorkspaceId: "org-1",
        workspaces: {
          "org-1": {
            apiUrl: "http://api.test",
            skills: {
              demo: {
                name: "demo",
                slug: "demo",
                skillId: "skill-1",
                version: "1.0.0",
                checksum: "sha256:package",
                targets: [
                  {
                    tool: "codex",
                    scope: "user",
                    path: "/Users/stan/.codex/skills/demo",
                    checksum: "sha256:folder",
                    version: "1.0.0",
                  },
                ],
              },
            },
          },
        },
      }),
    );

    const inventory = await readLocalInventory({ workspaceId: "org-1", apiUrl: "http://api.test" });

    expect(inventory.lockfileVersion).toBe(2);
    expect(inventory.tools).toEqual(["codex"]);
    expect(inventory.skills).toHaveLength(1);
    expect(inventory.skills[0]).toMatchObject({ slug: "demo", skillId: "skill-1", version: "1.0.0" });
    expect(inventory.skills[0]!.targets[0]).toMatchObject({ tool: "codex", scope: "user", version: "1.0.0" });
  });

  it("tolerates the CLI profile config shape and legacy single-path lock records", async () => {
    await writeFile(join(home, "config.json"), JSON.stringify({ default: { url: "http://api.test", orgId: "org-1" } }));
    await writeFile(
      join(home, "skills.lock.json"),
      JSON.stringify({
        lockfileVersion: 1,
        registry: { url: "http://api.test", orgId: "org-1" },
        skills: {
          demo: {
            name: "demo",
            resolved: "0.9.0",
            checksum: "sha256:package",
            installPath: "/tmp/demo",
          },
        },
      }),
    );

    const inventory = await readLocalInventory({ workspaceId: "org-1", apiUrl: "http://api.test" });

    expect(inventory.skills).toHaveLength(1);
    expect(inventory.skills[0]).toMatchObject({ slug: "demo", version: "0.9.0", path: "/tmp/demo" });
    expect(inventory.skills[0]!.targets).toEqual([
      { tool: "claude-code", scope: "user", path: "/tmp/demo", checksum: null, version: "0.9.0" },
    ]);
  });
});
