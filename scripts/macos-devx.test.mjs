import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the native macOS target shares CompanionKit without a reduced API surface", () => {
  const project = read("apps/macos/CompanionMac.xcodeproj/project.pbxproj");
  const scheme = read("apps/macos/CompanionMac.xcodeproj/xcshareddata/xcschemes/CompanionMac.xcscheme");
  const workspace = read("apps/ios/Companion.xcworkspace/contents.xcworkspacedata");
  const packageManifest = read("apps/ios/CompanionKit/Package.swift");
  const macReadme = read("apps/macos/README.md");
  const rootView = read("apps/macos/CompanionMac/MacRootView.swift");
  const workspaceView = read("apps/macos/CompanionMac/MacWorkspaceView.swift");
  const chatView = read("apps/macos/CompanionMac/MacChatView.swift");

  assert.match(project, /PBXFileSystemSynchronizedRootGroup/);
  assert.match(project, /name = CompanionMac;/);
  assert.match(project, /name = CompanionMacTests;/);
  assert.match(project, /MACOSX_DEPLOYMENT_TARGET = 14\.0;/);
  assert.match(project, /relativePath = "?\.\.\/ios\/CompanionKit"?;/);
  assert.match(project, /productName = CompanionKit;/);
  assert.match(project, /CompanionMac\/Info\.plist/);
  assert.match(project, /CompanionMac\/CompanionMac\.entitlements/);
  assert.match(scheme, /BlueprintName = "CompanionMac"/);
  assert.match(scheme, /BlueprintName = "CompanionMacTests"/);
  assert.match(workspace, /container:\.\.\/macos\/CompanionMac\.xcodeproj/);
  assert.match(packageManifest, /\.macOS\(\.v14\)/);
  assert.match(macReadme, /same Better Auth session, models, polling, and\s+`\/v1` API/);
  assert.doesNotMatch(
    read("apps/macos/CompanionMac/CompanionMacApp.swift"),
    /native_mobile|clientSurface/,
  );
  assert.match(workspaceView, /CompanionMacChatView\([\s\S]*?\.id\(companion\.id\)/);
  assert.match(rootView, /phase == \.signedOut[\s\S]*?desktopWindow\.clear\(\)[\s\S]*?dismissWindow\(id: "companion-desktop"\)/);
  assert.match(chatView, /if await model\.send\([\s\S]*?draft = ""[\s\S]*?attachments = \[\]/);
  assert.doesNotMatch(chatView, /let files = attachments\s+draft = ""/);
});
