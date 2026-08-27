import CompanionKit
import Observation
import SwiftUI

@MainActor
@Observable
final class CompanionMacWorkspaceModel {
    let sessionStore: SessionStore
    private(set) var rosterState = CompanionRosterState()
    var selectedCompanionID: String?
    var query = ""
    var hiddenExpanded = false
    private(set) var loading = true
    private(set) var errorMessage: String?
    private(set) var actionMessage: String?
    private(set) var actionError: String?
    private(set) var pendingDeletionIDs: Set<String> = []

    init(sessionStore: SessionStore) {
        self.sessionStore = sessionStore
    }

    var companions: [CompanionSummary] {
        rosterState.companions
    }

    var projection: CompanionMacRosterProjection {
        CompanionMacRosterProjection(
            companions: companions,
            query: query,
            hiddenExpanded: hiddenExpanded
        )
    }

    var selectedCompanion: CompanionSummary? {
        guard let selectedCompanionID else { return nil }
        return companions.first { $0.id == selectedCompanionID }
    }

    func refresh(silently: Bool = false) async {
        if !silently { loading = true }
        do {
            let next = try await sessionStore.listCompanions()
            rosterState.reconcile(with: visibleCompanionsReconcilingDeletions(next))
            errorMessage = nil
            if let selectedCompanionID,
               companions.contains(where: { $0.id == selectedCompanionID }) {
                self.selectedCompanionID = selectedCompanionID
            } else if self.selectedCompanionID == nil {
                self.selectedCompanionID = projection.visibleCompanions.first?.id
            }
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "Companions are temporarily unavailable.")
        }
        loading = false
    }

    func startPolling() async {
        await refresh()
        while !Task.isCancelled {
            let hasActiveWork = !pendingDeletionIDs.isEmpty || companions.contains {
                $0.runtime.replying
                    || $0.runtime.state == .provisioning
                    || $0.runtime.state == .stopping
                    || $0.deletionOperation?.isActive == true
            }
            try? await Task.sleep(for: .seconds(hasActiveWork ? 8 : 45))
            guard !Task.isCancelled else { return }
            await refresh(silently: true)
        }
    }

    func select(_ companion: CompanionSummary?) {
        selectedCompanionID = companion?.id
        actionError = nil
    }

    func replaceProjection(_ companion: CompanionSummary) {
        _ = rosterState.replace(companion)
    }

    func markUnread(_ companion: CompanionSummary) {
        performMemberStateUpdate(
            companion,
            patch: CompanionMemberStatePatch(unread: true),
            success: "Marked \(companion.name) as unread."
        )
    }

    func togglePinned(_ companion: CompanionSummary) {
        performMemberStateUpdate(
            companion,
            patch: CompanionMemberStatePatch(pinned: !companion.pinned),
            success: companion.pinned ? "Unpinned \(companion.name)." : "Pinned \(companion.name)."
        )
    }

    func toggleHidden(_ companion: CompanionSummary) {
        performMemberStateUpdate(
            companion,
            patch: CompanionMemberStatePatch(hidden: !companion.hidden),
            success: companion.hidden ? "Shown \(companion.name)." : "Hidden \(companion.name)."
        )
    }

    func duplicate(_ companion: CompanionSummary) {
        guard companion.access.canDeleteCompanion, !isDeletionInProgress(companion) else { return }
        actionError = nil
        Task {
            do {
                let duplicate = try await sessionStore.duplicateCompanion(companionID: companion.id)
                rosterState.prepend(duplicate)
                selectedCompanionID = duplicate.id
                actionMessage = "Created a copy of \(companion.name)."
            } catch {
                actionError = companionMacErrorMessage(error, fallback: "The Companion could not be duplicated.")
            }
        }
    }

    func delete(_ companion: CompanionSummary) {
        guard companion.access.canDeleteCompanion, !isDeletionInProgress(companion) else { return }
        actionError = nil
        let wasSelected = selectedCompanionID == companion.id
        pendingDeletionIDs.insert(companion.id)
        _ = rosterState.removeOptimistically(companionID: companion.id)
        if selectedCompanionID == companion.id { selectedCompanionID = nil }
        Task {
            do {
                let operation = try await sessionStore.deleteCompanion(
                    companionID: companion.id,
                    requestID: UUID()
                )
                if !operation.isActive { pendingDeletionIDs.remove(companion.id) }
                let restored = rosterState.reconcileDeletionResponse(
                    companionID: companion.id,
                    operation: operation
                )
                if operation.isActive {
                    actionMessage = "Deletion requested for \(companion.name)."
                } else {
                    if wasSelected, restored != nil { selectedCompanionID = companion.id }
                    actionMessage = nil
                    actionError = operation.error?.message ?? "\(companion.name) could not be deleted and was restored."
                }
            } catch {
                pendingDeletionIDs.remove(companion.id)
                let restored = rosterState.restoreDeletion(companionID: companion.id)
                if wasSelected, restored != nil { selectedCompanionID = companion.id }
                actionError = companionMacErrorMessage(error, fallback: "The Companion could not be deleted.")
            }
        }
    }

    func applyCreated(_ companion: CompanionSummary) {
        rosterState.prepend(companion)
        selectedCompanionID = companion.id
        actionMessage = "Created \(companion.name)."
    }

    private func performMemberStateUpdate(
        _ companion: CompanionSummary,
        patch: CompanionMemberStatePatch,
        success: String
    ) {
        guard !loading, !isDeletionInProgress(companion) else { return }
        actionError = nil
        Task {
            do {
                let updated = try await sessionStore.updateCompanionMemberState(
                    companionID: companion.id,
                    patch: patch
                )
                _ = rosterState.replaceAndRepartition(updated)
                actionMessage = success
            } catch {
                actionError = companionMacErrorMessage(error, fallback: "That roster change could not be saved.")
            }
        }
    }

    private func isDeletionInProgress(_ companion: CompanionSummary) -> Bool {
        pendingDeletionIDs.contains(companion.id) || companion.deletionOperation?.isActive == true
    }

    private func visibleCompanionsReconcilingDeletions(
        _ next: [CompanionSummary]
    ) -> [CompanionSummary] {
        var retainedPendingIDs: Set<String> = []
        var visible: [CompanionSummary] = []

        for companion in next {
            if companion.deletionOperation?.isActive == true {
                retainedPendingIDs.insert(companion.id)
                continue
            }
            if pendingDeletionIDs.contains(companion.id), companion.deletionOperation == nil {
                // A list response can briefly lag the accepted delete operation. Keep that stale
                // projection hidden until the API reports a terminal operation or removes it.
                retainedPendingIDs.insert(companion.id)
                continue
            }
            visible.append(companion)
        }

        pendingDeletionIDs = retainedPendingIDs
        return visible
    }
}

