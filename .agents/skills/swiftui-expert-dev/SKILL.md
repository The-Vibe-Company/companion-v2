---
name: swiftui-expert-dev
description: "Provide focused SwiftUI implementation expertise for native iOS work: state ownership, composition, navigation, concurrency, performance, accessibility, and testability. Use when the product direction is known and the question is how to implement or refactor SwiftUI safely; route product shaping and build orchestration to their owner skills."
metadata:
  short-description: "Implement SwiftUI safely"
---

# SwiftUI implementation expertise

Use this skill as a narrow implementation capability inside a native iOS task. It improves the
mechanics of SwiftUI and Swift concurrency without taking ownership of product direction,
cross-platform design, API authorization, or build orchestration.

## Protected invariants

- Read the nearest repository and iOS guidance before editing. Follow the existing Swift 6,
  iOS 26, file-system-synchronized Xcode project, and zero-third-party-dependency constraints.
- Keep CompanionKit responsible for models, Codable/API contracts, authentication, secure
  session state, polling, and domain logic. Keep view composition and platform presentation in
  the app target. Do not duplicate transport or auth code in a View.
- Preserve the shared /v1 contract and complete product parity. Do not add a mobile-only API,
  client-surface discriminator, reduced capability mode, or direct Box/Pi access.
- Never hand-edit Companion.xcodeproj/project.pbxproj for an ordinary Swift file addition.
- Do not use decorative custom glass, shaders, blur stacks, gradients, or third-party UI
  components. Native iOS 26 Liquid Glass is limited to system navigation and interactive
  controls; content must remain readable on system materials and become opaque when Reduce
  Transparency is enabled.
- Accessibility is part of correctness: support Dynamic Type, VoiceOver labels/traits,
  Reduce Motion and Reduce Transparency, keyboard/focus navigation where relevant, hit targets,
  and status meaning that is not conveyed by color alone.

## Scope and handoffs

- Ask ios-product-dev to own user intent, role/authorization behavior, API parity, and the
  final product decision. Return implementation findings and focused patches to that owner.
- Ask design-frontend-dev to own visual register, hierarchy, copy, color, motion, and
  anti-pattern decisions. Translate its smallest relevant decision into native system controls;
  do not recreate a second design system here.
- Ask xcodebuildmcp-cli to own project discovery, builds, tests, simulator launches, screenshots,
  logs, and UI inspection. This skill may suggest checks but does not replace that workflow.
- Use review-code-dev for a broad read-only review after the focused implementation is complete.

## Implementation playbook

### State and identity

- Identify one source of truth for each piece of state. Keep view-local transient state local;
  keep session, thread, and server state in an injected model/store with a stable lifetime.
- Prefer the project's existing Observation approach. When introducing new observation, use
  the narrowest ownership that preserves identity; use bindings only at the boundary that edits
  state. Avoid creating reference models inside a frequently recomputed View body.
- Make navigation, sheets, alerts, confirmation dialogs, and focus state explicit and
  data-driven. Prefer NavigationStack or NavigationSplitView with stable, value-based routes.
  Deep links and restoration should map to the same route state rather than special-case views.
- Give ForEach and lists stable domain IDs. Do not use array offsets as identity for mutable
  server data, and do not hide identity problems with AnyView.

### Concurrency and data flow

- Keep UI mutations on the main actor and make cross-actor values Sendable. Isolate mutable
  networking/cache state in the existing actor or service rather than sprinkling locks through
  views.
- Use async/await and structured tasks. Tie work to the relevant model or view lifetime with
  task cancellation and task IDs when inputs change. A cancelled task must not publish a stale
  result or error over newer state.
- Avoid starting network work from View initializers or body evaluation. Prevent duplicate
  onAppear work, coalesce refreshes where the existing store expects it, and preserve the
  server's durable ordering and idempotency identifiers.
- Treat polling as state synchronization, not animation. Apply a response only when it belongs
  to the current resource/version and cannot move a newer state backwards. A Viewer read must
  never start lifecycle work.
- Inject clients, clocks, UUID generation, and other effects into testable boundaries. Never
  sleep in tests when an injected clock or deterministic continuation can express the behavior.

### Composition and performance

- Keep views small around behavior boundaries, not arbitrary line counts. Extract a component
  when it owns a meaningful state or accessibility contract, and keep styling close to the
  component's purpose.
- Prefer native controls, labels, contentShape, safeAreaInset, and layout tools before
  custom gesture machinery. Preserve system navigation, keyboard, focus, and Dynamic Type
  behavior rather than fighting the layout engine.
- Use LazyVStack, LazyHStack, and lazy grids for genuinely long collections. Measure before
  optimizing; avoid broad type erasure, repeated expensive formatting, GeometryReader-driven
  layout, and implicit animation churn when a stable layout or memoized value suffices.
- Keep expensive parsing, image work, and sorting out of body. Render bounded previews and
  preserve stable IDs so updates do not rebuild the whole thread.

### Interaction and accessibility

- Give every action a visible label and a VoiceOver label that describes the outcome. Combine
  a row only when its single spoken summary is clearer; otherwise preserve child actions.
- Pair status color with a word such as Online, Starting, Asleep, Error, Healthy, or Unknown.
  Do not use a pulse, glow, or color-only dot to communicate live state.
- Respect environment values for reduced motion and transparency. Replace motion with an
  instantaneous state change and glass/material with an opaque, high-contrast surface when the
  user asks for those reductions.
- Keep loading, empty, error, retry/cancel, permission, and disabled states explicit. Use
  accessibility notifications only for meaningful changes, not every poll.
- Preserve UI automation identifiers for important controls. Test behavior and accessible
  labels, not only pixel snapshots.

## Verification handoff

For a focused change, return: the state model and ownership decision, the concurrency/cancellation
reasoning, accessibility states considered, affected tests, and any visual or tool check still
needed. Then hand off simulator/build/test execution to xcodebuildmcp-cli and the full product
decision to ios-product-dev. If a prerequisite is unavailable, report it rather than using raw
Xcode command-line tools or inventing a passing result.
