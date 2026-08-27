import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { selectLatestIOSSimulator } from "./select-ios-simulator.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function tomlSection(source, name) {
  const marker = `[${name}]`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing TOML section ${marker}`);
  const next = source.indexOf("\n[", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("Conductor keeps the root stack default and exposes native iOS locally", () => {
  const settings = read(".conductor/settings.toml");
  assert.match(tomlSection(settings, "scripts.run.dev"), /^default = true$/m);

  const ios = tomlSection(settings, "scripts.run.ios");
  assert.match(ios, /^available_in = \["local"\]$/m);
  assert.match(ios, /^command = "pnpm ios:dev"$/m);
  assert.doesNotMatch(settings, /scripts\.run\.mobile-|mobile:android|mobile:metro/);
});

test("the root exposes the native launcher without an Expo workspace exception", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.scripts["ios:dev"], "bash apps/ios/scripts/dev-conductor.sh");
  assert.equal(
    packageJson.scripts["ios:test"],
    "xcodebuildmcp swift-package test --package-path apps/ios/CompanionKit",
  );
  assert.equal(Object.keys(packageJson.scripts).some((name) => name.startsWith("mobile:")), false);
  assert.doesNotMatch(read("pnpm-workspace.yaml"), /apps\/mobile/);
  assert.doesNotMatch(read("scripts/setup-conductor.sh"), /apps\/ios|xcodebuildmcp/i);
});

test("Debug and Release keep distinct native identities and API contracts", () => {
  const shared = read("apps/ios/Config/Shared.xcconfig");
  const debug = read("apps/ios/Config/Debug.xcconfig");
  const release = read("apps/ios/Config/Release.xcconfig");
  const plist = read("apps/ios/Companion/Support/Info.plist");

  assert.match(shared, /^MARKETING_VERSION = 2\.0\.0$/m);
  assert.match(shared, /^DEVELOPMENT_TEAM = K28B69CWQ7$/m);
  assert.match(shared, /^SWIFT_VERSION = 6\.0$/m);
  assert.match(shared, /^IPHONEOS_DEPLOYMENT_TARGET = 26\.0$/m);
  assert.match(debug, /^PRODUCT_BUNDLE_IDENTIFIER = dev\.companion\.mobile\.dev$/m);
  assert.match(debug, /^COMPANION_URL_SCHEME = dev\.companion\.mobile\.dev$/m);
  assert.match(debug, /127\.0\.0\.1:3001/);
  assert.match(release, /^PRODUCT_BUNDLE_IDENTIFIER = dev\.companion\.mobile$/m);
  assert.match(release, /^COMPANION_URL_SCHEME = dev\.companion\.mobile$/m);
  assert.match(release, /api\.thecompanion\.sh/);
  assert.match(plist, /<string>Companion \(623507\)<\/string>/);
  assert.match(plist, /<string>Companion623507<\/string>/);
  assert.match(plist, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  assert.match(plist, /<key>UIUserInterfaceStyle<\/key>\s*<string>Light<\/string>/);
});

test("the iOS app packages the approved light appearance and provider marks", () => {
  const companionMark = read(
    "apps/ios/Companion/Support/Assets.xcassets/CompanionMark.imageset/companion-mark.svg",
  );
  const googleMark = read(
    "apps/ios/Companion/Support/Assets.xcassets/GoogleMark.imageset/google-mark.svg",
  );
  const appIcon = readFileSync(
    resolve(ROOT, "apps/ios/Companion/Support/Assets.xcassets/AppIcon.appiconset/AppIcon.png"),
  );

  assert.match(companionMark, /<svg[^>]+viewBox="0 0 1024 1024"/);
  for (const color of ["#D9622B", "#E9A23B", "#F2C14B"]) {
    assert.match(companionMark, new RegExp(color));
  }
  for (const color of ["#4285F4", "#34A853", "#FBBC05", "#EA4335"]) {
    assert.match(googleMark, new RegExp(color));
  }
  assert.equal(appIcon.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(appIcon.readUInt32BE(16), 1024);
  assert.equal(appIcon.readUInt32BE(20), 1024);
  assert.equal(appIcon[25], 2, "App Store icon must be RGB without alpha");
});

test("full-screen native backdrops stay neutral in every state", () => {
  const glassComponents = read("apps/ios/Companion/DesignSystem/GlassComponents.swift");
  const backdrop = glassComponents.slice(
    glassComponents.indexOf("struct CompanionBackdrop"),
    glassComponents.indexOf("extension View"),
  );
  const backdropCallers = [
    "apps/ios/Companion/Navigation/RootView.swift",
    ...readdirSync(resolve(ROOT, "apps/ios/Companion/Screens"))
      .filter((file) => file.endsWith(".swift"))
      .map((file) => `apps/ios/Companion/Screens/${file}`),
  ].map(read).join("\n");
  const managementComponents = read(
    "apps/ios/Companion/DesignSystem/ManagementComponents.swift",
  );

  assert.match(backdrop, /Color\.companionCanvas\s*\n\s*\.ignoresSafeArea\(\)/);
  assert.deepEqual(
    [...backdrop.matchAll(/\bColor\.[A-Za-z]\w*/g)].map(([color]) => color),
    ["Color.companionCanvas"],
  );
  assert.doesNotMatch(
    backdrop,
    /CompanionBackdropStyle|case \.companion|GeometryReader|\.fill\(|\.opacity\(|\.(?:red|companionAccent|companionDanger)\b/,
  );
  assert.doesNotMatch(backdropCallers, /CompanionBackdrop\s*\(\s*style:/);
  assert.doesNotMatch(
    managementComponents,
    /\.background\s*(?:\(\s*(?:(?:Color)?\.)?(?:companionDanger|red)\b|\{[\s\S]{0,120}?(?:companionDanger|Color\.red|\.red\b))/,
  );
});

test("chat content stays neutral while Companion accents remain on actions and identity", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const composer = read("apps/ios/Companion/Screens/ChatComposer.swift");
  const bubble = chat.slice(
    chat.indexOf("struct ChatMessageBubble"),
    chat.indexOf("struct CompanionThinkingDisclosure"),
  );
  const decisionCard = read("apps/ios/Companion/Screens/CompanionDecisionCard.swift");
  const glassChatDemo = read("apps/ios/Companion/Screens/GlassChatDemoView.swift");
  const glassDemoBubbles = glassChatDemo.slice(
    glassChatDemo.indexOf("ChatMessageBubble("),
    glassChatDemo.indexOf(".accessibilityIdentifier(message.accessibilityIdentifier)"),
  );
  const queuedDemo = read("apps/ios/Companion/Screens/CompanionQueuedMessagesDemoView.swift");
  const queuedDemoBubbles = queuedDemo.slice(
    queuedDemo.indexOf("ChatMessageBubble("),
    queuedDemo.indexOf(".padding(16)"),
  );

  assert.match(bubble, /\.companionMaterial\(radius: 18\)/);
  assert.match(
    bubble,
    /MarkdownMessageView\([\s\S]{0,120}?document: markdown,[\s\S]{0,120}?accent: \.companionInk/,
  );
  assert.doesNotMatch(bubble, /var accent\b|accent\.opacity|visualTheme\.accent|tint:/);
  assert.doesNotMatch(chat, /\.toolbar \{ headerToolbar \}\s*\.tint\(visualTheme\.accent\)/);
  assert.match(composer, /\.buttonStyle\(\.glassProminent\)\s*\.buttonBorderShape\(\.circle\)\s*\.tint\(accent\)/);
  assert.doesNotMatch(decisionCard, /pending \? accent\.opacity/);
  assert.doesNotMatch(glassDemoBubbles, /accent:|tint:/);
  assert.doesNotMatch(queuedDemoBubbles, /accent:|tint:/);
  assert.doesNotMatch(
    glassChatDemo,
    /\.navigationBarTitleDisplayMode\(\.inline\)\s*\.tint\(visualTheme\.accent\)/,
  );
});

test("long-thread composer and poll work stay behind narrow invalidation boundaries", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const composer = read("apps/ios/Companion/Screens/ChatComposer.swift");
  const coordination = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/CompanionThreadCoordination.swift",
  );
  const sessionStore = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/SessionStore.swift",
  );

  assert.doesNotMatch(chat, /@State private var draft\b/);
  assert.match(chat, /ChatComposer\(/);
  assert.match(composer, /@State private var draft = ""/);
  assert.match(chat, /TranscriptRowView: View, @MainActor Equatable/);
  assert.match(chat, /TranscriptRowView\([\s\S]*?\.equatable\(\)/);
  assert.match(chat, /CompanionTranscriptPollDiff\(/);
  assert.match(chat, /if previousThread != next\s*\{\s*threadProjection\.update\(next\)/);
  assert.match(coordination, /public struct CompanionTranscriptPollDiff: Equatable, Sendable/);
  assert.equal(
    (chat.match(/refreshGate\.invalidate\(\)\s*\n\s*threadProjection\.replaceAfterMutation/g) ?? []).length,
    2,
    "authoritative decision and cancellation responses must fence polls started during the mutation",
  );
  assert.match(sessionStore, /private var persistedSession: Session\?/);
  assert.match(sessionStore, /if persistedSession != authority \{/);
});

test("native message interactions stay accessible and CI-verifiable without Xcode", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const interactions = read(
    "apps/ios/Companion/Support/MessageInteractionSupport.swift",
  );
  const markdown = read("apps/ios/Companion/Screens/MarkdownMessageView.swift");
  const queued = read("apps/ios/Companion/Screens/CompanionQueuedMessagesView.swift");
  const queuedDemo = read("apps/ios/Companion/Screens/CompanionQueuedMessagesDemoView.swift");
  const uiTests = read("apps/ios/CompanionUITests/CompanionUITests.swift");
  const readme = read("apps/ios/README.md");
  const ci = read(".github/workflows/ci.yml");

  assert.match(chat, /\.companionMessageInteractionMenu\(rawContent: content\)/);
  assert.match(chat, /allowsTextSelection: false/);
  for (const action of ["Copy", "Share", "Select Text"]) {
    assert.match(interactions, new RegExp(`Label\\("${action}"`));
  }
  assert.match(interactions, /UIPasteboard\.general\.string = rawContent/);
  assert.match(interactions, /presentedSheet = \.share\(rawContent\)/);
  assert.match(interactions, /presentedSheet = \.selectText\(rawContent\)/);
  assert.match(interactions, /\.sensoryFeedback\(\.success, trigger: copyFeedbackTrigger\)/);
  assert.match(
    interactions,
    /\.sensoryFeedback\(\.impact\(weight: \.light\), trigger: shareFeedbackTrigger\)/,
  );
  assert.match(interactions, /UIAccessibility\.post\(notification: \.announcement/);
  assert.match(interactions, /\.contentShape\(\.rect\)\s*\.contextMenu/);
  assert.match(interactions, /\.textSelection\(\.enabled\)/);

  assert.match(markdown, /\.frame\(minWidth: 44, minHeight: 44\)/);
  assert.match(markdown, /UIPasteboard\.general\.string = code/);
  assert.match(markdown, /\.sensoryFeedback\(\.success, trigger: copyFeedbackTrigger\)/);
  assert.match(markdown, /accessibilityReduceMotion/);
  assert.match(markdown, /accessibilityIdentifier\("markdown\.code-copy\.\\\(identifier\)"\)/);

  assert.match(queued, /entry\.authorID == viewerID/);
  assert.match(queued, /removingTurnID == nil/);
  assert.match(queued, /Button\("Delete", systemImage: "trash", role: \.destructive\)/);
  assert.match(
    queued,
    /Button\("Delete", systemImage: "trash", role: \.destructive\) \{\s*requestRemoval\(of: entry\)/,
  );
  assert.match(queuedDemo, /viewerID: viewerID/);
  assert.match(uiTests, /testMessageLongPressOffersCopyShareAndSelectableText/);
  assert.match(uiTests, /testMarkdownCodeBlockCopyShowsSuccessStateAndNativeHitTarget/);
  assert.match(uiTests, /testQueuedOwnMessageContextDeleteUsesExistingRemoval/);
  assert.match(uiTests, /testQueuedTeammateContextDeleteIsUnavailableToEditor/);
  for (const testName of [
    "testMessageLongPressOffersCopyShareAndSelectableText",
    "testMarkdownCodeBlockCopyShowsSuccessStateAndNativeHitTarget",
    "testQueuedOwnMessageContextDeleteUsesExistingRemoval",
    "testQueuedTeammateContextDeleteIsUnavailableToEditor",
  ]) {
    assert.match(ci, new RegExp(`-only-testing:CompanionUITests/CompanionUITests/${testName}`));
  }
  assert.match(readme, /Reply or thread\s+actions and regenerate are deliberately out of scope/);
});

test("the chat scroll-to-bottom control floats over the transcript", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const transcript = chat.slice(
    chat.indexOf('.accessibilityIdentifier("chat.transcript")'),
    chat.indexOf("bottomControls(", chat.indexOf('.accessibilityIdentifier("chat.transcript")')),
  );

  assert.match(transcript, /\.overlay\(alignment: \.bottomTrailing\)/);
  assert.match(transcript, /scrollToBottomButton\s*\{/);
  assert.match(transcript, /\.padding\(\.trailing, 16\)/);
  assert.match(transcript, /\.padding\(\.bottom, 12\)/);
  assert.match(transcript, /reduceMotion\s*\n\s*\? \.identity/);

  const button = chat.slice(
    chat.indexOf("private func scrollToBottomButton"),
    chat.indexOf("private func dayMarker"),
  );
  assert.match(button, /\.buttonStyle\(\.glass\)/);
  assert.equal(button.match(/Button\(action: action\)/g)?.length, 1);
  assert.match(button, /\.buttonBorderShape\(unseenCount > 0 \? \.capsule : \.circle\)/);
  assert.match(button, /\.shadow\(color: visualTheme\.shadow\.opacity\(0\.2\), radius: 8, y: 3\)/);
});

test("native transcript taps dismiss the keyboard without consuming message controls", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const uiTests = read("apps/ios/CompanionUITests/CompanionUITests.swift");
  const ci = read(".github/workflows/ci.yml");
  const readme = read("apps/ios/README.md");
  const transcript = chat.slice(
    chat.indexOf(".scrollDismissesKeyboard(.interactively)"),
    chat.indexOf("bottomControls(", chat.indexOf('.accessibilityIdentifier("chat.transcript")')),
  );

  assert.match(transcript, /\.scrollDismissesKeyboard\(\.interactively\)/);
  assert.match(
    chat,
    /struct TranscriptKeyboardDismissGesture: UIGestureRecognizerRepresentable/,
  );
  assert.match(chat, /recognizer\.cancelsTouchesInView = false/);
  assert.match(chat, /shouldRecognizeSimultaneouslyWith/);
  assert.match(chat, /recognizer\.delegate = context\.coordinator/);
  assert.match(chat, /\) -> Bool \{\s*true\s*\}/);
  assert.match(
    transcript,
    /\.gesture\(\s*TranscriptKeyboardDismissGesture \{\s*UIApplication\.shared\.sendAction\(/,
  );
  assert.match(chat, /#selector\(UIResponder\.resignFirstResponder\)/);
  assert.doesNotMatch(chat, /composerKeyboardDismissalRequest/);
  assert.match(uiTests, /testTranscriptTapDismissesKeyboardWithoutBlockingMessageControls/);
  assert.match(uiTests, /identifier == %@", "chat\.transcript"/);
  assert.match(uiTests, /transcript\.coordinate\(withNormalizedOffset:[\s\S]*?\)\.tap\(\)/);
  assert.match(uiTests, /predicate: NSPredicate\(format: "exists == false"\)/);
  assert.match(uiTests, /label CONTAINS %@", "run_layout_checks"/);
  assert.match(uiTests, /for _ in 0\.\.<3 where !toolCard\.isHittable \{\s*app\.swipeUp\(\)/);
  assert.match(uiTests, /XCTAssertTrue\(toolCard\.isHittable\)/);
  assert.match(uiTests, /toolCard\.tap\(\)/);
  assert.match(uiTests, /\["tool-run\.detail"\]\.waitForExistence/);
  assert.match(
    ci,
    /-only-testing:CompanionUITests\/CompanionUITests\/testTranscriptTapDismissesKeyboardWithoutBlockingMessageControls/,
  );
  assert.match(readme, /Keyboard-dismissal regressions use the same static-plus-Apple-Quality split/);
  assert.match(readme, /The focus change is intentionally silent/);
});

test("native chat reading restoration stays deterministic and delegated to Apple Quality", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const roster = read("apps/ios/Companion/Screens/CompanionListView.swift");
  const coordination = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/CompanionThreadCoordination.swift",
  );
  const uiTests = read("apps/ios/CompanionUITests/CompanionUITests.swift");
  const ci = read(".github/workflows/ci.yml");

  assert.match(roster, /CompanionChatReadingPositionStore\(\)/);
  assert.match(roster, /readingPosition: chatReadingPositions\.position\(for: companionID\)/);
  assert.match(chat, /private let readingPosition: CompanionChatReadingPosition\?/);
  assert.match(chat, /self\.readingPosition = readingPosition/);
  assert.match(chat, /\.onScrollTargetVisibilityChange\(/);
  assert.match(chat, /isRestoringReadingPosition \? 0 : 1/);
  assert.match(chat, /previousThread != nil/);
  assert.match(chat, /CompanionScrollCoordinator/);
  assert.match(chat, /scrollCoordinator\.takePendingRequest\(\)/);
  assert.match(chat, /\.onScrollPhaseChange/);
  assert.match(chat, /scrollCoordinator\.beginUserInteraction/);
  assert.doesNotMatch(chat, /\.defaultScrollAnchor\(/);
  const acceptedThread = chat.indexOf("threadProjection.update(next)");
  const observedTail = chat.indexOf("let tailChanged = observeActualTail", acceptedThread);
  assert.notEqual(acceptedThread, -1);
  assert.ok(observedTail > acceptedThread);
  assert.match(chat, /let renderedScrollRevision = scrollContentRevision/);
  const scrollRevisionObserver = chat.indexOf(".task(id: renderedScrollDeliveryRevision)");
  const deferredScrollDelivery = chat.indexOf("await Task.yield()", scrollRevisionObserver);
  const consumedScrollRequest = chat.indexOf(
    "scrollCoordinator.takePendingRequest()",
    scrollRevisionObserver,
  );
  assert.notEqual(scrollRevisionObserver, -1);
  assert.ok(deferredScrollDelivery > scrollRevisionObserver);
  assert.ok(consumedScrollRequest > deferredScrollDelivery);
  assert.match(
    chat.slice(deferredScrollDelivery, consumedScrollRequest),
    /renderedScrollDeliveryRevision\.contentRevision\s*== scrollContentRevision/,
  );
  const lazyTranscriptTargets = chat.indexOf(".scrollTargetLayout()");
  const eagerBottomTarget = chat.indexOf('.id("bottom")', lazyTranscriptTargets);
  assert.notEqual(lazyTranscriptTargets, -1);
  assert.ok(eagerBottomTarget > lazyTranscriptTargets);
  const initialLayoutHandshake = chat.indexOf(
    ".onGeometryChange(for: BottomDestinationLayoutSignal.self)",
    lazyTranscriptTargets,
  );
  assert.ok(initialLayoutHandshake > eagerBottomTarget);
  assert.match(
    chat.slice(initialLayoutHandshake, chat.indexOf("bottomControls(", initialLayoutHandshake)),
    /markInitialBottomReady/,
  );
  assert.match(
    chat.slice(deferredScrollDelivery, consumedScrollRequest),
    /pendingRequest\.source == \.initial[\s\S]*initialBottomReadyRevision/,
  );
  assert.equal(chat.match(/scrollCoordinator\.takePendingRequest\(\)/g)?.length, 1);
  assert.match(chat, /batches=\\\(scrollCoordinator\.issuedRequestBatchCount\)/);
  assert.match(uiTests, /Scroll diagnostics:/);
  const scrollOwner = chat.indexOf("private func performScroll");
  assert.notEqual(scrollOwner, -1);
  assert.doesNotMatch(chat.slice(0, scrollOwner), /transcriptScrollPosition\.scrollTo\(/);
  assert.match(chat.slice(scrollOwner), /transcriptScrollPosition\.scrollTo\(/);
  assert.doesNotMatch(chat, /ScrollViewReader/);
  assert.match(chat, /\.scrollPosition\(\$transcriptScrollPosition\)/);
  assert.match(chat, /transcriptScrollPosition = ScrollPosition\(idType: String\.self\)/);
  assert.match(chat.slice(scrollOwner), /let targetID = bottomScrollTargetID/);
  assert.doesNotMatch(chat.slice(scrollOwner), /proxy\.scrollTo\("bottom"/);
  assert.match(chat, /return entries\.last\?\.id \?\? "bottom"/);
  assert.doesNotMatch(chat, /requestScroll\(to: \.bottom\)/);
  assert.match(coordination, /func position\(for companionID: String\)/);
  assert.match(coordination, /public mutating func restore\(/);
  assert.match(coordination, /public struct CompanionScrollCoordinator/);
  assert.match(coordination, /case followingTail/);
  assert.match(coordination, /case userReading/);
  assert.match(coordination, /issuedRequestBatchCount/);
  assert.match(uiTests, /testTranscriptWindowDemoRestoresReadingPositionAfterCompanionSwitch/);
  assert.match(uiTests, /testTranscriptWindowDemoStaysAtLatestAcrossPollInterval/);
  assert.match(
    ci,
    /-only-testing:CompanionUITests\/CompanionUITests\/testTranscriptWindowDemoRestoresReadingPositionAfterCompanionSwitch/,
  );
  assert.match(
    ci,
    /-only-testing:CompanionUITests\/CompanionUITests\/testTranscriptWindowDemoStaysAtLatestAcrossPollInterval/,
  );
  assert.match(read("apps/ios/README.md"), /four-second poll/);
});

test("the project is synchronized, shared, and backed by CompanionKit", () => {
  const project = read("apps/ios/Companion.xcodeproj/project.pbxproj");
  const scheme = read("apps/ios/Companion.xcodeproj/xcshareddata/xcschemes/Companion.xcscheme");
  const workspace = read("apps/ios/Companion.xcworkspace/contents.xcworkspacedata");

  assert.match(project, /PBXFileSystemSynchronizedRootGroup/);
  assert.match(project, /productName = CompanionKit/);
  assert.match(scheme, /BlueprintName = "Companion"/);
  assert.match(workspace, /group:CompanionKit/);
  assert.doesNotMatch(
    read("apps/ios/CompanionKit/Sources/CompanionKit/CompanionKit.swift"),
    /native_mobile|clientSurface/,
  );
  assert.match(read("apps/ios/README.md"), /same\s+`\/v1` API/);
});

test("reply notifications embed the locally rendered avatar service extension", () => {
  const project = read("apps/ios/Companion.xcodeproj/project.pbxproj");
  const appInfo = read("apps/ios/Companion/Support/Info.plist");
  const extensionInfo = read("apps/ios/CompanionNotificationService/Info.plist");
  const entitlements = read("apps/ios/Config/Companion.entitlements");

  assert.match(project, /CompanionNotificationService\.appex in Embed App Extensions/);
  assert.match(project, /productName = CompanionNotificationAvatar/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = dev\.companion\.mobile\.dev\.notifyextension/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = dev\.companion\.mobile\.notifyextension/);
  assert.match(extensionInfo, /com\.apple\.usernotifications\.service/);
  assert.match(extensionInfo, /\$\(PRODUCT_MODULE_NAME\)\.NotificationService/);
  assert.match(appInfo, /<string>INSendMessageIntent<\/string>/);
  assert.match(entitlements, /com\.apple\.developer\.usernotifications\.communication/);
});

test("the Expo client and its repository-local skills are gone", () => {
  assert.equal(existsSync(resolve(ROOT, "apps/mobile")), false);
  assert.equal(existsSync(resolve(ROOT, "skills-lock.json")), false);
  for (const root of [".agents/skills", ".claude/skills"]) {
    for (const skill of ["eas-app-stores", "eas-workflows", "expo-overview", "expo-router", "vercel-react-native-skills"]) {
      assert.equal(existsSync(resolve(ROOT, root, skill)), false, `${root}/${skill}`);
    }
  }
});

test("Agents and Claude share the durable native iOS skill surface", () => {
  const packages = {
    "ios-product-dev": ["SKILL.md", "SOURCE.md", "companion.json", "evals/evals.json"],
    "swiftui-expert-dev": ["SKILL.md", "SOURCE.md", "companion.json", "evals/evals.json"],
    "xcodebuildmcp-cli": ["SKILL.md", "SOURCE.md", "LICENSE", "companion.json", "evals/evals.json"],
  };

  for (const [skill, files] of Object.entries(packages)) {
    for (const file of files) {
      const agentsPath = `.agents/skills/${skill}/${file}`;
      const claudePath = `.claude/skills/${skill}/${file}`;
      assert.equal(existsSync(resolve(ROOT, agentsPath)), true, agentsPath);
      assert.equal(existsSync(resolve(ROOT, claudePath)), true, claudePath);
      assert.equal(read(agentsPath), read(claudePath), `${skill}/${file} must stay mirrored`);
    }
    const manifest = JSON.parse(read(`.agents/skills/${skill}/companion.json`));
    const evals = JSON.parse(read(`.agents/skills/${skill}/evals/evals.json`));
    assert.equal(manifest.name, skill);
    assert.equal(evals.skill_name, skill);
    assert.equal(evals.evals.length, 4);
  }
});

test("the iOS launcher derives the API port from Conductor and uses XcodeBuildMCP", () => {
  const launcher = read("apps/ios/scripts/dev-conductor.sh");
  assert.match(launcher, /API_PORT="\$\(\(BASE_PORT \+ 1\)\)"/);
  assert.match(launcher, /xcodebuildmcp simulator build-and-run/);
  assert.match(launcher, /xcodebuildmcp simulator list --output json/);
  assert.match(launcher, /simulator\.get\("state"\) == "Booted"/);
  assert.match(launcher, /SIMULATOR_ARGS=\(--simulator-id/);
  assert.match(launcher, /-COMPANION_API_URL/);
  assert.doesNotMatch(launcher, /iPhone 17|\bxcodebuild\b|\bxcrun\b|\bsimctl\b/);
});

test("CI tests iOS without secrets and keeps the live provider diagnostic manual", () => {
  const ci = read(".github/workflows/ci.yml");
  const e2e = read(".github/workflows/ios-e2e.yml");

  assert.match(ci, /^  apple-quality:$/m);
  assert.match(ci, /^    runs-on: macos-26$/m);
  assert.match(ci, /if: needs\.scope\.outputs\.skill == 'true' \|\| needs\.scope\.outputs\.ios == 'true'/);
  assert.doesNotMatch(ci, /xcodebuildmcp/i);
  assert.match(ci, /swift test --package-path apps\/ios\/CompanionKit/);
  assert.match(ci, /xcodebuild test/);
  assert.match(ci, /testTranscriptWindowDemoLoadsEarlierMessages/);
  assert.match(ci, /testTranscriptWindowDemoRestoresReadingPositionAfterCompanionSwitch/);
  assert.match(ci, /testTranscriptWindowDemoShowsStagedUnseenReplyAndScrollsToIt/);
  assert.match(ci, /testTranscriptWindowDemoKeepsLatestEntriesOrderedAndSeparated/);
  assert.match(ci, /testTranscriptWindowDemoBottomControlsNeverCoverChatContent/);
  assert.match(ci, /testMarkdownTableDemoKeepsRowsAndColumnsSeparated/);
  assert.doesNotMatch(ci, /testChatPhotoLibraryOpensOnFirstSelectionWithKeyboardVisible/);
  assert.match(ci, /xcrun simctl list devices available --json/);
  assert.match(ci, /node scripts\/select-ios-simulator\.mjs/);
  assert.doesNotMatch(ci, /^  skill-guards-macos:$/m);
  assert.doesNotMatch(ci, /^  ios-quality:$/m);
  assert.doesNotMatch(ci, /^  schedule:$/m);
  assert.doesNotMatch(ci, /^  workflow_dispatch:$/m);
  assert.match(e2e, /^name: "Diagnostic: iOS Live E2E"$/m);
  assert.doesNotMatch(e2e, /xcodebuildmcp/i);
  assert.match(e2e, /swift test --package-path apps\/ios\/CompanionKit/);
  assert.match(e2e, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(e2e, /^  schedule:$/m);
  assert.doesNotMatch(e2e, /^  pull_request:/m);
  assert.doesNotMatch(e2e, /^  push:/m);
  assert.match(e2e, /^    environment: ios-e2e$/m);
  assert.match(e2e, /COMPANION_BOX_API_KEY: \$\{\{ secrets\.COMPANION_BOX_E2E_API_KEY \}\}/);
  assert.match(e2e, /node scripts\/ios-e2e-fixture\.mjs prepare/);
  assert.match(e2e, /node scripts\/ios-e2e-fixture\.mjs cleanup/);
});

test("voice transcription keeps the global key server-side and delegates Apple checks", () => {
  const composer = read("apps/ios/Companion/Screens/ChatComposer.swift");
  const routes = read("apps/api/src/companionRoutes.ts");
  const envExample = read(".env.example");
  const status = read("apps/ios/Companion/Screens/VoiceTranscriptionStatusView.swift");
  const controller = read("apps/ios/Companion/Support/VoiceTranscriptionController.swift");
  const client = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/GeminiLiveTranscription.swift",
  );
  const info = read("apps/ios/Companion/Support/Info.plist");
  const tests = read(
    "apps/ios/CompanionKit/Tests/CompanionKitTests/GeminiLiveTranscriptionTests.swift",
  );
  const uiTests = read("apps/ios/CompanionUITests/CompanionUITests.swift");
  const ci = read(".github/workflows/ci.yml");

  assert.match(composer, /accessibilityIdentifier\("chat\.transcription\.toggle"\)/);
  assert.match(composer, /if transcriptionAvailable \{/);
  assert.match(composer, /onChange\(of: transcriptionAvailable\)/);
  assert.match(composer, /frame\(width: 46, height: 46\)/);
  assert.match(routes, /COMPANION_GEMINI_TRANSCRIPTION_API_KEY\?\.trim\(\)/);
  assert.match(routes, /transcription_available: transcriptionAvailable/);
  assert.match(envExample, /^COMPANION_GEMINI_TRANSCRIPTION_API_KEY=$/m);
  assert.match(status, /Audio is sent to Google while recording\./);
  assert.match(controller, /AVAudioApplication\.requestRecordPermission/);
  assert.match(controller, /sampleRate: 16_000/);
  assert.match(controller, /private var finishTask: Task<Void, Never>\?/);
  assert.match(controller, /guard generation == activeGeneration/);
  assert.match(controller, /finalTranscript = ""/);
  assert.doesNotMatch(composer, /Task \{ await transcription\.cancel\(\) \}/);
  assert.match(composer, /transcription\.cancel\(\)/);
  assert.match(composer, /onChange\(of: canSend\)/);
  assert.match(client, /if isFinishing \{\s*try await sendAudioStreamEnd/);
  assert.match(client, /BidiGenerateContentConstrained/);
  assert.match(client, /models\/\\\(Self\.model\)/);
  assert.match(client, /"SMART"/);
  assert.match(client, /audio\/pcm;rate=16000/);
  assert.doesNotMatch(client, /AIza[0-9A-Za-z_-]{20,}/);
  assert.match(info, /<key>NSMicrophoneUsageDescription<\/key>/);
  assert.match(tests, /connectsStreamsPCMAndPublishesTranscriptDeltas/);
  assert.match(tests, /resumesOnceAndFlushesBoundedAudioAfterGoAway/);
  assert.match(uiTests, /testChatComposerExposesAccessibleVoiceTranscriptionControl/);
  assert.match(uiTests, /testChatComposerHidesVoiceTranscriptionWithoutDeploymentKey/);
  assert.match(ci, /swift test --package-path apps\/ios\/CompanionKit/);
  assert.match(ci, /xcodebuild test/);
  assert.doesNotMatch(ci, /xcodebuildmcp/i);
});

test("the staged reply fixture is armed only after the UI reader leaves the tail", () => {
  const chatView = read("apps/ios/Companion/Screens/ChatView.swift");
  const demo = read("apps/ios/Companion/Screens/CompanionTranscriptWindowDemoView.swift");
  const uiTests = read("apps/ios/CompanionUITests/CompanionUITests.swift");

  assert.match(
    demo,
    /@State private var stagedFixture = CompanionTranscriptWindowDemoFixtures\.makeStagedFixture\(\)/,
  );
  assert.match(demo, /services\(\s*stagedFixture: stagedFixture\s*\)/);
  assert.match(demo, /stagedFixture\.deliveredStagedReply \? "Reply delivered" : "Stage reply"/);
  assert.match(demo, /accessibilityIdentifier\("demo\.stage-reply"\)/);
  assert.match(demo, /guard stagesNextPoll else \{ return initial \}/);
  assert.match(uiTests, /let unseen = app\.buttons\["chat\.scroll-to-bottom"\]/);
  assert.match(uiTests, /let stageReply = app\.buttons\["demo\.stage-reply"\]/);
  assert.match(uiTests, /stageReply\.tap\(\)/);
  assert.match(uiTests, /label == %@", "Reply delivered"/);
  assert.match(uiTests, /let plainButtonWidth = unseen\.frame\.width/);
  assert.match(uiTests, /element\.frame\.width > plainButtonWidth \+ 40/);
  assert.match(demo, /"event_id": "staged-reply"/);
  assert.match(chatView, /@State private var unseenCount = 0/);
  assert.match(chatView, /var nextUnseenTracker = unseenTracker/);
  assert.match(chatView, /unseenTracker = nextUnseenTracker/);
  assert.match(chatView, /unseenCount = nextUnseenCount/);
  assert.match(chatView, /let readerWasNearBottom = isNearBottom/);
  assert.match(chatView, /let readerIsNearBottom = isNearBottom/);
  assert.match(chatView, /isNearBottom: readerIsNearBottom/);
  assert.match(chatView, /completedReveal\.followsTail, isNearBottom, !loadingEarlier/);
  assert.match(chatView, /source: \.poll,\s+animated: false/);
});

test("GitHub Actions never installs or invokes XcodeBuildMCP", () => {
  const workflows = readdirSync(resolve(ROOT, ".github/workflows"))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));

  for (const workflow of workflows) {
    assert.doesNotMatch(
      read(`.github/workflows/${workflow}`),
      /xcodebuildmcp/i,
      `${workflow} must use native Apple command-line tools`,
    );
  }
});

test("dependency auditing stays inside Quality and Pi publishing remains narrowly scoped", () => {
  const ci = read(".github/workflows/ci.yml");
  const quality = ci.slice(ci.indexOf("  quality:"), ci.indexOf("  application-build:"));
  const pi = read(".github/workflows/pi-bundle.yml");

  assert.match(quality, /if: needs\.scope\.outputs\.dependencies == 'true'/);
  assert.match(quality, /audit --prod --audit-level=high/);
  assert.doesNotMatch(ci, /^  dependency-audit:$/m);
  assert.doesNotMatch(ci, /^  coverage:$/m);
  assert.match(pi, /^name: "Publish: Pi Bundle"$/m);
  assert.match(pi, /^  workflow_dispatch:$/m);
  assert.match(pi, /^  push:$/m);
  for (const path of [
    "packages/box-runtime/src/piBundle.ts",
    "scripts/build-pi-bundle.sh",
    "scripts/upload-pi-bundle.mjs",
    ".github/workflows/pi-bundle.yml",
  ]) {
    assert.match(pi, new RegExp(`      - "${path.replaceAll(".", "\\.")}"`));
  }
});

test("the CI simulator selector ignores other Apple platforms and chooses the latest iOS", () => {
  const selected = selectLatestIOSSimulator({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.visionOS-26-0": [
        { udid: "vision", isAvailable: true },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-25-4": [
        { udid: "ios-older", isAvailable: true },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
        { udid: "ios-unavailable", isAvailable: false },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
        { udid: "ios-latest", isAvailable: true },
      ],
    },
  });

  assert.equal(selected.simulatorId, "ios-latest");
  assert.throws(
    () => selectLatestIOSSimulator({
      devices: { "com.apple.CoreSimulator.SimRuntime.visionOS-26-0": [{ udid: "vision" }] },
    }),
    /No available iOS simulator/,
  );
});
