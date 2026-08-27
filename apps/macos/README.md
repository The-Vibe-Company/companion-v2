# Companion for macOS

CompanionMac is a native SwiftUI client for macOS 14 and later. It shares the zero-dependency
`CompanionKit` package with the iOS app and uses the same Better Auth session, models, polling, and
`/v1` API. It is a desktop-shaped first-party client, not a port of the phone layout and not a
reduced capability surface.

The initial app uses a macOS `NavigationSplitView`: a searchable Companion roster remains visible
beside the selected durable chat, with native toolbars, menus, context menus, hover states, and
keyboard commands. Chat supports the shared transcript, queued/interrupted work, Markdown,
reasoning disclosures, tool cards, bounded message attachments, and the Owner/Editor versus Viewer
permission contract. Essential Companion, member, provider, and plugin settings use the existing
shared routes.

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
and `xcodebuild` commands. This bootstrap intentionally does not edit CI workflows; the follow-up
CI scope change should build and test `CompanionMac` on the existing Apple Quality macOS runner
after the repository owner approves that workflow change.

## Distribution follow-up

This target is development- and CI-oriented. Public distribution will require a registered macOS
bundle identifier, Developer ID Application certificate, hardened runtime, App Sandbox/network
entitlements review, notarization credentials, signed archive/export automation, and Gatekeeper
validation. Mac App Store/TestFlight distribution, APNs, widgets, and menu bar extras are outside
this bootstrap.

## Proposed PR split

If review size warrants stacking the next iteration, keep this PR as the cross-platform
`CompanionKit` desktop contract plus visible macOS roster/chat/desktop shape. Follow with a stacked
PR for deeper settings parity, screenshot/UI automation coverage, approved Apple Quality scope,
and distribution preparation.
