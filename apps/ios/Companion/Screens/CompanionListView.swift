import SwiftUI
import CompanionKit

struct CompanionListView: View {
    @Environment(SessionStore.self) private var sessionStore
    let session: Session
    @State private var companions: [CompanionSummary] = []
    @State private var query = ""
    @State private var loading = true
    @State private var error: String?
    @State private var reloadGeneration = 0
    @State private var showingCreateCompanion = false
    @State private var showingProviders = false
    @State private var showingPlugins = false

    var body: some View {
        NavigationStack {
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
                }
            }
            .sheet(isPresented: $showingCreateCompanion) {
                CreateCompanionView { companion in
                    companions.insert(companion, at: 0)
                    Task { await reload(silently: true) }
                }
            }
            .sheet(isPresented: $showingProviders) {
                ProviderManagementView()
            }
            .sheet(isPresented: $showingPlugins) {
                PluginManagementView()
            }
            .task(id: session.orgID) {
                await reload()
                while !Task.isCancelled {
                    let interval: UInt64 = companions.contains(where: { $0.runtime.replying }) ? 8 : 45
                    try? await Task.sleep(for: .seconds(interval))
                    if !Task.isCancelled { await reload(silently: true) }
                }
            }
        }
    }

    private var roster: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
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
                    NavigationLink(value: companion) {
                        CompanionRow(companion: companion)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 28)
        }
        .refreshable { await reload() }
        .scrollIndicators(.hidden)
        .navigationDestination(for: CompanionSummary.self) { companion in
            ChatView(companion: companion)
        }
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
            let next = try await sessionStore.listCompanions()
            guard generation == reloadGeneration else { return }
            companions = next
            error = nil
        } catch let apiError as APIError where apiError.status == 403 || apiError.status == 404 {
            guard generation == reloadGeneration else { return }
            error = "Hosted Companions are not enabled for this workspace."
        } catch {
            guard generation == reloadGeneration else { return }
            self.error = "The workspace roster is temporarily unavailable."
        }
        if generation == reloadGeneration { loading = false }
    }
}

private struct CompanionRow: View {
    let companion: CompanionSummary

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
                    Text(companion.lastMessage?.preview ?? companion.persona ?? "No messages yet")
                        .font(.subheadline)
                        .foregroundStyle(companion.unread ? Color.companionInk : Color.companionMuted)
                        .fontWeight(companion.unread ? .medium : .regular)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    if companion.unread {
                        Circle()
                            .fill(Color.companionAccent)
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
        .accessibilityLabel("\(companion.name), \(statusLabel), \(companion.lastMessage?.preview ?? "no messages")\(companion.unread ? ", unread" : "")")
    }

    private var statusLabel: String {
        if companion.runtime.replying { return "replying" }
        switch companion.runtime.state {
        case .running: return "online"
        case .provisioning: return "starting"
        case .error: return "needs attention"
        case .notCreated, .stopped, .stopping: return "asleep"
        case .unknown: return "unknown status"
        }
    }

    private var statusColor: Color {
        if companion.runtime.replying { return .companionAccent }
        switch companion.runtime.state {
        case .running: return .companionSuccess
        case .provisioning: return .companionWarning
        case .error: return .companionDanger
        case .notCreated, .stopped, .stopping, .unknown: return .companionMuted
        }
    }

    private var timeLabel: String {
        guard let value = companion.lastMessage?.createdAt,
              let date = ISO8601DateFormatter().date(from: value) else { return statusLabel.capitalized }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: .now)
    }
}
