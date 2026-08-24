# Companion iOS contributor guidance

This directory is the iOS-only SwiftUI client. Use Swift 6, target iOS 26 or later, and keep the app
free of third-party dependencies. Shared models, API, authentication, secure session, and polling
logic belong in `CompanionKit`; the app target owns SwiftUI presentation and platform integration.

- Use `xcodebuildmcp` for discovery, builds, simulator launches, tests, screenshots, and UI
  inspection. Check command help and session defaults before the first build action.
- TestFlight delivery is the narrow exception: XcodeBuildMCP does not expose archive or export
  operations, so `.github/workflows/ios-testflight.yml` may use Apple's `xcodebuild archive` and
  `xcodebuild -exportArchive` only for signed App Store distribution. Keep every ordinary build,
  test, launch, simulator, and inspection path on XcodeBuildMCP.
- For non-trivial native work, use the repo-local `ios-product-dev` owner skill, route SwiftUI
  mechanics through `swiftui-expert-dev`, visual direction through `design-frontend-dev`, and all
  Apple build or simulator work through `xcodebuildmcp-cli`. The same packages are mirrored for
  Agents and Claude under `.agents/skills/` and `.claude/skills/`.
- Never edit `Companion.xcodeproj/project.pbxproj` by hand. The project uses Xcode 16+
  file-system-synchronized groups; ordinary file additions need no project update.
- Keep Debug on `dev.companion.mobile.dev` with the matching URL scheme. Keep Release on
  `dev.companion.mobile` and pin its API URL to `https://api.thecompanion.sh`.
- Preserve `CFBundleDisplayName` as `Companion (623507)`, `CFBundleName` as `Companion623507`, team
  `K28B69CWQ7`, and App Store Connect record `6804447784`.
- Preserve automatic TestFlight delivery for every successful `main` CI revision. The
  `ios-testflight` GitHub environment stays restricted to `main`; credentials remain environment
  secrets and must never be printed, copied into artifacts, or made available to pull requests.
- The iOS app uses the same `/v1` API and full product contract as every other first-party client.
  Do not invent mobile-only endpoints, send a client-surface discriminator, or treat Skills,
  Plugins, MCP, attachments, routines, triggers, sharing, or settings as presentation-specific
  features.
- Follow the root `DESIGN.md`. Use code-defined dynamic colors, system typography, hairlines, short
  reducible motion, and 16-point radii only for chat bubbles and the composer.

Before handing off a change, run the affected `CompanionKit` tests and a simulator build. Use the
root `pnpm verify:change` gate for repository-wide changes.
