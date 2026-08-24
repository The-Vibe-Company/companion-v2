# Companion for iOS

Companion is a native SwiftUI app for iOS 17 and later. It replaces the former Expo client and
keeps the existing `dev.companion.mobile` App Store Connect identity.

The iOS app is another complete Companion client, not a reduced mobile product. It uses the same
`/v1` API and is intended to reach feature parity with the current browser experience, including
Skills, Plugins, MCP connections, files, routines, triggers, sharing, settings, and every Companion
control-plane workflow. Do not create mobile-only endpoints or send a client-surface discriminator
to request a smaller capability set.

The app target lives in `Companion/`. Models, networking, authentication, session state, and polling
belong in the zero-dependency `CompanionKit` Swift package. The committed Xcode project uses
file-system-synchronized groups, so adding a Swift file does not require a project-file edit.

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

## TestFlight release

The `iOS TestFlight` workflow archives and uploads the Release app when an iOS change reaches
`main`, and it can also be started manually. It uses the protected `ios-testflight` environment and
the `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`, `IOS_DISTRIBUTION_P12`,
`IOS_DISTRIBUTION_P12_PASSWORD`, and `IOS_PROVISIONING_PROFILE` secrets. The signing certificate and
profile are installed only in a temporary CI keychain and removed after the job.

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
