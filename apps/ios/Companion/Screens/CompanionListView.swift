import SwiftUI
import CompanionKit

struct CompanionListView: View {
    @Environment(SessionStore.self) private var sessionStore
    let session: Session
    @State private var companions: [CompanionSummary] = []
    @State private var loading = true
    @State private var error: String?
    @State private var reloadGeneration = 0

    var body: some View {
        NavigationStack {
            Group {
                if loading && companions.isEmpty {
                    ProgressView("Loading Companions…")
                } else if let error, companions.isEmpty {
                    ContentUnavailableView {
                        Label("Could not load Companions", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Try again") { Task { await reload() } }
                            .buttonStyle(.borderedProminent)
                    }
                } else if visibleCompanions.isEmpty {
                    ContentUnavailableView(
                        "No Companions yet",
                        systemImage: "message",
                        description: Text("Create a Companion in your workspace to begin a durable conversation.")
                    )
                } else {
                    List(visibleCompanions) { companion in
                        NavigationLink(value: companion) {
                            CompanionRow(companion: companion)
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await reload() }
                    .navigationDestination(for: CompanionSummary.self) { companion in
                        ChatView(companion: companion)
                    }
                }
            }
            .background(Color.companionCanvas)
            .navigationTitle("Companions")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Text(session.user.email)
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                        .lineLimit(1)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Sign out") { Task { await sessionStore.signOut() } }
                }
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

    private var visibleCompanions: [CompanionSummary] {
        companions.filter { !$0.hidden }
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
        HStack(spacing: 13) {
            Image(systemName: "message.fill")
                .foregroundStyle(Color.companionAccentForeground)
                .frame(width: 38, height: 38)
                .background(Color.companionAccent)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(companion.name).font(.headline).lineLimit(1)
                    Spacer()
                    Text(statusLabel)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(Color.companionMuted)
                }
                Text(companion.lastMessage?.preview ?? companion.persona ?? "No messages yet")
                    .font(.subheadline)
                    .foregroundStyle(Color.companionMuted)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 5)
    }

    private var statusLabel: String {
        if companion.runtime.replying { return "Replying" }
        switch companion.runtime.state {
        case .running: return "Online"
        case .provisioning: return "Starting"
        case .error: return "Needs attention"
        case .notCreated, .stopped, .stopping: return "Asleep"
        case .unknown: return "Unknown"
        }
    }
}
