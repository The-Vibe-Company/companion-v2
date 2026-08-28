#if DEBUG
import SwiftUI
import CompanionKit

struct GlassChatDemoView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft = ""
    @State private var replying = ProcessInfo.processInfo.arguments.contains("-glass-chat-thinking-demo")
    @State private var messages = DemoMessage.samples
    @State private var expandedReasoningEventIDs: Set<String> = []
    @State private var showRoster = false
    @State private var showDesignInfo = false
    @State private var markdownByEventID: [String: CachedMarkdownDocument] = [:]
    @State private var selectedToolDetail: ToolRunDetailRoute?

    private let companionName = "Companion"
    private let icon = CompanionSummary.Icon(shape: 1, mouth: 1, accessory: 6, color: 7)
    private let holdsReplyingForEvidence = ProcessInfo.processInfo.arguments.contains(
        "-companion-avatar-ui-evidence"
    )
    private let exposesMarkdownCacheTest = ProcessInfo.processInfo.arguments.contains(
        "-markdown-cache-ui-test"
    )
    private let exposesThinkingDemo = ProcessInfo.processInfo.arguments.contains(
        "-glass-chat-thinking-demo"
    )

    private var visualTheme: CompanionVisualTheme {
        CompanionVisualTheme(icon: icon)
    }

    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            Text("Aujourd’hui")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.companionMuted)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(CompanionIOSTheme.card, in: Capsule())

                            ForEach(messages) { message in
                                Group {
                                    if let tool = message.tool {
                                        CompanionToolRunCard(tool: tool, eventID: message.eventID) {
                                            selectedToolDetail = ToolRunDetailRoute(
                                                id: message.eventID,
                                                tool: tool,
                                                timestamp: message.timestamp
                                            )
                                        }
                                    } else {
                                        ChatMessageBubble(
                                            content: message.content,
                                            kind: message.kind,
                                            authorName: message.author,
                                            timestamp: message.timestamp,
                                            companionName: companionName,
                                            icon: icon,
                                            markdown: markdownByEventID[message.eventID]?.document,
                                            reasoning: message.reasoning,
                                            reasoningExpansion: reasoningBinding(for: message.eventID)
                                        )
                                    }
                                }
                                .accessibilityIdentifier(message.accessibilityIdentifier)
                                .id(message.id)
                            }

                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 18)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .scrollIndicators(.hidden)
                    .defaultScrollAnchor(.bottom)
                    .safeAreaInset(edge: .bottom) {
                        composer(onThinkingTap: { revealLiveReasoning(using: proxy) })
                    }
                    .onChange(of: messages.count + (replying ? 1 : 0)) {
                        if reduceMotion {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        } else {
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo("bottom", anchor: .bottom)
                            }
                        }
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showRoster = true } label: {
                        Image(systemName: "line.3.horizontal")
                    }
                    .tint(visualTheme.accent)
                    .accessibilityLabel("Ouvrir les conversations")
                }

                ToolbarItem(placement: .principal) {
                    HStack(spacing: 9) {
                        CompanionAvatar(
                            name: companionName,
                            icon: icon,
                            size: 32,
                            state: replying ? .thinking : .idle
                        )
                        VStack(alignment: .leading, spacing: 1) {
                            Text(companionName)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color.companionInk)
                            HStack(spacing: 4) {
                                Circle().fill(Color.companionSuccess).frame(width: 6, height: 6)
                                Text(replying ? "Répond…" : "En ligne")
                            }
                            .font(.caption2)
                            .foregroundStyle(Color.companionMuted)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("À propos du design", systemImage: "info.circle") {
                            showDesignInfo = true
                        }
                        Button("Réinitialiser la démo", systemImage: "arrow.counterclockwise") {
                            messages = DemoMessage.samples
                            draft = ""
                            replying = false
                            expandedReasoningEventIDs.removeAll()
                        }
                        if exposesMarkdownCacheTest {
                            Button("Actualiser le Markdown", systemImage: "arrow.triangle.2.circlepath") {
                                refreshMarkdownFixture()
                            }
                            .accessibilityIdentifier("demo.markdown.refresh-cache")
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .tint(visualTheme.accent)
                    .accessibilityLabel("Options de la conversation")
                }
            }
            .sheet(isPresented: $showRoster) {
                GlassRosterDemoView()
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(item: $selectedToolDetail) { route in
                CompanionToolRunDetailView(tool: route.tool, timestamp: route.timestamp)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
            .alert("Liquid Glass, avec intention", isPresented: $showDesignInfo) {
                Button("OK", role: .cancel) { }
            } message: {
                Text("Les contrôles utilisent le Liquid Glass natif d’iOS 26. Les messages restent sur des matériaux système pour préserver le contraste et la lecture.")
            }
            .task(id: markdownSources) {
                let rendered = await MarkdownDocumentRenderer.render(
                    sources: markdownSources,
                    reusing: markdownByEventID
                )
                guard !Task.isCancelled else { return }
                markdownByEventID = rendered
            }
            .onChange(of: replying) { oldValue, newValue in
                if oldValue && !newValue {
                    expandedReasoningEventIDs.removeAll()
                }
            }
        }
    }

    private var markdownSources: [MarkdownDocumentSource] {
        messages.compactMap { message in
            guard message.kind == .assistant, message.tool == nil else { return nil }
            return MarkdownDocumentSource(eventID: message.eventID, content: message.content)
        }
    }

    private func refreshMarkdownFixture() {
        guard let index = messages.firstIndex(where: { $0.isMarkdownFixture }) else { return }
        messages[index].content = """
        ## Rapport actualisé

        Le même événement affiche maintenant un **contenu renouvelé**.
        """
    }

    private var liveReasoningMessageID: String? {
        guard replying, exposesThinkingDemo else { return nil }
        return messages.reversed().first { message in
            message.kind == .assistant
                && message.tool == nil
                && !message.displayReasoning.isEmpty
        }?.eventID
    }

    private func reasoningBinding(for eventID: String) -> Binding<Bool> {
        Binding(
            get: { expandedReasoningEventIDs.contains(eventID) },
            set: { isExpanded in
                if isExpanded {
                    expandedReasoningEventIDs.insert(eventID)
                } else {
                    expandedReasoningEventIDs.remove(eventID)
                }
            }
        )
    }

    private func revealLiveReasoning(using proxy: ScrollViewProxy) {
        guard let eventID = liveReasoningMessageID else { return }
        if reduceMotion {
            expandedReasoningEventIDs.insert(eventID)
            proxy.scrollTo(eventID, anchor: .center)
        } else {
            withAnimation(.easeInOut(duration: 0.2)) {
                expandedReasoningEventIDs.insert(eventID)
                proxy.scrollTo(eventID, anchor: .center)
            }
        }
    }

    @ViewBuilder
    private func composer(onThinkingTap: @escaping () -> Void) -> some View {
        VStack(spacing: 8) {
            if replying {
                CompanionThinkingStatus(
                    companionName: companionName,
                    icon: icon,
                    accent: visualTheme.accent,
                    isInteractive: liveReasoningMessageID != nil,
                    onTap: onThinkingTap
                )
                .transition(
                    reduceMotion
                        ? .identity
                        : .move(edge: .bottom).combined(with: .opacity)
                )
            }

            GlassEffectContainer(spacing: 12) {
                HStack(alignment: .bottom, spacing: 10) {
                    TextField("Écrire un message…", text: $draft, axis: .vertical)
                        .lineLimit(1...5)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 13)
                        .companionGlass(radius: 18, interactive: true)
                        .accessibilityIdentifier("demo.composer")

                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(visualTheme.accentForeground)
                            .frame(width: 46, height: 46)
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .tint(visualTheme.accent)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || replying)
                    .accessibilityLabel("Envoyer")
                    .accessibilityIdentifier("demo.send")
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: replying)
    }

    private func send() {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !replying else { return }
        draft = ""
        messages.append(.init(content: content, kind: .mine, timestamp: "maintenant"))
        replying = true

        guard !holdsReplyingForEvidence else { return }

        Task {
            try? await Task.sleep(for: .seconds(1.2))
            messages.append(
                .init(
                    content: "Oui. Je garde ce langage visuel : clair, précis et profondément iOS. Le verre reste interactif, tandis que le contenu garde un contraste impeccable.",
                    kind: .assistant,
                    author: companionName,
                    timestamp: "maintenant"
                )
            )
            replying = false
        }
    }
}

