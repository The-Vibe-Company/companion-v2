import SwiftUI
import CompanionKit

@MainActor
struct CompanionListServices {
    let listCompanions: () async throws -> [CompanionSummary]
    let deleteCompanion: (String, UUID) async throws -> CompanionOperationSummary
    let updateMemberState: (String, CompanionMemberStatePatch) async throws -> CompanionSummary
    let duplicateCompanion: (String) async throws -> CompanionSummary
}

struct CompanionListView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(NotificationCoordinator.self) private var notifications
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let session: Session
    private let services: CompanionListServices?
    @State private var path: [CompanionRoute] = []
    @State private var rosterState = CompanionRosterState()
    @State private var query = ""
    @State private var loading = true
    @State private var error: String?
    @State private var reloadGeneration = 0
    @State private var showingCreateCompanion = false
    @State private var showingProviders = false
    @State private var showingPlugins = false
    @State private var showingMemberSettings = false
    @State private var companionToDelete: CompanionSummary?
    @State private var deleteRequestIDs: [String: UUID] = [:]
    @State private var deletingCompanionIDs: Set<String> = []
    @State private var rosterActionCompanionIDs: Set<String> = []
    @State private var showingHidden = false
    @State private var rosterNotice: String?
    @State private var rosterActionError: String?
    @State private var chatReadingPositions = CompanionChatReadingPositionStore()

    init(session: Session, services: CompanionListServices? = nil) {
        self.session = session
        self.services = services
    }

    var body: some View {
        NavigationStack(path: $path) {
            CompanionBackdrop {
                Group {
                    if loading && companions.isEmpty {
                        loadingState
                    } else if let error, companions.isEmpty {
                        errorState(error)
                    } else if matchingCompanions.isEmpty {
                        emptyState
                    } else {
                        roster
                    }
                }
            }
            .navigationTitle("Companions")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(for: CompanionRoute.self) { route in
                destination(for: route)
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search Companions")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New Companion", systemImage: "plus") {
                        showingCreateCompanion = true
                    }
                    .accessibilityHint("Opens Companion creation")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Text(session.user.email)
                        Divider()
                        Button("Member settings", systemImage: "person.crop.circle") {
                            showingMemberSettings = true
                        }
                        Button("Model providers", systemImage: "cpu") {
                            showingProviders = true
                        }
                        Button("Plugins", systemImage: "puzzlepiece.extension") {
                            showingPlugins = true
                        }
                        Divider()
                        Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right") {
                            Task { await sessionStore.signOut() }
                        }
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                    .accessibilityLabel("Account for \(session.user.email)")
                    .accessibilityIdentifier("account.menu")
                }
            }
            .sheet(isPresented: $showingCreateCompanion) {
                CreateCompanionView { companion in
                    rosterState.prepend(companion)
                    Task { await reload(silently: true) }
                }
                .tint(Color.companionAccent)
            }
            .sheet(isPresented: $showingProviders) {
                ProviderManagementView()
                    .tint(Color.companionAccent)
            }
            .sheet(isPresented: $showingPlugins) {
                PluginManagementView()
                    .tint(Color.companionAccent)
            }
            .sheet(isPresented: $showingMemberSettings) {
                MemberSettingsView(session: session)
                    .tint(Color.companionAccent)
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
                    Task { await delete(companion) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("Its Box, thread, and Companion record will be permanently deleted. This cannot be undone.")
            }
            .task(id: session.orgID) {
                await reload()
                while !Task.isCancelled {
                    let interval: UInt64 = companions.contains(where: hasActiveWork) ? 8 : 45
                    try? await Task.sleep(for: .seconds(interval))
                    if !Task.isCancelled { await reload(silently: true) }
                }
            }
            .onChange(of: notifications.pendingDestination) { _, _ in
                openPendingNotificationIfPossible()
            }
            .tint(Color.companionInk)
        }
    }

    private var companions: [CompanionSummary] {
        rosterState.companions
    }

    private var roster: some View {
        List {
            if let rosterActionError {
                CompanionErrorNotice(message: rosterActionError)
                    .rosterListRow()
            } else if let rosterNotice {
                CompanionSuccessNotice(message: rosterNotice)
                    .rosterListRow()
            }

            HStack {
                Text("Your durable conversations")
                    .font(.subheadline)
                    .foregroundStyle(Color.companionMuted)
                Spacer()
                Text("\(visibleCompanions.count)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(Color.companionMuted)
            }
            .rosterListRow(verticalInset: 4)

            if !filteredSections.pinned.isEmpty {
                Section {
                    ForEach(filteredSections.pinned) { companionRow($0) }
                } header: {
                    rosterSectionHeader("Pinned", count: filteredSections.pinned.count)
                }
            }

            if !filteredSections.unpinned.isEmpty {
                Section {
                    ForEach(filteredSections.unpinned) { companionRow($0) }
                } header: {
                    rosterSectionHeader("Companions", count: filteredSections.unpinned.count)
                }
            }

            if !filteredSections.hidden.isEmpty {
                Section {
                    if showingHidden || !query.isEmpty {
                        ForEach(filteredSections.hidden) { companionRow($0) }
                    }
                } header: {
                    Button {
                        withRosterAnimation { showingHidden.toggle() }
                    } label: {
                        HStack(spacing: 6) {
                            Text("Hidden")
                            Text("\(filteredSections.hidden.count)")
                                .monospacedDigit()
                            Spacer()
                            Image(systemName: (showingHidden || !query.isEmpty) ? "chevron.down" : "chevron.right")
                                .font(.caption.weight(.semibold))
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!query.isEmpty)
                    .accessibilityLabel("Hidden Companions, \(filteredSections.hidden.count)")
                    .accessibilityValue((showingHidden || !query.isEmpty) ? "Expanded" : "Collapsed")
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await reload() }
        .scrollIndicators(.hidden)
    }

    private var loadingState: some View {
        VStack(spacing: 14) {
            ProgressView()
                .controlSize(.large)
            Text("Loading Companions…")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.companionMuted)
        }
        .padding(28)
        .companionGlass(radius: 24)
    }

    private func errorState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Could not load Companions", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try again") { Task { await reload() } }
                .buttonStyle(.glassProminent)
        }
        .padding(24)
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                query.isEmpty ? "No Companions yet" : "No matches",
                systemImage: "bubble.left.and.bubble.right"
            )
        } description: {
            Text(query.isEmpty ? "Create a Companion in your workspace to begin a durable conversation." : "Try a different name or message.")
        } actions: {
            if query.isEmpty {
                Button("Create a Companion", systemImage: "plus") {
                    showingCreateCompanion = true
                }
                .buttonStyle(.glassProminent)
            }
        }
        .padding(24)
    }

    private var filteredSections: CompanionRosterSections {
        let sections = rosterState.sections
        return CompanionRosterSections(
            pinned: sections.pinned.filter(matchesSearch),
            unpinned: sections.unpinned.filter(matchesSearch),
            hidden: sections.hidden.filter(matchesSearch)
        )
    }

    private var visibleCompanions: [CompanionSummary] {
        filteredSections.pinned + filteredSections.unpinned
    }

    private var matchingCompanions: [CompanionSummary] {
        visibleCompanions + filteredSections.hidden
    }

    private func matchesSearch(_ companion: CompanionSummary) -> Bool {
        guard !query.isEmpty else { return true }
        return companion.name.localizedStandardContains(query)
            || (companion.lastMessage?.preview.localizedStandardContains(query) ?? false)
            || (companion.persona?.localizedStandardContains(query) ?? false)
    }

    private func rosterSectionHeader(_ title: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(title)
            Text("\(count)")
                .monospacedDigit()
        }
        .textCase(nil)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func companionRow(_ companion: CompanionSummary) -> some View {
        let busy = rosterActionCompanionIDs.contains(companion.id)
            || deletingCompanionIDs.contains(companion.id)
        NavigationLink(value: CompanionRoute.chat(companion.id)) {
            CompanionRow(
                companion: companion,
                deletionOperation: effectiveDeletion(for: companion)
            )
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityIdentifier("companion.row.\(companion.id)")
        .contextMenu { companionContextMenu(for: companion, busy: busy) }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button("Settings", systemImage: "gearshape") {
                path.append(.settings(companion.id))
            }
            .tint(Color.companionInk)
        }
        .swipeActions(edge: .trailing) {
            if canRequestDeletion(of: companion), !busy {
                Button("Delete", systemImage: "trash", role: .destructive) {
                    companionToDelete = companion
                }
            }
        }
        .accessibilityActions {
            Button("Settings") { path.append(.settings(companion.id)) }
            if companion.hidden {
                Button("Unhide") {
                    Task { await updateMemberState(companion, patch: .init(hidden: false)) }
                }
            } else {
                Button(companion.pinned ? "Unpin" : "Pin") {
                    Task { await updateMemberState(companion, patch: .init(pinned: !companion.pinned)) }
                }
                if !companion.unread {
                    Button("Mark as unread") {
                        Task { await updateMemberState(companion, patch: .init(unread: true)) }
                    }
                }
                if companion.access.canDeleteCompanion {
                    Button("Duplicate") { Task { await duplicate(companion) } }
                }
                Button("Hide") {
                    Task { await updateMemberState(companion, patch: .init(hidden: true)) }
                }
            }
            if canRequestDeletion(of: companion), !busy {
                Button("Delete") { companionToDelete = companion }
            }
        }
        .rosterListRow()
    }

    @ViewBuilder
    private func companionContextMenu(for companion: CompanionSummary, busy: Bool) -> some View {
        Button("Settings", systemImage: "gearshape") {
            path.append(.settings(companion.id))
        }

        if companion.hidden {
            Button("Unhide", systemImage: "eye") {
                Task { await updateMemberState(companion, patch: .init(hidden: false)) }
            }
            .disabled(busy)
        } else {
            Button(companion.pinned ? "Unpin" : "Pin", systemImage: companion.pinned ? "pin.slash" : "pin") {
                Task { await updateMemberState(companion, patch: .init(pinned: !companion.pinned)) }
            }
            .disabled(busy)

            if !companion.unread {
                Button("Mark as unread", systemImage: "envelope.badge") {
                    Task { await updateMemberState(companion, patch: .init(unread: true)) }
                }
                .disabled(busy)
            }

            if companion.access.canDeleteCompanion {
                Button("Duplicate", systemImage: "plus.square.on.square") {
                    Task { await duplicate(companion) }
                }
                .disabled(busy)
            }

            Button("Hide", systemImage: "eye.slash") {
                Task { await updateMemberState(companion, patch: .init(hidden: true)) }
            }
            .disabled(busy)
        }

        if companion.access.canDeleteCompanion {
            Divider()
            if deletingCompanionIDs.contains(companion.id) {
                Button("Deleting…", systemImage: "clock") {}
                    .disabled(true)
            } else if effectiveDeletion(for: companion)?.isActive == true {
                Button("Deletion requested", systemImage: "clock") {}
                    .disabled(true)
            } else {
                Button(deleteMenuLabel(for: companion), systemImage: "trash", role: .destructive) {
                    companionToDelete = companion
                }
                .disabled(busy)
            }
        }
    }

    private func reload(silently: Bool = false) async {
        reloadGeneration += 1
        let generation = reloadGeneration
        if !silently { loading = true }
        do {
            let next: [CompanionSummary]
            if let services {
                next = try await services.listCompanions()
            } else {
                next = try await sessionStore.listCompanions()
            }
            guard generation == reloadGeneration else { return }
            rosterState.reconcile(with: next)
            let nextIDs = Set(next.map(\.id))
            let reconciledDeletionIDs = Set(next.compactMap { companion in
                companion.deletionOperation == nil ? nil : companion.id
            })
            deleteRequestIDs = deleteRequestIDs.filter { companionID, _ in
                nextIDs.contains(companionID) && !reconciledDeletionIDs.contains(companionID)
            }
            if let missingRoute = path.last?.companionID, !nextIDs.contains(missingRoute) {
                path.removeAll()
            }
            error = nil
            loading = false
            openPendingNotificationIfPossible()
        } catch let apiError as APIError where apiError.status == 403 || apiError.status == 404 {
            guard generation == reloadGeneration else { return }
            error = "Hosted Companions are not enabled for this workspace."
        } catch {
            guard generation == reloadGeneration else { return }
            self.error = "The workspace roster is temporarily unavailable."
        }
        if generation == reloadGeneration { loading = false }
    }

    private func openPendingNotificationIfPossible() {
        guard !loading, let destination = notifications.pendingDestination else { return }
        guard destination.orgID == session.orgID else {
            notifications.discardPendingDestination()
            return
        }
        guard companions.contains(where: { $0.id == destination.companionID }) else {
            notifications.discardPendingDestination()
            return
        }
        path = [.chat(destination.companionID)]
        notifications.consume(destination)
    }

    @ViewBuilder
    private func destination(for route: CompanionRoute) -> some View {
        if let companion = companions.first(where: { $0.id == route.companionID }) {
            switch route {
            case .chat(let companionID):
                ChatView(
                    companion: companion,
                    readingPosition: chatReadingPositions.position(for: companionID),
                    onPlugins: { showingPlugins = true },
                    onReadingPositionChange: { position in
                        chatReadingPositions.record(position, for: companionID)
                    },
                    onSettings: { path.append(.settings(companionID)) }
                )
                .onAppear { notifications.activeCompanionID = companionID }
                .onDisappear {
                    if notifications.activeCompanionID == companionID {
                        notifications.activeCompanionID = nil
                    }
                }
            case .settings:
                CompanionSettingsView(
                    companion: companion,
                    onSaved: replace,
                    onDeletionStarted: beginOptimisticDeletion,
                    onDeletionAccepted: deletionAccepted,
                    onDeletionFailed: deletionFailed
                )
            }
        } else {
            ContentUnavailableView(
                "Companion unavailable",
                systemImage: "bubble.left.and.exclamationmark.bubble.right",
                description: Text("This Companion is no longer available in the workspace.")
            )
        }
    }

    private func replace(_ updated: CompanionSummary) {
        rosterState.replace(updated)
    }

    private func updateMemberState(
        _ companion: CompanionSummary,
        patch: CompanionMemberStatePatch
    ) async {
        guard !rosterActionCompanionIDs.contains(companion.id) else { return }
        rosterActionCompanionIDs.insert(companion.id)
        defer { rosterActionCompanionIDs.remove(companion.id) }
        rosterActionError = nil
        rosterNotice = nil
        do {
            let updated: CompanionSummary
            if let services {
                updated = try await services.updateMemberState(companion.id, patch)
            } else {
                updated = try await sessionStore.updateCompanionMemberState(
                    companionID: companion.id,
                    patch: patch
                )
            }
            withRosterAnimation {
                rosterState.replaceAndRepartition(updated)
            }
            rosterNotice = memberStateNotice(for: updated, patch: patch)
            AccessibilityNotification.Announcement(rosterNotice ?? "Companion updated.").post()
            await reload(silently: true)
        } catch {
            rosterActionError = companionDisplayMessage(
                error,
                fallback: "This Companion could not be updated."
            )
        }
    }

    private func duplicate(_ companion: CompanionSummary) async {
        guard companion.access.canDeleteCompanion,
              !rosterActionCompanionIDs.contains(companion.id) else { return }
        rosterActionCompanionIDs.insert(companion.id)
        defer { rosterActionCompanionIDs.remove(companion.id) }
        rosterActionError = nil
        rosterNotice = nil
        do {
            let duplicate: CompanionSummary
            if let services {
                duplicate = try await services.duplicateCompanion(companion.id)
            } else {
                duplicate = try await sessionStore.duplicateCompanion(companionID: companion.id)
            }
            withRosterAnimation { rosterState.prepend(duplicate) }
            rosterNotice = "\(duplicate.name) created."
            AccessibilityNotification.Announcement("\(duplicate.name) created.").post()
            await reload(silently: true)
        } catch {
            rosterActionError = companionDisplayMessage(
                error,
                fallback: "This Companion could not be duplicated."
            )
        }
    }

    private func memberStateNotice(
        for companion: CompanionSummary,
        patch: CompanionMemberStatePatch
    ) -> String {
        if let hidden = patch.hidden {
            return hidden ? "\(companion.name) hidden." : "\(companion.name) unhidden."
        }
        if let pinned = patch.pinned {
            return pinned ? "\(companion.name) pinned." : "\(companion.name) unpinned."
        }
        if patch.unread == true { return "\(companion.name) marked as unread." }
        return "\(companion.name) updated."
    }

    private func withRosterAnimation(_ updates: () -> Void) {
        if reduceMotion {
            updates()
        } else {
            withAnimation(.easeOut(duration: 0.18)) { updates() }
        }
    }

    private func effectiveDeletion(for companion: CompanionSummary) -> CompanionOperationSummary? {
        companion.deletionOperation
    }

    private func canRequestDeletion(of companion: CompanionSummary) -> Bool {
        companion.access.canDeleteCompanion
            && !deletingCompanionIDs.contains(companion.id)
            && effectiveDeletion(for: companion)?.isActive != true
    }

    private func hasActiveWork(_ companion: CompanionSummary) -> Bool {
        companion.runtime.replying
            || companion.runtime.state == .provisioning
            || companion.runtime.state == .stopping
            || companion.runtime.latestOperation?.isActive == true
            || deletingCompanionIDs.contains(companion.id)
            || deleteRequestIDs[companion.id] != nil
            || effectiveDeletion(for: companion)?.isActive == true
    }

    private func deleteMenuLabel(for companion: CompanionSummary) -> String {
        if deleteRequestIDs[companion.id] != nil { return "Retry Delete" }
        guard let operation = effectiveDeletion(for: companion) else { return "Delete Companion" }
        if operation.status == .failed || operation.status == .interrupted || operation.status == .cancelled {
            return "Retry Delete"
        }
        return "Delete Companion"
    }

    private func delete(_ companion: CompanionSummary) async {
        guard companion.access.canDeleteCompanion,
              !deletingCompanionIDs.contains(companion.id) else { return }
        deletingCompanionIDs.insert(companion.id)
        defer { deletingCompanionIDs.remove(companion.id) }
        rosterActionError = nil
        rosterNotice = nil
        let requestID = deleteRequestIDs[companion.id] ?? UUID()
        deleteRequestIDs[companion.id] = requestID
        beginOptimisticDeletion(companion, requestID)
        do {
            let operation: CompanionOperationSummary
            if let services {
                operation = try await services.deleteCompanion(companion.id, requestID)
            } else {
                operation = try await sessionStore.deleteCompanion(
                    companionID: companion.id,
                    requestID: requestID
                )
            }
            deleteRequestIDs[companion.id] = nil
            deletionAccepted(companion.id, operation)
        } catch {
            deletionFailed(companion, requestID, error)
        }
        companionToDelete = nil
    }

    private func beginOptimisticDeletion(_ companion: CompanionSummary, _ requestID: UUID) {
        deleteRequestIDs[companion.id] = requestID
        deletingCompanionIDs.insert(companion.id)
        companionToDelete = nil
        rosterActionError = nil
        rosterNotice = nil
        path.removeAll()
        if notifications.activeCompanionID == companion.id {
            notifications.activeCompanionID = nil
        }
        if notifications.pendingDestination?.companionID == companion.id {
            notifications.discardPendingDestination()
        }
        if reduceMotion {
            rosterState.removeOptimistically(companionID: companion.id)
        } else {
            withAnimation(.easeOut(duration: 0.18)) {
                rosterState.removeOptimistically(companionID: companion.id)
            }
        }
        AccessibilityNotification.Announcement("\(companion.name) removed.").post()
    }

    private func deletionAccepted(_ companionID: String, _ operation: CompanionOperationSummary) {
        deletingCompanionIDs.remove(companionID)
        deleteRequestIDs[companionID] = nil
        let restored = reconcileDeletionResponse(companionID: companionID, operation: operation)
        guard operation.isActive else {
            let name = restored?.name
                ?? companions.first(where: { $0.id == companionID })?.name
                ?? "Companion"
            let message = operation.error?.message ?? "\(name) could not be deleted."
            rosterActionError = restored == nil ? message : "\(message) \(name) was restored."
            rosterNotice = nil
            announceRestoration(restored)
            return
        }
        rosterActionError = nil
        rosterNotice = "Deletion requested."
    }

    private func deletionFailed(_ companion: CompanionSummary, _ requestID: UUID, _ cause: Error) {
        deletingCompanionIDs.remove(companion.id)
        let restored = restoreOptimisticDeletion(companionID: companion.id)
        guard restored != nil || rosterState.contains(companionID: companion.id) else {
            deleteRequestIDs[companion.id] = nil
            rosterActionError = nil
            rosterNotice = "Deletion completed."
            return
        }
        deleteRequestIDs[companion.id] = requestID
        if let apiError = cause as? APIError, apiError.status == 0 {
            rosterActionError = restored == nil
                ? "Deletion could not be confirmed. Retrying reuses the same request."
                : "Deletion could not be confirmed. \(companion.name) was restored. Retrying reuses the same request."
        } else {
            let message = companionDisplayMessage(
                cause,
                fallback: "This Companion could not be deleted."
            )
            rosterActionError = restored == nil ? message : "\(message) \(companion.name) was restored."
        }
        rosterNotice = nil
        announceRestoration(restored)
    }

    private func restoreOptimisticDeletion(companionID: String) -> CompanionSummary? {
        if reduceMotion {
            return rosterState.restoreDeletion(companionID: companionID)
        }
        var restored: CompanionSummary?
        withAnimation(.easeOut(duration: 0.18)) {
            restored = rosterState.restoreDeletion(companionID: companionID)
        }
        return restored
    }

    private func reconcileDeletionResponse(
        companionID: String,
        operation: CompanionOperationSummary
    ) -> CompanionSummary? {
        if reduceMotion {
            return rosterState.reconcileDeletionResponse(companionID: companionID, operation: operation)
        }
        var restored: CompanionSummary?
        withAnimation(.easeOut(duration: 0.18)) {
            restored = rosterState.reconcileDeletionResponse(companionID: companionID, operation: operation)
        }
        return restored
    }

    private func announceRestoration(_ companion: CompanionSummary?) {
        guard let companion else { return }
        AccessibilityNotification.Announcement("\(companion.name) could not be deleted and was restored.").post()
    }
}

