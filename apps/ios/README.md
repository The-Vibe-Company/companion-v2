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
menu, and request Owner-only durable deletion. A confirmed deletion removes the Companion from the
local roster immediately while the durable request runs; request failure restores the row, and a
later roster poll may honestly reintroduce a Companion the control plane still returns. Essential
settings cover the Companion icon, name, instructions, provider, and model. Identity opens as a
dedicated pushed editor for Owner and Editor, and both creation and editing show the complete visual
icon catalog; Viewer access remains read-only.
The roster keeps the server's member-private order, shows pinned and hidden sections, and exposes
Settings plus safe pin, hide, duplicate, and confirmed delete actions through native swipe,
long-press, and accessibility actions. Opening a thread advances that member's unread watermark, so
there is no separate Mark as read command; Mark as unread remains available through the existing
member-state endpoint. The current list contract projects unread as a Boolean, so native iOS shows
one accessible unread indicator rather than inventing an exact message count.
Connected resources now lives inside those settings as one child management page. It retains the
native Skills, routines, and triggers status views, lists the member's attached MCP plugin accounts
by provider and label, and lets the Companion Owner attach or detach already-connected accounts.
The existing projection returns only the viewing member's private account ids, so Editor attachment
changes stay read-only in native iOS rather than risk dropping an Owner's hidden selection. Detach
is the existing `selected_mcp_account_ids` replacement update: it removes the account from this
Companion without disabling or deleting the underlying Plugins connection. The same page queues the
existing Pi-only restart as **Restart Companion** and the existing full-Box restart as **Restart
server**; both are confirmed, idempotent lifecycle intents whose PostgreSQL-projected
queued/stopping/starting/completed state is polled without contacting Box or Pi. Viewer sees the
page read-only, including redacted unavailable plugin selections, and never receives mutation or
restart controls. The
native thread renders every durable decision request. Owner and Editor can answer `ask_user`,
approve or deny configuration, routine, and trigger proposals, and handle historical shell/file
requests without leaving iOS. An interrupted turn is equally explicit: Owner and Editor can retry
it with a durable idempotency key or cancel it to release later queued messages, while Viewer remains
read-only. The roster also manages model providers and MCP plugins. Provider
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
Reply pushes also carry the Companion's four cosmetic icon indexes and `mutable-content: 1`. The
embedded Notification Service Extension renders the closed blob catalog into a PNG locally, then
uses it as the sender image for Apple's communication-notification treatment. No avatar endpoint,
credential, or network request is involved. If intent enrichment cannot finish, the extension
returns the same title/body with the PNG as a standard attachment; if the extension itself times
out, iOS displays the original plain alert. Decision and failure alerts remain plain notifications.

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

The Debug-only `-glass-chat-demo`, `-glass-chat-thinking-demo`, `-companion-queued-demo`, `-markdown-table-demo`,
`-glass-management-demo`, `-glass-management-demo-plugins`,
`-companion-icon-demo`, `-companion-create-demo`, `-companion-decision-demo`, `-companion-interruption-demo`,
`-companion-transcript-window-demo`, `-companion-resources-demo`,
`-companion-settings-demo`, and
`-companion-roster-demo` launch arguments
open deterministic showcases without requiring a server or account. Add `-companion-reduce-motion`
alongside `-companion-icon-demo` to force the gallery's Reduce Motion path. The settings demo accepts
`COMPANION_SETTINGS_DEMO_ACCESS=owner|editor|viewer` for deterministic role and deletion UI tests.
The creation demo supplies deterministic provider and create responses so the shared identity icon gallery
can be exercised without an account or server.
The decision demo accepts `COMPANION_DECISION_DEMO_ACCESS=owner|editor|viewer` for the matching
decision controls. Set `COMPANION_DECISION_DEMO_FAIL_ONCE=<request-id>` to exercise a failed
submission followed by an enabled retry.
Add `-markdown-table-dark-demo` alongside `-markdown-table-demo` to exercise the table gallery with
the adaptive Companion color tokens in dark appearance.
The interruption demo accepts `COMPANION_INTERRUPTION_DEMO_ACCESS=owner|editor|viewer`; set
`COMPANION_INTERRUPTION_DEMO_FAIL_RETRY_ONCE=1` to verify that an uncertain submission keeps the
same safe retry action available.
Set `COMPANION_TRANSCRIPT_DEMO_SHORT=1` with `-companion-transcript-window-demo` to exercise the
same mixed chat surface in a short thread; the default fixture keeps the 120-entry load-more path.
Set `COMPANION_TRANSCRIPT_DEMO_STAGED_POLL=1` with `-companion-transcript-window-demo` to stage a
deterministic active assistant-tail arrival on the first poll after tapping `Stage reply`; this lets
the native UI regression leave the tail before exercising the unseen-reply pill.
The queued-message demo accepts `COMPANION_QUEUED_DEMO_ACCESS=owner|editor|viewer`; set
`COMPANION_QUEUED_DEMO_FAIL_ONCE=1` to verify that a failed removal remains retryable.
The roster demo accepts the equivalent `COMPANION_ROSTER_DEMO_ACCESS` value and simulates immediate
removal, restoration after a lost first deletion response, and a same-key `202` retry. These
arguments are excluded from Release behavior.
The resources demo accepts `COMPANION_RESOURCES_DEMO_EMPTY=skills|routines|triggers` to show one
section's deterministic empty state.
Combine `-glass-chat-demo -glass-chat-thinking-demo` to keep the composer-adjacent thinking status
visible and connect its tap target to the demo reply's collapsed reasoning disclosure.
Combine `-companion-roster-demo -companion-notification-demo` to inject a version-1 response payload
and verify deferred navigation to Luna's chat without contacting APNs.

