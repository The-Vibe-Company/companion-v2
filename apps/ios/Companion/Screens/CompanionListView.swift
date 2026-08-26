import SwiftUI
import CompanionKit

@MainActor
struct CompanionListServices {
    let listCompanions: () async throws -> [CompanionSummary]
    let deleteCompanion: (String, UUID) async throws -> CompanionOperationSummary
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
    @State private var rosterNotice: String?
    @State private var rosterActionError: String?

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
                    } else if visibleCompanions.isEmpty {
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
        ScrollView {
            LazyVStack(spacing: 12) {
                if let rosterActionError {
                    CompanionErrorNotice(message: rosterActionError)
                } else if let rosterNotice {
                    CompanionSuccessNotice(message: rosterNotice)
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
                .padding(.horizontal, 4)

                ForEach(visibleCompanions) { companion in
                    NavigationLink(value: CompanionRoute.chat(companion.id)) {
                        CompanionRow(
                            companion: companion,
                            deletionOperation: effectiveDeletion(for: companion)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("companion.row.\(companion.id)")
                    .contextMenu {
                        Button("Settings", systemImage: "gearshape") {
                            path.append(.settings(companion.id))
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
                            }
                        }
                    }
                    .accessibilityAction(named: "Settings") {
                        path.append(.settings(companion.id))
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 28)
        }
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

    private var visibleCompanions: [CompanionSummary] {
        companions.filter { companion in
            guard !companion.hidden else { return false }
            guard !query.isEmpty else { return true }
            return companion.name.localizedStandardContains(query)
                || (companion.lastMessage?.preview.localizedStandardContains(query) ?? false)
                || (companion.persona?.localizedStandardContains(query) ?? false)
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
                    onPlugins: { showingPlugins = true },
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

    private func effectiveDeletion(for companion: CompanionSummary) -> CompanionOperationSummary? {
        companion.deletionOperation
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

    static func companion(access: CompanionAccess) -> CompanionSummary {
        decode(#"""
        {
          "id":"\#(companionID)",
          "name":"Luna",
          "persona":"Keep releases calm",
          "model_id":"claude-sonnet",
          "selected_skill_ids":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"],
          "icon":{"shape":6,"mouth":1,"accessory":6,"color":2},
          "access":"\#(access.rawValue)",
          "hidden":false,
          "unread":false,
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
                        Circle()
                            .fill(visualTheme.accent)
                            .frame(width: 8, height: 8)
                            .accessibilityLabel("Unread")
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
