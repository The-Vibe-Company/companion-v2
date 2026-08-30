import CompanionKit
import SwiftUI

/// Read-only trigger fire history. These reads stay in PostgreSQL and never wake the Companion.
struct CompanionTriggerHistoryView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss

    let companionID: String
    let triggerID: String
    let triggerName: String

    @State private var runs: [CompanionTriggerRunSummary] = []
    @State private var nextCursor: String?
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        CompanionBackdrop {
            Group {
                if loading && runs.isEmpty {
                    ProgressView("Loading fire history…")
                } else if let error, runs.isEmpty {
                    ContentUnavailableView {
                        Label("Could not load fire history", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Try again", systemImage: "arrow.clockwise") {
                            Task { await loadRuns() }
                        }
                        .buttonStyle(.glassProminent)
                    }
                } else if runs.isEmpty {
                    ContentUnavailableView(
                        "No fires yet",
                        systemImage: "bolt.horizontal.circle",
                        description: Text("The first provider event will appear here with its status and received payload.")
                    )
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(triggerName)
                                    .font(.title3.weight(.semibold))
                                    .foregroundStyle(Color.companionInk)
                                Text("Newest provider events first")
                                    .font(.footnote)
                                    .foregroundStyle(Color.companionMuted)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)

                            if let error { CompanionErrorNotice(message: error) }

                            ForEach(runs) { run in
                                NavigationLink {
                                    CompanionTriggerRunDetailView(
                                        companionID: companionID,
                                        run: run
                                    )
                                } label: {
                                    runRow(run)
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("companion.trigger-history.run.\(run.runID)")
                            }

                            if nextCursor != nil {
                                Button {
                                    Task { await loadRuns(cursor: nextCursor) }
                                } label: {
                                    HStack(spacing: 8) {
                                        if loading { ProgressView().controlSize(.small) }
                                        Text(loading ? "Loading…" : "Load earlier fires")
                                    }
                                    .frame(maxWidth: .infinity, minHeight: 44)
                                }
                                .buttonStyle(.glass)
                                .disabled(loading)
                            }
                        }
                        .padding(16)
                        .padding(.bottom, 20)
                    }
                    .refreshable { await loadRuns() }
                    .scrollIndicators(.hidden)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding((loading && runs.isEmpty) ? 24 : 0)
        }
        .navigationTitle("Fire history")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") { dismiss() }
            }
        }
        .task(id: "\(companionID):\(triggerID)") { await loadRuns() }
        .accessibilityIdentifier("companion.trigger-history")
    }

    private func runRow(_ run: CompanionTriggerRunSummary) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(MemberTimezone.formatInstant(run.createdAt, in: displayTimezone) ?? run.createdAt)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                Text(resultLabel(run))
                    .font(.footnote)
                    .foregroundStyle(Color.companionMuted)
            }
            Spacer(minLength: 8)
            triggerStatusBadge(run.status)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.companionMuted)
                .frame(width: 24, height: 44)
                .accessibilityHidden(true)
        }
        .padding(14)
        .companionMaterial(radius: 12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(resultLabel(run)), \(triggerStatusWord(run.status))")
    }

    private func loadRuns(cursor: String? = nil) async {
        loading = true
        error = nil
        do {
            let page = try await sessionStore.listCompanionTriggerRuns(
                companionID: companionID,
                triggerID: triggerID,
                limit: 50,
                cursor: cursor
            )
            guard !Task.isCancelled else { return }
            let ordered = page.runs.sorted { $0.createdAt > $1.createdAt }
            runs = cursor == nil ? ordered : runs + ordered.filter { next in !runs.contains(where: { $0.id == next.id }) }
            nextCursor = page.nextCursor
        } catch is CancellationError {
            return
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Trigger fire history could not be loaded.")
        }
        loading = false
    }

    private var displayTimezone: String {
        sessionStore.memberTimezone ?? MemberTimezone.deviceIdentifier
    }
}

private struct CompanionTriggerRunDetailView: View {
    @Environment(SessionStore.self) private var sessionStore

    let companionID: String
    let run: CompanionTriggerRunSummary

