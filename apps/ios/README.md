# Companion for iOS

Companion is a native SwiftUI app for iOS 26 and later. It replaces the former Expo client and
keeps the existing `dev.companion.mobile` App Store Connect identity.

The iOS app is another complete Companion client, not a reduced mobile product. It uses the same
`/v1` API and is intended to reach feature parity with the current browser experience, including
Skills, Plugins, MCP connections, files, routines, triggers, sharing, settings, and every Companion
control-plane workflow. Do not create mobile-only endpoints or send a client-surface discriminator
to request a smaller capability set.

The app target lives in `Companion/`. Models, networking, authentication, session state, and polling
belong in the zero-dependency `CompanionKit` Swift package. The committed Xcode project uses
file-system-synchronized groups, so adding a Swift file does not require a project-file edit.

The native roster can create Companions and manage their model providers and MCP plugins. Provider
connections support encrypted API keys plus the shared Claude authorization-code and Codex device
flows. The live server catalog includes Claude, Codex, Kimi, Moonshot, z.ai, OpenAI API, and Google
Gemini; the app renders that catalog rather than maintaining a divergent mobile allowlist. Members
can connect multiple labeled accounts for each product-owned plugin category — Linear, GitHub,
Notion, and Conductor — through the existing brokered OAuth flow. Custom MCP plugins remain
available over HTTP or a Box command with an optional encrypted credential, using the same shared
endpoints and transports as the browser client.

Long-term native work is guided by the repo-local `ios-product-dev`, `swiftui-expert-dev`,
`design-frontend-dev`, and `xcodebuildmcp-cli` skills. Their iOS-specific packages are mirrored
byte-for-byte under `.agents/skills/` and `.claude/skills/` so Agents and Claude follow the same
product, architecture, accessibility, and verification rules.

## Local development

Start the repository stack with the default Conductor run, then run the local-only iOS action. The
launcher derives the API URL from `CONDUCTOR_PORT + 1`, builds the Debug app, and starts it in an iOS
simulator with a launch-argument override.

```bash
bash apps/ios/scripts/dev-conductor.sh
```

Run package tests with:

```bash
xcodebuildmcp swift-package test --package-path apps/ios/CompanionKit
```

Release builds ignore launch arguments and environment variables and always use
`https://api.thecompanion.sh`.

The Debug-only `-glass-chat-demo`, `-glass-management-demo`, and
`-glass-management-demo-plugins` launch arguments open interactive Liquid Glass showcases without
requiring a server or account. They are excluded from Release behavior.

## TestFlight delivery

After the repository CI succeeds for a push to `main`, `.github/workflows/ios-testflight.yml`
uploads a signed Release archive for the exact verified commit. Delivering every successful `main`
revision avoids missing native changes in a batched push. The workflow uses the `ios-testflight`
GitHub environment, which is restricted to `main`, and serializes uploads so two builds cannot
publish concurrently. A manual dispatch is available for an intentional rebuild from `main`.

Build numbers use GitHub's globally unique workflow run ID plus its retry attempt. Before archiving,
the workflow asks App Store Connect whether an accepted build from the same run already exists.
Failed or invalid uploads can therefore receive a fresh number on rerun without duplicating a build
that is valid or still processing. XcodeBuildMCP remains the boundary for normal builds and tests;
the delivery workflow uses Apple's `xcodebuild archive` and `xcodebuild -exportArchive` because
XcodeBuildMCP does not provide archive or App Store export operations.