#if DEBUG
struct CompanionRosterDemoView: View {
    @State private var demoState = CompanionRosterDemoState()

    private let access: CompanionAccess

    init() {
        let rawAccess = ProcessInfo.processInfo.environment["COMPANION_ROSTER_DEMO_ACCESS"] ?? "owner"
        access = CompanionAccess(rawValue: rawAccess) ?? .viewer
    }

    var body: some View {
        CompanionListView(
            session: CompanionRosterDemoFixtures.session,
            services: CompanionListServices(
                listCompanions: {
                    [CompanionRosterDemoFixtures.companion(access: access)]
                },
                deleteCompanion: { companionID, requestID in
                    try demoState.delete(companionID: companionID, requestID: requestID)
                },
                updateMemberState: { _, patch in
                    CompanionRosterDemoFixtures.companion(
                        access: access,
                        pinned: patch.pinned ?? false,
                        hidden: patch.hidden ?? false,
                        unread: patch.unread ?? false
                    )
                },
                duplicateCompanion: { _ in
                    CompanionRosterDemoFixtures.companion(
                        id: "e87357f6-b1b7-4afe-bb6c-fd196ec46065",
                        name: "Luna copy",
                        access: access
                    )
                }
            )
        )
    }
}

@MainActor
private final class CompanionRosterDemoState {
    private var firstRequestID: UUID?