    @State private var detail: CompanionTriggerRunDetail?
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        CompanionBackdrop {
            if loading && detail == nil {
                ProgressView("Loading trigger fire…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error, detail == nil {
                ContentUnavailableView {
                    Label("Could not load this fire", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try again", systemImage: "arrow.clockwise") { Task { await load() } }
                        .buttonStyle(.glassProminent)
                }
            } else if let detail {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        HStack {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(resultLabel(run))
                                    .font(.headline)
                                    .foregroundStyle(Color.companionInk)
                                Text(MemberTimezone.formatInstant(detail.createdAt, in: displayTimezone) ?? detail.createdAt)
                                    .font(.footnote)
                                    .foregroundStyle(Color.companionMuted)
                            }
                            Spacer()
                            triggerStatusBadge(detail.status)
                        }
                        .padding(14)
                        .companionMaterial(radius: 12)

                        if let message = detail.error?.message { CompanionErrorNotice(message: message) }

                        Text("Internal transcript")
                            .font(.headline)
                            .foregroundStyle(Color.companionInk)

                        if detail.internalEntries.isEmpty {
                            Text("This fire finished without recorded private activity.")
                                .font(.footnote)
                                .foregroundStyle(Color.companionMuted)
                        } else {
                            ForEach(detail.internalEntries) { entry in
                                entryCard(entry)
                            }
                        }

                        if detail.nextEntryCursor != nil {
                            Button("Load more transcript") { Task { await load(cursor: detail.nextEntryCursor) } }
                                .buttonStyle(.glass)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .disabled(loading)
                        }
                    }
                    .padding(16)
                    .padding(.bottom, 20)
                }
                .scrollIndicators(.hidden)
            }
        }
        .navigationTitle("Trigger fire")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: run.runID) { await load() }
        .accessibilityIdentifier("companion.trigger-history.detail.\(run.runID)")
    }

    private func entryCard(_ entry: CompanionTriggerRunEntry) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(entry.role == "user" ? "Received payload" : entry.role.capitalized)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.companionMuted)
            if entry.role == "user" {
                DisclosureGroup("View payload") {
                    Text(entry.content)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 8)
                }
            } else {
                Text(entry.content)
                    .font(.subheadline)
                    .foregroundStyle(Color.companionInk)
                    .textSelection(.enabled)
            }
        }
        .padding(14)
        .companionMaterial(radius: 12)
    }

    private func load(cursor: Int? = nil) async {
        loading = true
        error = nil
        do {
            let page = try await sessionStore.readCompanionTriggerRun(
                companionID: companionID,
                runID: run.runID,
                entryLimit: 50,
                entryCursor: cursor
            )
            guard !Task.isCancelled else { return }
            if cursor != nil, let detail {
                self.detail = CompanionTriggerRunDetail(
                    runID: page.runID,
                    companionID: page.companionID,
                    trigger: page.trigger,
                    status: page.status,
                    mode: page.mode,
                    outcome: page.outcome,
                    surfaceMode: page.surfaceMode,
                    mainEntryEventID: page.mainEntryEventID,
                    relayTurnID: page.relayTurnID,
                    createdAt: page.createdAt,
                    startedAt: page.startedAt,
                    settledAt: page.settledAt,
                    error: page.error,
                    internalEntries: detail.internalEntries + page.internalEntries,
                    nextEntryCursor: page.nextEntryCursor
                )
            } else {
                detail = page
            }
        } catch is CancellationError {
            return
        } catch {
            self.error = companionDisplayMessage(error, fallback: "This trigger fire could not be loaded.")
        }
        loading = false
    }

    private var displayTimezone: String {
        sessionStore.memberTimezone ?? MemberTimezone.deviceIdentifier
    }
}

private func resultLabel(_ run: CompanionTriggerRunSummary) -> String {
    switch (run.outcome, run.surfaceMode) {
    case (.surfaced, .notify): "Notified in main chat"
    case (.surfaced, .relay): "Relayed to main Companion"
    case (.noOutput, _): "No output"
    case (.error, _): "Processing failed"
    default: "Processing"
    }
}

private func triggerStatusWord(_ status: CompanionTriggerRunStatus) -> String {
    switch status {
    case .queued: "Queued"
    case .starting: "Starting"
    case .dispatching: "Dispatching"
    case .running: "Running"
    case .needsInput: "Needs input"
    case .succeeded: "Completed"
    case .failed: "Failed"
    case .interrupted: "Interrupted"
    case .cancelled: "Cancelled"
    case .unknown: "Unknown"
    }
}

private func triggerStatusBadge(_ status: CompanionTriggerRunStatus) -> some View {
    let danger = status == .failed || status == .cancelled
    return Text(triggerStatusWord(status))
        .font(.caption.weight(.semibold))
        .foregroundStyle(danger ? Color.companionDanger : Color.companionMuted)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background((danger ? Color.companionDanger : Color.companionMuted).opacity(0.12), in: Capsule())
}