private struct GlassRosterDemoView: View {
    @Environment(\.dismiss) private var dismiss

    private let companions = [
        DemoRosterEntry(name: "Companion", preview: "Direction iOS 26 validée", status: "En ligne", icon: .init(shape: 1, mouth: 1, accessory: 6, color: 7), unread: false),
        DemoRosterEntry(name: "Inbox Triage", preview: "3 décisions à relire", status: "En veille", icon: .init(shape: 0, mouth: 2, accessory: 0, color: 7), unread: true),
        DemoRosterEntry(name: "Linear Bot", preview: "THE-379 est prête", status: "En ligne", icon: .init(shape: 2, mouth: 1, accessory: 3, color: 4), unread: true),
        DemoRosterEntry(name: "Optimizer", preview: "Audit terminé", status: "En veille", icon: .init(shape: 5, mouth: 4, accessory: 1, color: 3), unread: false),
    ]

    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(companions) { companion in
                            Button {
                                dismiss()
                            } label: {
                                HStack(spacing: 13) {
                                    CompanionAvatar(name: companion.name, icon: companion.icon, size: 48, state: .idle)
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack {
                                            Text(companion.name)
                                                .font(.headline)
                                            Spacer()
                                            Text(companion.status)
                                                .font(.caption2)
                                                .foregroundStyle(Color.companionMuted)
                                        }
                                        HStack {
                                            Text(companion.preview)
                                                .font(.subheadline)
                                                .foregroundStyle(Color.companionMuted)
                                                .lineLimit(1)
                                            Spacer()
                                            if companion.unread {
                                                Circle()
                                                    .fill(CompanionVisualTheme(icon: companion.icon).accent)
                                                    .frame(width: 8, height: 8)
                                            }
                                        }
                                    }
                                }
                                .padding(13)
                                .companionGlass(radius: 18, interactive: true)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier(companion.accessibilityID)
                            .accessibilityLabel("\(companion.name), \(companion.status), \(companion.preview)\(companion.unread ? ", non lu" : "")")
                        }
                    }
                    .padding(16)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("Conversations")
            .navigationBarTitleDisplayMode(.large)
            .tint(Color.companionInk)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fermer") { dismiss() }
                }
            }
        }
    }
}

