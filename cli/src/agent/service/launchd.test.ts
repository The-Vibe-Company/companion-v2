import { describe, expect, it } from "vitest";
import { launchdPlist } from "./launchd";

describe("launchdPlist", () => {
  it("uses absolute node and entry paths with launchd KeepAlive semantics", () => {
    const xml = launchdPlist({
      schemaVersion: 1,
      deviceId: "device-1",
      orgId: "org-1",
      apiUrl: "http://api.test",
      token: "cmp_dev_secret",
      installChannel: "notify",
      nodePath: "/opt/homebrew/bin/node",
      entryPath: "/Users/stan/bin/companion.js",
      installedAt: "2026-07-06T10:00:00.000Z",
    });

    expect(xml).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(xml).toContain("<string>/Users/stan/bin/companion.js</string>");
    expect(xml).toContain("<string>agent</string>");
    expect(xml).toContain("<string>run</string>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("co.thevibecompany.companion.agent");
  });
});