    func delete(companionID: String, requestID: UUID) throws -> CompanionOperationSummary {
        guard companionID == CompanionRosterDemoFixtures.companionID else {
            throw APIError(status: 404, code: "not_found", message: "Companion not found.")
        }
        if firstRequestID == nil {
            firstRequestID = requestID
            throw APIError(status: 0, code: "network_error", message: "The server could not be reached.")
        }
        guard firstRequestID == requestID else {
            throw APIError(status: 400, code: "idempotency_mismatch", message: "The delete request changed unexpectedly.")
        }
        return CompanionRosterDemoFixtures.deleteOperation
    }
}

@MainActor
private enum CompanionRosterDemoFixtures {
    static let companionID = "c96ab360-00f3-4497-a51a-51442db8add1"

    static let session = Session(
        cookie: "demo-session",
        orgID: "demo-org",
        needsOnboarding: false,
        user: .init(id: "demo-user", email: "demo@example.com", name: "Demo")
    )

    static func companion(
        id: String = companionID,
        name: String = "Luna",
        access: CompanionAccess,
        pinned: Bool = false,
        hidden: Bool = false,
        unread: Bool = false
    ) -> CompanionSummary {
        decode(#"""
        {
          "id":"\#(id)",
          "name":"\#(name)",
          "persona":"Keep releases calm",
          "model_id":"claude-sonnet",
          "selected_skill_ids":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"],
          "icon":{"shape":6,"mouth":1,"accessory":6,"color":2},
          "access":"\#(access.rawValue)",
          "pinned":\#(pinned),
          "hidden":\#(hidden),
          "unread":\#(unread),
          "last_message":{"preview":"Release notes are ready.","role":"assistant","created_at":"2026-08-25T08:00:00.000Z"},
          "runtime":{"state":"running","replying":false,"last_error":null,"provider_ids":["anthropic"],"latest_operation":null}
        }
        """#)
    }

    static var deleteOperation: CompanionOperationSummary {
        decode(#"""
        {
          "id":"14757274-8d64-455c-a394-334665a258f0",
          "kind":"delete",
          "status":"pending",
          "error":null
        }
        """#)
    }

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        try! JSONDecoder().decode(Value.self, from: Data(json.utf8))
    }
}
#endif

private extension View {
    func rosterListRow(verticalInset: CGFloat = 6) -> some View {
        listRowInsets(
            EdgeInsets(top: verticalInset, leading: 16, bottom: verticalInset, trailing: 16)
        )
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }
}

private enum CompanionRoute: Hashable {
    case chat(String)
    case settings(String)

    var companionID: String {
        switch self {
        case .chat(let id), .settings(let id): return id
        }
    }
}

private struct CompanionRow: View {
    let companion: CompanionSummary
    let deletionOperation: CompanionOperationSummary?

    var body: some View {
        HStack(spacing: 14) {
            ZStack(alignment: .bottomTrailing) {
                CompanionAvatar(
                    name: companion.name,
                    icon: companion.icon,
                    size: 52,
                    state: companion.runtime.replying ? .thinking : .idle
                )
                Circle()
                    .fill(statusColor)
                    .frame(width: 13, height: 13)
                    .overlay { Circle().stroke(Color.white.opacity(0.92), lineWidth: 2) }
            }

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(companion.name)
                        .font(.headline)
                        .foregroundStyle(Color.companionInk)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(timeLabel)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(Color.companionMuted)
                }

                HStack(alignment: .center, spacing: 8) {
                    Text(preview)
                        .font(.subheadline)
                        .foregroundStyle(companion.unread ? Color.companionInk : Color.companionMuted)
                        .fontWeight(companion.unread ? .medium : .regular)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    if companion.unread {
                        CompanionUnreadBadge(count: 1, tint: visualTheme.accent)
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .companionGlass(radius: 22, interactive: true)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(companion.name), \(statusLabel), \(preview)\(companion.unread ? ", unread" : "")")
    }

    private var preview: String {
        guard let deletionOperation else {
            return companion.lastMessage?.preview ?? companion.persona ?? "No messages yet"
        }
        if deletionOperation.isActive { return "Deletion requested" }
        if let message = deletionOperation.error?.message { return message }
        return companion.lastMessage?.preview ?? companion.persona ?? "No messages yet"
    }

    private var statusLabel: String {
        if companion.runtime.replying { return "replying" }
        switch companion.runtime.state {
        case .running: return "online"
        case .provisioning: return "starting"
        case .stopping: return "stopping"
        case .error: return "needs attention"
        case .notCreated, .stopped: return "asleep"
        case .unknown: return "unknown status"
        }
    }

    private var statusColor: Color {
        if companion.runtime.replying { return visualTheme.accent }
        switch companion.runtime.state {
        case .running: return .companionSuccess
        case .provisioning, .stopping: return .companionWarning
        case .error: return .companionDanger
        case .notCreated, .stopped, .unknown: return .companionMuted
        }
    }

    private var visualTheme: CompanionVisualTheme {
        CompanionVisualTheme(icon: companion.icon)
    }

    private var timeLabel: String {
        guard let value = companion.lastMessage?.createdAt,
              let date = ISO8601DateFormatter().date(from: value) else { return statusLabel.capitalized }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: .now)
    }
}

private struct CompanionUnreadBadge: View {
    let count: Int
    let tint: Color

    var body: some View {
        Group {
            if count == 1 {
                Circle()
                    .fill(tint)
                    .frame(width: 10, height: 10)
            } else {
                Text(count > 9 ? "9+" : "\(count)")
                    .font(.caption2.monospacedDigit().weight(.bold))
                    .foregroundStyle(Color.companionInk)
                    .padding(.horizontal, 6)
                    .frame(minWidth: 22, minHeight: 22)
                    .background(tint, in: Capsule())
            }
        }
        .accessibilityLabel(count == 1 ? "1 unread message" : "\(count) unread messages")
    }
}