private struct DemoRosterEntry: Identifiable {
    let id = UUID()
    let name: String
    let preview: String
    let status: String
    let icon: CompanionSummary.Icon
    let unread: Bool

    var accessibilityID: String {
        "demo.roster.\(name.lowercased().replacingOccurrences(of: " ", with: "-"))"
    }
}

private struct DemoMessage: Identifiable {
    let id = UUID()
    var content: String
    let kind: ChatMessageBubble.Kind
    var author: String?
    var timestamp: String?
    var tool: CompanionToolRun?
    var reasoning: String?

    var eventID: String {
        if let callID = tool?.callID { return "tool:\(callID)" }
        return id.uuidString
    }

    var isMarkdownFixture: Bool {
        content.hasPrefix("## Rapport")
    }

    var displayReasoning: String {
        reasoning?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    var accessibilityIdentifier: String {
        if let tool { return "demo.tool-run.\(tool.kind.rawValue)" }
        return isMarkdownFixture ? "demo.markdown.reply" : "demo.message.\(id)"
    }

    init(
        content: String,
        kind: ChatMessageBubble.Kind,
        author: String? = nil,
        timestamp: String? = nil,
        tool: CompanionToolRun? = nil,
        reasoning: String? = nil
    ) {
        self.content = content
        self.kind = kind
        self.author = author
        self.timestamp = timestamp
        self.tool = tool
        self.reasoning = reasoning
    }

    static let samples: [DemoMessage] = [
        .init(
            content: "Salut Stan. J’ai préparé une direction claire inspirée du rythme de Grok, mais pensée pour iOS 26 et son Liquid Glass natif.",
            kind: .assistant,
            author: "Companion",
            timestamp: "09:41",
            reasoning: """
            Checking the transcript contract before presenting the reply.
            Keeping reasoning separate from the answer preserves literal Markdown rendering.
            The enclosure stays collapsed until the reader asks to see it.
            """
        ),
        .init(
            content: "",
            kind: .assistant,
            author: "Companion",
            timestamp: "09:41",
            tool: .init(
                callID: "demo-shell-1",
                kind: .shell,
                name: "run_command",
                title: "Shell command",
                status: .ok,
                detail: """
                $ pnpm test --filter CompanionKit
                Tests passed: 48
                <output is displayed literally, not interpreted as HTML>
                """,
                screenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAFCAIAAAD38zoCAAAAZElEQVR4nAXBMQ0AIAwEQGwgAxNNkEFSE13r4B38ylQHnyCgnrgb07AM23AMYYDhGp5hTOdybudxhhPO63zOMbNW1s46WZGFrJv1ssakFrWpQwUF6lKPGlO91Ft91KGG+qqf+gMnV0CxPrkGNgAAAABJRU5ErkJggg=="
            )
        ),
        .init(
            content: "",
            kind: .assistant,
            author: "Companion",
            timestamp: "09:41",
            tool: .init(
                callID: "demo-file-1",
                kind: .file,
                name: "file",
                title: "File operation",
                status: .error,
                detail: nil,
                screenshot: nil
            )
        ),
        .init(
            content: "",
            kind: .assistant,
            author: "Companion",
            timestamp: "09:41",
            tool: .init(
                callID: "demo-subagent-1",
                kind: .subagent,
                name: "subagent",
                title: "reviewer: inspect the native transcript",
                status: .running,
                detail: """
                Reviewing the transcript model and native rendering.
                Confirmed the shared API remains unchanged.
                Checked the shell, file, browse, computer, and generic families.
                Checked running, done, failed, and timed-out status language.
                Verified that status is visible without relying on color.
                Verified that the disclosure starts collapsed.
                Verified that long progress wraps within the reading column.
                Verified that detail stays literal, selectable, and monospace.
                Verified that large text moves status below the summary.
                Verified that Reduce Motion replaces the spinner with a static symbol.
                Verified that Reduce Transparency uses an opaque system surface.
                Verified that system colors adapt to the active appearance.
                Checked that the touch target remains at least 44 points.
                Checked that unknown future tool kinds use the generic family.
                Finishing the native tool-operation review.
                """,
                screenshot: nil
            )
        ),
        .init(
            content: "Je veux quelque chose de très premium, lisible et vraiment natif Apple.",
            kind: .mine,
            timestamp: "09:42"
        ),
        .init(
            content: "C’est exactement la ligne retenue. Les contrôles flottent en Liquid Glass, les messages utilisent des matériaux translucides, et chaque état reste explicite. Aucun framework visuel tiers.",
            kind: .assistant,
            author: "Companion",
            timestamp: "09:42"
        ),
        .init(
            content: "Et le chat reste rapide quand la conversation devient longue ?",
            kind: .mine,
            timestamp: "09:43"
        ),
        .init(
            content: """
            ## Rapport d’incident

            Le rendu garde **la hiérarchie**, l’*emphase*, le ~~contenu obsolète~~ et le `code inline`.

            - La réponse reste lisible avec Dynamic Type.
            - Les messages des membres restent littéraux.

            > Les contenus distants restent non fiables et ne sont jamais chargés automatiquement.

            [Documentation sûre](https://example.com/runbook)

            ```swift
            let status = "ok"
            print(status)
            ```

            | Contrôle | Résultat |
            | :-- | --: |
            | Markdown | Rendu |
            | Images distantes | Bloquées |

            ---

            ![preuve distante](https://example.invalid/beacon?secret=thread)

            <img src=x onerror=alert(1)>

            [Lien refusé](javascript:alert(1))
            """,
            kind: .assistant,
            author: "Companion",
            timestamp: "09:43"
        ),
    ]
}

#Preview("Liquid Glass chat") {
    GlassChatDemoView()
}
#endif
