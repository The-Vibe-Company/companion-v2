import SwiftUI
import CompanionKit
import UIKit

@MainActor
struct CompanionListServices {
    let listCompanions: () async throws -> [CompanionSummary]
    let listSections: () async throws -> [CompanionSection]
    let createSection: (String) async throws -> CompanionSection
    let deleteSection: (String) async throws -> Void
    let assignSection: (String, String?) async throws -> CompanionSummary
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
    @State private var sectionStore = CompanionSectionStore()
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
    @State private var showingSearch = false
    @State private var companionToMove: CompanionSummary?
    @State private var pendingNewSectionCompanion: CompanionSummary?
    @State private var sectionToDelete: CompanionSection?
    @State private var showingNewSection = false
    @State private var newSectionName = ""
    @State private var rosterNotice: String?
    @State private var rosterActionError: String?
    @State private var chatReadingPositions = CompanionChatReadingPositionStore()

    init(session: Session, services: CompanionListServices? = nil) {
        self.session = session
        self.services = services
    }

    var body: some View {
        NavigationStack(path: $path) {
            CompanionIOSTheme.canvas
                .ignoresSafeArea()
                .overlay {
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
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: CompanionRoute.self) { route in
                destination(for: route)
            }
            .searchable(
                text: $query,
                isPresented: $showingSearch,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Search Companions"
            )
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
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
                        AccountAvatar(user: session.user)
                    }
                    .accessibilityLabel("Account for \(session.user.email)")
                    .accessibilityIdentifier("account.menu")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    circleToolbarButton("Search", systemImage: "magnifyingglass") {
                        showingSearch = true
                    }
                    circleToolbarButton("New Bot", systemImage: "plus") {
                        showingCreateCompanion = true
                    }
                }
            }
            .sheet(isPresented: $showingCreateCompanion) {
                CreateCompanionView { companion in
                    rosterState.prepend(companion)
                    path = [.chat(companion.id)]
                    Task { await reload(silently: true) }
                }
                .tint(CompanionIOSTheme.actionBlue)
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
            .confirmationDialog(
                "Move \(companionToMove?.name ?? "Companion") to",
                isPresented: Binding(
                    get: { companionToMove != nil },
                    set: { if !$0 { companionToMove = nil } }
                ),
                titleVisibility: .visible,
                presenting: companionToMove
            ) { companion in
                ForEach(ownedSections) { section in
                    Button(section.name) { Task { await move(companion, to: section.id) } }
                }
                Button("Unassigned") { Task { await move(companion, to: nil) } }
                Button("New Section") {
                    pendingNewSectionCompanion = companion
                    newSectionName = ""
                    showingNewSection = true
                }
                Button("Cancel", role: .cancel) {}
            }
            .alert("New Section", isPresented: $showingNewSection) {
                TextField("Section name", text: $newSectionName)
                Button("Create") { Task { await createSectionAndMove() } }
                    .disabled(newSectionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The Companion will move into the new section.")
            }
            .confirmationDialog(
                "Delete \(sectionToDelete?.name ?? "section")?",
                isPresented: Binding(
                    get: { sectionToDelete != nil },
                    set: { if !$0 { sectionToDelete = nil } }
                ),
                titleVisibility: .visible,
                presenting: sectionToDelete
            ) { section in
                Button("Delete Section", role: .destructive) { Task { await deleteSection(section) } }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("Companions in this section will move to Unassigned.")
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
            .tint(CompanionIOSTheme.textPrimary)
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

            ForEach(homeSections) { section in
                Section {
                    if !section.isCollapsed || !query.isEmpty {
                        if section.usesPinnedGrid && query.isEmpty {
                            pinnedGrid(section.companions)
                                .rosterListRow(verticalInset: 8)
                        } else {
                            ForEach(section.companions) { companionRow($0) }
                        }
                    }
                } header: {
                    sectionHeader(section)
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
                query.isEmpty ? "Create your first companion" : "No matches",
                systemImage: "bubble.left.and.bubble.right"
            )
        } description: {
            Text(query.isEmpty ? "Give your new companion a name and character to begin." : "Try a different name or message.")
        } actions: {
            if query.isEmpty {
                Button("Create", systemImage: "plus") {
                    showingCreateCompanion = true
                }
                .buttonStyle(.borderedProminent)
                .tint(CompanionIOSTheme.primaryCTA)
            }
        }
        .padding(24)
    }

    private var matchingCompanions: [CompanionSummary] {
        companions.filter(matchesSearch)
    }

    private var homeSections: [CompanionHomeSection] {
        sectionStore.groups(companions: matchingCompanions)
    }

    private var ownedSections: [CompanionSection] {
        sectionStore.sections.filter { $0.ownerID == session.user.id }
    }

    private func matchesSearch(_ companion: CompanionSummary) -> Bool {
        guard !query.isEmpty else { return true }
        return companion.name.localizedStandardContains(query)
            || (companion.lastMessage?.preview.localizedStandardContains(query) ?? false)
            || (companion.persona?.localizedStandardContains(query) ?? false)
    }

    private func circleToolbarButton(
        _ label: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 44, height: 44)
                .background(CompanionIOSTheme.innerBubble, in: Circle())
                .overlay { Circle().stroke(CompanionIOSTheme.separator, lineWidth: 1) }
        }
        .accessibilityLabel(label)
    }

    private func sectionHeader(_ section: CompanionHomeSection) -> some View {
        Button {
            withRosterAnimation { sectionStore.toggleCollapsed(sectionID: section.id) }
        } label: {
            HStack(spacing: 7) {
                Text(section.name)
                    .font(.system(size: 13))
                Image(systemName: section.isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                Spacer()
            }
            .foregroundStyle(CompanionIOSTheme.textSecondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .textCase(nil)
        .contextMenu {
            if !section.isUnassigned,
               let model = sectionStore.sections.first(where: { $0.id == section.id }),
               model.ownerID == session.user.id {
                Button("Delete Section", systemImage: "trash", role: .destructive) {
                    sectionToDelete = model
                }
            }
        }
    }

    private func pinnedGrid(_ companions: [CompanionSummary]) -> some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 24) {
                ForEach(companions) { companion in
                    NavigationLink(value: CompanionRoute.chat(companion.id)) {
                        VStack(spacing: 7) {
                            CharacterMark(name: companion.name, icon: companion.icon, size: 80)
                            Text(companion.name)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(CompanionIOSTheme.textPrimary)
                                .lineLimit(1)
                        }
                        .frame(width: 86)
                    }
                    .buttonStyle(.plain)
                    .contextMenu { companionContextMenu(for: companion, busy: false) }
                }
            }
        }
        .scrollIndicators(.hidden)
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
        .swipeActions(edge: .trailing) {
            if companion.access.canDeleteCompanion {
                Button("Move to", systemImage: "folder") { companionToMove = companion }
                    .tint(CompanionIOSTheme.actionBlue)
            }
            Button(companion.muted ? "Unmute" : "Mute",
                   systemImage: companion.muted ? "bell" : "bell.slash") {
                Task { await updateMemberState(companion, patch: .init(muted: !companion.muted)) }
            }
                .tint(.gray)
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
        if companion.access.canDeleteCompanion {
            Button("Duplicate", systemImage: "plus.square.on.square") {
                Task { await duplicate(companion) }
            }
            .disabled(busy)
        }

        Button("Edit character", systemImage: "paintpalette") {
            path.append(.identity(companion.id))
        }
        .disabled(companion.access == .viewer || busy)

        Button("Move to", systemImage: "folder") { companionToMove = companion }
            .disabled(!companion.access.canDeleteCompanion || busy)

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
            let nextSections: [CompanionSection]
            if let services {
                async let companionResult = services.listCompanions()
                async let sectionResult = services.listSections()
                (next, nextSections) = try await (companionResult, sectionResult)
            } else {
                async let companionResult = sessionStore.listCompanions()
                async let sectionResult = sessionStore.listCompanionSections()
                (next, nextSections) = try await (companionResult, sectionResult)
            }
            guard generation == reloadGeneration else { return }
            rosterState.reconcile(with: next)
            sectionStore.reconcile(with: nextSections)
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
            case .identity:
                CompanionIdentityEditorView(companion: companion, onSaved: replace)
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
            path = [.identity(duplicate.id)]
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
        if let muted = patch.muted {
            return muted ? "\(companion.name) muted." : "\(companion.name) unmuted."
        }
        if patch.unread == true { return "\(companion.name) marked as unread." }
        return "\(companion.name) updated."
    }

    private func move(_ companion: CompanionSummary, to sectionID: String?) async {
        companionToMove = nil
        do {
            let updated: CompanionSummary
            if let services {
                updated = try await services.assignSection(companion.id, sectionID)
            } else {
                updated = try await sessionStore.assignCompanionSection(
                    companionID: companion.id,
                    sectionID: sectionID
                )
            }
            rosterState.replace(updated)
            let sectionName = sectionID.flatMap { id in
                sectionStore.sections.first(where: { $0.id == id })?.name
            }
            rosterNotice = sectionName.map { "\(companion.name) moved to \($0)." }
                ?? "\(companion.name) moved to Unassigned."
        } catch {
            rosterActionError = companionDisplayMessage(error, fallback: "This Companion could not be moved.")
        }
    }

    private func createSectionAndMove() async {
        guard let companion = pendingNewSectionCompanion else { return }
        pendingNewSectionCompanion = nil
        let name = newSectionName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        do {
            let section: CompanionSection
            if let services {
                section = try await services.createSection(name)
            } else {
                section = try await sessionStore.createCompanionSection(name: name)
            }
            sectionStore.reconcile(with: sectionStore.sections + [section])
            await move(companion, to: section.id)
        } catch {
            rosterActionError = companionDisplayMessage(error, fallback: "The section could not be created.")
        }
    }

    private func deleteSection(_ section: CompanionSection) async {
        sectionToDelete = nil
        do {
            if let services {
                try await services.deleteSection(section.id)
            } else {
                try await sessionStore.deleteCompanionSection(sectionID: section.id)
            }
            sectionStore.remove(sectionID: section.id)
            await reload(silently: true)
            rosterNotice = "\(section.name) deleted. Its Companions are Unassigned."
        } catch {
            rosterActionError = companionDisplayMessage(error, fallback: "The section could not be deleted.")
        }
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

private struct AccountAvatar: View {
    @Environment(SessionStore.self) private var sessionStore
    let user: Session.User
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Circle()
                    .fill(Color(.secondarySystemBackground))
                    .overlay {
                        Text(initials)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.primary)
                    }
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(Circle())
        .overlay { Circle().stroke(CompanionIOSTheme.separator, lineWidth: 1) }
        .task(id: user.avatarURL) {
            guard let avatarURL = user.avatarURL,
                  let data = try? await sessionStore.userAvatarData(at: avatarURL),
                  let loaded = UIImage(data: data) else { return }
            image = loaded
        }
    }

    private var initials: String {
        let source = user.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = (source?.isEmpty == false ? source! : user.email)
            .split(whereSeparator: { $0 == " " || $0 == "@" || $0 == "." })
        return parts.prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
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
                listSections: { [CompanionRosterDemoFixtures.section] },
                createSection: { _ in CompanionRosterDemoFixtures.section },
                deleteSection: { _ in },
                assignSection: { _, _ in CompanionRosterDemoFixtures.companion(access: access) },
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

    static let section: CompanionSection = decode(#"""
    {
      "id":"1c6759e2-58d2-4b0e-8f99-6cd73175f85a",
      "org_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "owner_id":"demo-user",
      "name":"Favorites",
      "position":0,
      "created_at":"2026-08-27T00:00:00Z",
      "updated_at":"2026-08-27T00:00:00Z"
    }
    """#)

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
    case identity(String)

    var companionID: String {
        switch self {
        case .chat(let id), .settings(let id), .identity(let id): return id
        }
    }
}

private struct CompanionRow: View {
    let companion: CompanionSummary
    let deletionOperation: CompanionOperationSummary?

    var body: some View {
        HStack(spacing: 12) {
            CharacterMark(name: companion.name, icon: companion.icon, size: 36)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(companion.name)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(timeLabel)
                        .font(.system(size: 13))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                }

                HStack(alignment: .center, spacing: 8) {
                    Text(preview)
                        .font(.system(size: 15))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if companion.unread {
                        Circle()
                            .fill(CompanionIOSTheme.actionBlue)
                            .frame(width: 6, height: 6)
                            .accessibilityLabel("Unread")
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
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
              let date = Self.parseDate(value) else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if let days = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: date),
            to: calendar.startOfDay(for: .now)
        ).day, days >= 0, days < 7 {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(.dateTime.month(.defaultDigits).day())
    }

    private static func parseDate(_ value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: value) ?? ISO8601DateFormatter().date(from: value)
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