struct CompanionMacWorkspaceView: View {
    @Environment(\.openWindow) private var openWindow
    @Environment(CompanionMacDesktopWindowState.self) private var desktopWindow
    let session: Session
    @State private var model: CompanionMacWorkspaceModel
    @State private var showingCreate = false
    @State private var showingMemberSettings = false
    @State private var showingProviders = false
    @State private var showingPlugins = false
    @State private var settingsCompanion: CompanionSummary?
    @State private var companionToDelete: CompanionSummary?

    init(session: Session, sessionStore: SessionStore) {
        self.session = session
        _model = State(initialValue: CompanionMacWorkspaceModel(sessionStore: sessionStore))
    }

    var body: some View {
        NavigationSplitView {
            sidebar
        } detail: {
            detail
        }
        .navigationSplitViewColumnWidth(
            min: CompanionMacMetrics.sidebarWidth - 24,
            ideal: CompanionMacMetrics.sidebarWidth,
            max: CompanionMacMetrics.sidebarWidth + 100
        )
        .background(Color.companionMacCanvas)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New Companion", systemImage: "plus") {
                    showingCreate = true
                }
                .accessibilityIdentifier("roster.new")
            }
            ToolbarItem {
                Menu {
                    Button("Member settings", systemImage: "person") {
                        showingMemberSettings = true
                    }
                    Button("Providers", systemImage: "key.horizontal") {
                        showingProviders = true
                    }
                    Button("Plugins", systemImage: "puzzlepiece.extension") {
                        showingPlugins = true
                    }
                    Divider()
                    Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                        Task { await model.sessionStore.signOut() }
                    }
                } label: {
                    Label(session.user.name ?? session.user.email, systemImage: "person.circle")
                }
                .accessibilityIdentifier("workspace.settings")
            }
        }
        .task {
            await model.startPolling()
        }
        .onReceive(NotificationCenter.default.publisher(for: .companionMacNewCompanion)) { _ in
            showingCreate = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .companionMacDeleteSelected)) { _ in
            if let companion = model.selectedCompanion, companion.access.canDeleteCompanion {
                companionToDelete = companion
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .companionMacOpenDesktop)) { _ in
            if let companion = model.selectedCompanion {
                requestDesktop(for: companion)
            }
        }
        .sheet(isPresented: $showingCreate) {
            CompanionMacCreateCompanionView { companion in
                model.applyCreated(companion)
                showingCreate = false
            }
            .environment(model.sessionStore)
        }
        .sheet(item: $settingsCompanion) { companion in
            CompanionMacCompanionSettingsView(companion: companion) { updated in
                model.replaceProjection(updated)
                settingsCompanion = nil
            }
            .environment(model.sessionStore)
        }
        .sheet(isPresented: $showingMemberSettings) {
            CompanionMacMemberSettingsView(session: session)
                .environment(model.sessionStore)
        }
        .sheet(isPresented: $showingProviders) {
            CompanionMacProviderManagementView()
                .environment(model.sessionStore)
        }
        .sheet(isPresented: $showingPlugins) {
            CompanionMacPluginManagementView()
                .environment(model.sessionStore)
        }
        .confirmationDialog(
            "Delete \(companionToDelete?.name ?? "Companion")?",
            isPresented: Binding(
                get: { companionToDelete != nil },
                set: { if !$0 { companionToDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: companionToDelete
        ) { companion in
            Button("Delete Companion", role: .destructive) {
                model.delete(companion)
                companionToDelete = nil
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Its Box, thread, and Companion record will be permanently deleted. This cannot be undone.")
        }
        .tint(Color.companionMacAccent)
    }

    private var sidebar: some View {
        CompanionMacRosterSidebar(
            model: model,
            onSettings: { settingsCompanion = $0 },
            onDelete: { companionToDelete = $0 },
            onNew: { showingCreate = true }
        )
        .safeAreaInset(edge: .bottom) {
            if let actionError = model.actionError {
                CompanionMacErrorNotice(message: actionError)
                    .padding(CompanionMacMetrics.space * 2)
            } else if let actionMessage = model.actionMessage {
                Label(actionMessage, systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(Color.companionMacSuccess)
                    .padding(CompanionMacMetrics.space * 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let companion = model.selectedCompanion {
            CompanionMacChatView(
                companion: companion,
                sessionStore: model.sessionStore,
                onCompanionChanged: { model.replaceProjection($0) },
                onSettings: { settingsCompanion = $0 },
                onOpenDesktop: { requestDesktop(for: $0) }
            )
            .id(companion.id)
            .environment(model.sessionStore)
        } else {
            CompanionMacWelcomeView {
                showingCreate = true
            }
        }
    }

    private func requestDesktop(for companion: CompanionSummary) {
        guard CompanionMacDesktopEligibility.evaluate(
                  access: companion.access,
                  runtimeState: companion.runtime.state
              ).canOpen else { return }
        desktopWindow.begin(
            companionID: companion.id,
            companionName: companion.name,
            access: companion.access
        )
        // The dedicated window owns the one-and-only mint request in its lifetime task. Keeping
        // the request there prevents a Window scene startup task and the toolbar path from racing
        // and rotating two signed stream URLs.
        openWindow(id: "companion-desktop")
    }
}

struct CompanionMacWelcomeView: View {
    let create: () -> Void

    var body: some View {
        VStack(spacing: CompanionMacMetrics.space * 4) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(Color.companionMacAccent)
            Text("Choose a Companion")
                .font(.title2.weight(.semibold))
            Text("Select a conversation from the roster, or create a Companion for this workspace.")
                .font(.callout)
                .foregroundStyle(Color.companionMacMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 430)
            Button("New Companion", systemImage: "plus", action: create)
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.companionMacCanvas)
    }
}

private struct CompanionMacRosterSidebar: View {
    @Bindable var model: CompanionMacWorkspaceModel
    let onSettings: (CompanionSummary) -> Void
    let onDelete: (CompanionSummary) -> Void
    let onNew: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: CompanionMacMetrics.space) {
                    Text("Companions")
                        .font(.title3.weight(.semibold))
                    Text("\(model.companions.count) durable conversations")
                        .font(.caption)
                        .foregroundStyle(Color.companionMacMuted)
                }
                Spacer()
                Button("New Companion", systemImage: "plus", action: onNew)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.bordered)
                    .help("New Companion")
                    .accessibilityIdentifier("roster.new.sidebar")
            }
            .padding(.horizontal, CompanionMacMetrics.space * 3)
            .padding(.vertical, CompanionMacMetrics.space * 3)

            List(selection: $model.selectedCompanionID) {
                if model.loading && model.companions.isEmpty {
                    ProgressView("Loading…")
                        .frame(maxWidth: .infinity, alignment: .center)
                        .listRowSeparator(.hidden)
                } else if let error = model.errorMessage, model.companions.isEmpty {
                    CompanionMacErrorNotice(message: error)
                        .listRowSeparator(.hidden)
                    Button("Try again") {
                        Task { await model.refresh() }
                    }
                    .listRowSeparator(.hidden)
                } else if model.projection.totalMatchCount == 0 {
                    Text(model.query.isEmpty ? "No Companions yet" : "No matches")
                        .font(.callout)
                        .foregroundStyle(Color.companionMacMuted)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, CompanionMacMetrics.space * 5)
                        .listRowSeparator(.hidden)
                } else {
                    rosterSection("Pinned", companions: model.projection.visibleSections.pinned)
                    rosterSection("Companions", companions: model.projection.visibleSections.unpinned)
                    if !model.projection.sections.hidden.isEmpty {
                        Section {
                            if model.hiddenExpanded || !model.query.isEmpty {
                                ForEach(model.projection.sections.hidden) { companion in
                                    row(companion)
                                }
                            }
                        } header: {
                            Button {
                                guard model.query.isEmpty else { return }
                                model.hiddenExpanded.toggle()
                            } label: {
                                HStack {
                                    Text("Hidden")
                                    Text("\(model.projection.sections.hidden.count)")
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(Color.companionMacMuted)
                                    Spacer()
                                    Image(systemName: model.hiddenExpanded || !model.query.isEmpty ? "chevron.down" : "chevron.right")
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(!model.query.isEmpty)
                            .accessibilityLabel("Hidden Companions, \(model.projection.sections.hidden.count)")
                            .accessibilityValue(model.hiddenExpanded || !model.query.isEmpty ? "Expanded" : "Collapsed")
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .searchable(text: $model.query, placement: .sidebar, prompt: "Search Companions")
            .accessibilityIdentifier("roster.list")
        }
    }

    @ViewBuilder
    private func rosterSection(_ title: String, companions: [CompanionSummary]) -> some View {
        if !companions.isEmpty {
            Section {
                ForEach(companions) { companion in
                    row(companion)
                }
            } header: {
                Text(title)
            }
        }
    }

    private func row(_ companion: CompanionSummary) -> some View {
        CompanionMacRosterRow(companion: companion)
            .tag(companion.id)
            .contextMenu {
                Button("Settings", systemImage: "gearshape") { onSettings(companion) }
                Button(companion.pinned ? "Unpin" : "Pin", systemImage: companion.pinned ? "pin.slash" : "pin") {
                    model.togglePinned(companion)
                }
                Button(companion.hidden ? "Show" : "Hide", systemImage: companion.hidden ? "eye" : "eye.slash") {
                    model.toggleHidden(companion)
                }
                Button("Mark as unread", systemImage: "envelope.badge") {
                    model.markUnread(companion)
                }
                if companion.access.canDeleteCompanion {
                    Button("Duplicate", systemImage: "plus.square.on.square") {
                        model.duplicate(companion)
                    }
                    Divider()
                    Button("Delete", systemImage: "trash", role: .destructive) { onDelete(companion) }
                }
            }
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                Button(companion.pinned ? "Unpin" : "Pin", systemImage: companion.pinned ? "pin.slash" : "pin") {
                    model.togglePinned(companion)
                }
                .tint(Color.companionMacAccent)
            }
    }
}

private struct CompanionMacRosterRow: View {
    let companion: CompanionSummary

    var body: some View {
        HStack(spacing: CompanionMacMetrics.space * 2) {
            ZStack(alignment: .bottomTrailing) {
                CompanionMacAvatar(
                    name: companion.name,
                    icon: companion.icon,
                    size: 38,
                    thinking: companion.runtime.replying
                )
                Circle()
                    .fill(statusColor)
                    .frame(width: 9, height: 9)
                    .overlay(Circle().stroke(Color.companionMacSurface, lineWidth: 2))
            }

            VStack(alignment: .leading, spacing: CompanionMacMetrics.space) {
                HStack(spacing: CompanionMacMetrics.space) {
                    Text(companion.name)
                        .font(.callout.weight(companion.unread ? .semibold : .medium))
                        .lineLimit(1)
                    if companion.unread {
                        Circle()
                            .fill(Color.companionMacAccent)
                            .frame(width: 7, height: 7)
                            .accessibilityLabel("Unread")
                    }
                    Spacer(minLength: CompanionMacMetrics.space)
                    Text(relativeTime)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(Color.companionMacMuted)
                }
                HStack(spacing: CompanionMacMetrics.space) {
                    Text(preview)
                        .font(.caption)
                        .foregroundStyle(companion.unread ? Color.companionMacInk : Color.companionMacMuted)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                Text(statusLabel)
                    .font(.caption2)
                    .foregroundStyle(Color.companionMacMuted)
            }
        }
        .padding(.vertical, CompanionMacMetrics.space)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(companion.name), \(statusLabel), \(preview)\(companion.unread ? ", unread" : "")")
        .accessibilityIdentifier("roster.row.\(companion.id)")
    }

    private var preview: String {
        companion.lastMessage?.preview ?? companion.persona ?? "No messages yet"
    }

    private var statusLabel: String {
        if companion.runtime.replying { return "Replying" }
        switch companion.runtime.state {
        case .running: return "Online"
        case .provisioning: return "Starting"
        case .stopping: return "Stopping"
        case .error: return "Needs attention"
        case .notCreated, .stopped: return "Asleep"
        case .unknown: return "Unknown status"
        }
    }

    private var statusColor: Color {
        if companion.runtime.replying { return .companionMacAccent }
        switch companion.runtime.state {
        case .running: return .companionMacSuccess
        case .provisioning, .stopping: return .companionMacWarning
        case .error: return .companionMacDanger
        case .notCreated, .stopped, .unknown: return .companionMacUnknown
        }
    }

    private var relativeTime: String {
        guard let createdAt = companion.lastMessage?.createdAt,
              let date = ISO8601DateFormatter().date(from: createdAt) else { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: .now)
    }
}
