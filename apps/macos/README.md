# Companion for macOS

CompanionMac is a native SwiftUI client for macOS 14 and later. It shares the zero-dependency
`CompanionKit` package with the iOS app and uses the same Better Auth session, models, polling, and
`/v1` API. It is a desktop-shaped first-party client, not a port of the phone layout and not a
reduced capability surface.

The main window uses a Mac-native three-zone layout. The left sidebar renders the shared owner
section projection and Companion rows, the center keeps the selected durable chat, and a persistent
right inspector renders that Companion's identity, character, Intelligence, routines and private
run history, Skills, triggers, connected accounts, instructions, notifications, and runtime
controls. Compact windows may collapse the inspector from the chat header. The window restores its
frame, while SwiftUI's split and inspector columns retain native resizing behavior.

Both native clients use the same `CompanionKit` theme, vector `CharacterMark`, status projection,
link policy, models, and API routes. The Mac chat follows the iOS two-sided 18-point bubble grammar,
approval/file/link cards, terse composer, and green/replying/gray/error dots without adding a
second visual or capability contract. The Appearance menu switches between System and Black OLED.

## Desktop access

An Owner or Editor can open the selected running Companion's Box desktop from chat. CompanionMac
calls `POST /v1/companions/:id/runtime/desktop` through `CompanionKit`, receives one fresh
`desktop_url`, and presents that URL in a dedicated native window backed by `WKWebView`.

`desktop_url` is a short-lived, secret-bearing handoff to the same Lux-driven Box screen used by
the web client. Its `transport` is `vnc` when Box can provide the firewall-friendly WebSocket
stream and otherwise `webrtc`; `automation` is `lux`. A null URL with `provisioning: true` means an
already-running Box is still preparing the desktop. Every reconnect mints a new URL. The app keeps
the URL in memory only, never logs or persists it, and never uses desktop access to start or wake a
Box. Viewer requests remain unavailable before any Box contact.

## Local build

Open `apps/ios/Companion.xcworkspace` and select the `CompanionMac` scheme. Debug accepts
`COMPANION_API_URL` for a local stack; Release always uses `https://api.thecompanion.sh`.

The repository's local Apple tooling policy requires XcodeBuildMCP for interactive discovery,
build, test, launch, screenshot, and UI inspection. Apple CI continues to use native `swift test`
and `xcodebuild` commands. Changes under `apps/macos/` select the Mac path in the existing five-minute
Apple Quality job, which tests `CompanionKit` and the `CompanionMac` scheme without booting a
simulator or running UI tests.

## Distribution follow-up

This target is development- and CI-oriented. Public distribution will require a registered macOS
bundle identifier, Developer ID Application certificate, hardened runtime, App Sandbox/network
entitlements review, notarization credentials, signed archive/export automation, and Gatekeeper
validation. Mac App Store/TestFlight distribution, APNs, widgets, and menu bar extras are outside
this bootstrap.
