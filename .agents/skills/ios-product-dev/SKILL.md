---
name: ios-product-dev
description: "Own end-to-end native iOS product work in SwiftUI: shape, implement, and verify beautiful, accessible Companion features while preserving the shared API and platform boundaries. Use for iOS feature work, product-facing UI changes, and native client reviews; route pure visual design or build-only requests to the focused skills."
metadata:
  short-description: "Own native iOS product work"
---

# Native iOS product development

Use this as the owner skill for a native iOS product change. It covers product intent,
platform translation, SwiftUI implementation coordination, and release-quality verification. It
does not replace the cross-platform visual owner or the focused SwiftUI and XcodeBuildMCP skills.

## Protected invariants

- Read the repository and apps/ios guidance before changing code. Treat those documents, the
  existing implementation, and the shared API contract as the source of truth.
- Use Swift 6, target iOS 26 or later, and keep the app free of third-party runtime
  dependencies. Keep models, networking, authentication, secure session state, and polling in
  CompanionKit; keep SwiftUI presentation and platform integration in the app target.
- Preserve the complete Companion client contract. Use the existing /v1 APIs and shared models;
  never invent a mobile-only endpoint, send a client-surface discriminator, or hide Skills,
  Plugins, MCP connections, attachments, routines, triggers, sharing, settings, or other
  product workflows because the surface is mobile.
- The API persists and reads control-plane intent. The iOS client never contacts Box or Pi
  directly, never handles Box credentials, and never turns typing, polling, or a Viewer read
  into a wake action. Sending is the normal wake path; a Viewer remains read-only.
- Do not hand-edit Companion.xcodeproj/project.pbxproj. The project uses file-system-synchronized
  groups, so ordinary Swift file additions should follow the existing layout.
- Preserve the existing app identities and configuration: Debug uses the local dev bundle and
  URL scheme, Release uses the production bundle and API URL, and the documented display name,
  bundle name, team, and App Store record remain unchanged unless the user explicitly changes
  them.
- Follow the Companion design language: system typography and dynamic colors, flat hairline
  structure, concise sentence-case copy, explicit status text, and accessible focus and
  content states. The only glass exception is native iOS 26 system Liquid Glass for navigation
  and interactive controls. Use system materials for content, provide an opaque fallback for
  Reduce Transparency, and do not imitate glass with custom shaders, blur stacks, gradients, or
  third-party components.
- Respect Dynamic Type, VoiceOver, Reduce Motion, Reduce Transparency, sufficient hit targets,
  keyboard/focus navigation where applicable, and color-independent status communication.

## Ownership and handoffs

- For visual direction, interaction hierarchy, copy, color, motion, responsive composition, or
  anti-pattern review, coordinate with design-frontend-dev. Read only the relevant register or
  focused reference and translate its decision into native controls; do not duplicate its design
  register inside this skill.
- For SwiftUI state ownership, view composition, async/await, performance, or testability,
  hand off the focused implementation question to swiftui-expert-dev.
- For discovery, simulator builds, tests, launches, screenshots, logs, or UI inspection, use
  xcodebuildmcp-cli. Do not fall back to raw xcodebuild, xcrun, or simctl.
- For a broad read-only code review, use review-code-dev after implementation. For repository
  delivery or a PR, hand off to ship-pr-dev once the iOS checks are complete.

## Workflow

1. Establish context. Read the nearest AGENTS.md, apps/ios/README.md, DESIGN.md,
   docs/product.md, docs/design.md, and the changed screen, model, or test. Identify whether
   the request changes CompanionKit, app presentation, API assumptions, or only visual treatment.
2. Shape the product behavior. Name the user, authorization role, durable states, loading,
   empty, error, interrupted, offline, and accessibility states. Keep operational truth visible:
   for example, only an acknowledged active attempt may say that a Companion is replying, and a
   stale poll must not move a newer state backwards.
3. Coordinate design. Ask design-frontend-dev for the smallest relevant design decision when
   the request is visual or interaction-heavy. Prefer native NavigationStack or
   NavigationSplitView, system controls, and platform conventions. Preserve the Companion
   product's calm, dense, legible hierarchy rather than adding decorative chrome.
4. Implement at the correct layer. Put API contracts, Codable models, session/auth behavior,
   polling, and deterministic domain logic in CompanionKit. Put view state projection, navigation,
   sheets, platform integrations, and accessibility presentation in the app target. Keep
   dependencies injected and cancellation explicit.
5. Cover the whole state surface. Include loading, empty, success, failure, retry/cancel,
   permission differences (Owner, Editor, Viewer), Dynamic Type, reduced motion/transparency,
   long content, keyboard or safe-area changes, and network loss when relevant. Keep files
   attached to the message that owns them; do not create a file library or artifact surface.
6. Verify with xcodebuildmcp-cli. Run the affected CompanionKit tests, a simulator build, and
   the smallest useful simulator/UI inspection. Use a screenshot or UI assertion to verify
   hierarchy, readable contrast, status labels, and the changed interaction. Check the actual
   result, not only the process exit.
7. Hand off clearly. Report the user-visible behavior, files changed, tests/build/UI checks,
   known environment limits, and any follow-up that belongs to design-frontend-dev,
   swiftui-expert-dev, review-code-dev, or ship-pr-dev.

## Native quality bar

Prefer small, composable views with stable identity and state-driven navigation. Use the
existing APIClient and session abstractions instead of duplicating authentication or transport
logic. Make async work cancellable and tied to the relevant view or model lifetime. Give every
interactive control a meaningful accessibility label and identifier when UI automation needs it.
Keep product copy terse and operational, and expose machine values literally when they are
load-bearing.

Before handoff, run the affected CompanionKit tests and a simulator build. For repository-wide
changes, also run the repository's verify:change gate. If a required simulator, CLI, credential,
or service is unavailable, stop at the safe boundary, report the exact missing prerequisite, and
do not substitute an unapproved tool or fabricate a passing result.
