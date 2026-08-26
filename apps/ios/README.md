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

The native roster can create Companions, open their essential settings from chat or a long-press
menu, and request Owner-only durable deletion. Essential settings cover the Companion icon, name,
instructions, provider, and model; Editor access is editable and Viewer access is read-only. The
native thread renders every durable decision request. Owner and Editor can answer `ask_user`,
approve or deny configuration, routine, and trigger proposals, and handle historical shell/file
requests without leaving iOS; Viewer remains read-only. The roster also manages model providers and
MCP plugins. Provider
connections support encrypted API keys plus the shared Claude authorization-code and Codex device
flows. The live server catalog includes Claude, Codex, Kimi, Moonshot, z.ai, OpenAI API, and Google
Gemini; the app renders that catalog rather than maintaining a divergent mobile allowlist. Members
can connect multiple labeled accounts for each product-owned plugin category — Linear, GitHub,
Notion, and Conductor — through the existing brokered OAuth flow. Custom MCP plugins remain
available over HTTP or a Box command with an optional encrypted credential, using the same shared
endpoints and transports as the browser client.

Push Notifications are requested immediately after the first active session. Debug registers
`dev.companion.mobile.dev` with the APNs sandbox; Release registers `dev.companion.mobile` with
production APNs. A tap waits for session and roster restoration, verifies the workspace and current
access, then opens the existing chat. Foreground alerts include banner, Notification Center list,
and sound unless that chat is already open. The app deliberately uses no numeric badge.

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

The Debug-only `-glass-chat-demo`, `-glass-management-demo`, `-glass-management-demo-plugins`,
`-companion-icon-demo`, `-companion-decision-demo`, `-companion-settings-demo`, and
`-companion-roster-demo` launch arguments
open deterministic showcases without requiring a server or account. Add `-companion-reduce-motion`
alongside `-companion-icon-demo` to force the gallery's Reduce Motion path. The settings demo accepts
`COMPANION_SETTINGS_DEMO_ACCESS=owner|editor|viewer` for deterministic role and deletion UI tests.
The decision demo accepts `COMPANION_DECISION_DEMO_ACCESS=owner|editor|viewer` for the matching
decision controls. Set `COMPANION_DECISION_DEMO_FAIL_ONCE=<request-id>` to exercise a failed
submission followed by an enabled retry.
The roster demo accepts the equivalent `COMPANION_ROSTER_DEMO_ACCESS` value and simulates a lost
first deletion response followed by a same-key `202` retry. These arguments are excluded from Release
behavior.
Combine `-companion-roster-demo -companion-notification-demo` to inject a version-1 response payload
and verify deferred navigation to Luna's chat without contacting APNs.

## TestFlight release

The `iOS TestFlight` workflow archives and uploads the Release app only after the matching `CI`
workflow succeeds for an iOS change on `main`. It checks out that exact approved commit on the
macOS 26 runner, verifies the complete approved push range, and checks the iPhoneOS 26 SDK before
signing. It has no arbitrary-ref manual dispatch; an existing delivery can be retried from its
GitHub Actions run. The workflow uses the protected `ios-testflight` environment and the
`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`,
`IOS_DISTRIBUTION_P12`, `IOS_DISTRIBUTION_P12_PASSWORD`, and `IOS_PROVISIONING_PROFILE` secrets. The
signing certificate and profile are installed only in a temporary CI keychain and removed after the
job.

Before distributing a push-enabled build, enable Push Notifications on both App IDs and replace the
`IOS_PROVISIONING_PROFILE` secret with a regenerated profile containing the `aps-environment`
entitlement. Deploy migration 0124 before that build, and configure the worker-only
`COMPANION_APNS_KEY_ID`, `COMPANION_APNS_TEAM_ID`, and base64-encoded
`COMPANION_APNS_PRIVATE_KEY_BASE64`. Validate background, terminated, foreground, decision, failure,
and tap routing on a physical/TestFlight device with Apple's Push Notification Console. Removing all
three worker variables is the push rollback; turns and the iOS app continue to function.

If the matching `main` CI fails, no TestFlight delivery is created. A later successful CI run for
an unrelated change does not retroactively release the earlier iOS commit; land the CI fix with an
iOS-path follow-up so the approved push is explicitly eligible for a new upload.

For an authorized local release, provide the same App Store Connect credentials without copying the
private key into the repository:

```bash
ASC_KEY_ID="<key-id>" \
ASC_ISSUER_ID="<issuer-id>" \
ASC_KEY_PATH="/secure/path/AuthKey_<key-id>.p8" \
IOS_PROVISIONING_PROFILE_SPECIFIER="Companion Native App Store 2026-08-24" \
bash apps/ios/scripts/release.sh
```

The build number defaults to the current UTC second in `YYYYMMDDHHMMSS` form and can be overridden
with `BUILD_NUMBER`. A successful export uploads to App Store Connect; it never submits the build
for App Store review.
