---
name: xcodebuildmcp-cli
description: "Use the official XcodeBuildMCP CLI for deterministic Apple-platform discovery, build, test, simulator run, debugging, logs, screenshots, and UI inspection. Use for tool execution and verification, not for product shaping or SwiftUI architecture."
metadata:
  short-description: "Verify Apple-platform builds"
---

# XcodeBuildMCP CLI

Use XcodeBuildMCP as the single tool boundary for iOS, macOS, watchOS, tvOS, and visionOS
project discovery and verification. It exposes Apple developer-tool workflows through a
deterministic CLI and should be used by both Agents and Claude when a task needs a build, test,
simulator launch, screenshot, log, debug, or UI inspection.

## Protected invariants

- Use the xcodebuildmcp executable for discovery, builds, tests, runs, debugging, logs, and UI
  automation. Do not fall back to raw xcodebuild, xcrun, or simctl.
- Discover the installed interface from the executable. Do not assume a remembered tool name,
  workflow, simulator, scheme, or option is current.
- Keep command sequences minimal and observable. Prefer one direct workflow that satisfies the
  request. For simulator run intent, prefer the combined build-and-run workflow; do not chain
  build and build-and-run unless the user explicitly asks.
- Check session defaults/configuration before the first build, run, or test action. Use the
  executable's help to locate the current session-defaults or configuration inspection command.
- Never print, persist, or pass secrets as command arguments. Redact sensitive values from pasted
  output and screenshots. Keep generated artifacts inside the requested or ignored run area.
- A missing CLI is an environment prerequisite, not permission to install software silently. Tell
  the user which official installation options are available and ask for authorization before
  installing or changing the environment.

## Help-first discovery

Run these checks in order, stopping once the actual workflow is known:

    xcodebuildmcp --help
    xcodebuildmcp tools
    xcodebuildmcp <workflow> --help
    xcodebuildmcp <workflow> <tool> --help

Use the tool list and help output to discover project inspection, session configuration, build,
test, simulator, device, log, debug, screenshot, and UI-automation operations. Keep the chosen
scheme, project/workspace path, package path, configuration, destination, and test plan explicit
when the workflow requires them.

## Companion iOS verification

For this repository, read apps/ios/AGENTS.md and apps/ios/README.md before the first action.
Use the existing project/package paths and schemes. A typical focused check is:

- run the Swift package test workflow for apps/ios/CompanionKit;
- build the app for a known iOS simulator;
- use build-and-run when the request includes launching the app;
- inspect the changed screen with UI queries, interaction, accessibility labels, and a screenshot
  when visual behavior matters.

Do not treat a successful compile as proof of product correctness. Check the actual simulator
state and verify loading, empty, error, permission, reduced-motion/transparency, keyboard/safe
area, and long-content states that the change can affect. Preserve the shared /v1 contract and
never use the client as a route to Box or Pi.

## Failure handling and handoff

On failure, preserve the smallest useful command, exit status, relevant help/log excerpt, target
and destination, and the next safe action. Distinguish a source/test failure from an unavailable
simulator, signing issue, missing dependency, or missing CLI. Do not retry an ambiguous external
action automatically when it may have launched or changed state; inspect the tool's session state
first.

Hand implementation and product decisions to ios-product-dev or swiftui-expert-dev. Hand
cross-platform visual decisions to design-frontend-dev. Return a concise verification report with
commands/workflows used, target and destination, checks performed, artifacts or screenshots,
failures, and any unverified paths.

## Exit criteria

- CLI presence is verified, or the missing prerequisite and official installation options are
  reported without an unapproved installation.
- Help and tools discovery establish the workflow and arguments actually used.
- Session defaults/configuration were checked before the first build, run, or test.
- The smallest relevant build/test/run/UI checks completed, and their real results are reported.