Native chat layout regressions use the deterministic transcript-window demo. Linux quality tests
statically verify that its selected UI assertions remain wired into Apple Quality; the macOS 26
lane performs the actual Swift build and simulator geometry checks. This keeps cloud development
deterministic without installing or invoking XcodeBuildMCP in CI.
The poll-stability assertion launches that fixture, observes the latest entry across one real
four-second poll, and verifies that the latest entry remains hittable without a scroll-to-bottom
overlay. Initial delivery waits for the eager bottom destination's post-transcript geometry instead
of guessing that a yielded render task has completed layout, then scrolls to the last concrete row
registered by the lazy target layout. Its scroll decision is delegated to the shared
`CompanionScrollCoordinator`, so repeated
unchanged snapshots do not compete with the rendered viewport.
The same fixture can switch between Luna and Orbit to verify that the roster-scoped, in-memory
reading-position store restores the first visible message without animated hydration. CompanionKit
tests cover per-Companion isolation and window restoration, while Apple Quality owns the rendered
switch-and-return assertion.

Queued messages stay collapsed above the composer until opened. Owner and Editor can remove an
unstarted queued turn through the shared cancel route; Viewer remains read-only. The shared `/v1`
contract does not expose a queued-message edit mutation, so iOS does not offer editing or invent a
mobile-only replacement endpoint. This interaction follow-up calls that action Delete in the queue
and still sends the existing cancel request; cancel-and-resend is not an edit. Reply or thread
actions and regenerate are deliberately out of scope here and remain unavailable until the shared
contract provides those mutations.

## TestFlight release

The `iOS TestFlight` workflow archives and uploads the Release app only after the matching `CI`
workflow succeeds for an iOS change on `main`. It checks out that exact approved commit on the
macOS 26 runner, verifies the complete approved push range, and checks the iPhoneOS 26 SDK before
signing. It has no arbitrary-ref manual dispatch; an existing delivery can be retried from its
GitHub Actions run. The workflow uses the protected `ios-testflight` environment and the
`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`,
`IOS_DISTRIBUTION_P12`, `IOS_DISTRIBUTION_P12_PASSWORD`, `IOS_PROVISIONING_PROFILE`, and
`IOS_NOTIFICATION_EXTENSION_PROVISIONING_PROFILE` secrets. The signing certificate and profiles
are installed only for the release job and removed afterward.

The archive embeds `CompanionNotificationService` with production bundle id
`dev.companion.mobile.notifyextension` (Debug uses the containing app prefix
`dev.companion.mobile.dev.notifyextension`). The app profile must include Push Notifications and
Communication Notifications; the extension needs its own App Store distribution profile. The
extension has no separate entitlement file and makes no network request.

Before distributing a push-enabled build, enable Push Notifications and Communication Notifications
on the app App ID, register the extension App ID, and replace both provisioning-profile secrets with
matching regenerated profiles. Deploy migrations 0124 and 0131 before that build, and configure the
worker-only `COMPANION_APNS_KEY_ID`, `COMPANION_APNS_TEAM_ID`, and base64-encoded
`COMPANION_APNS_PRIVATE_KEY_BASE64`. Validate background, terminated, foreground, decision,
failure, and tap routing on a physical/TestFlight device with Apple's Push Notification Console. Removing all
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
IOS_NOTIFICATION_EXTENSION_PROVISIONING_PROFILE_SPECIFIER="Companion Notification Service App Store 2026-08-26" \
bash apps/ios/scripts/release.sh
```

The build number defaults to the current UTC second in `YYYYMMDDHHMMSS` form and can be overridden
with `BUILD_NUMBER`. A successful export uploads to App Store Connect; it never submits the build
for App Store review.
