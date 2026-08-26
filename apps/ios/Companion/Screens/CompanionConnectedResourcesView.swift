import SwiftUI
import CompanionKit

@MainActor
struct CompanionConnectedResourcesServices {
    let load: () async throws -> CompanionConnectedResources
    let listPlugins: () async throws -> [CompanionPluginAccount]
    let updatePluginSelection: ([String]) async throws -> CompanionSummary
    let loadCompanion: () async throws -> CompanionSummary
    let restart: (CompanionRuntimeRestartTarget, UUID) async throws -> CompanionOperationSummary
}

struct CompanionConnectedResourcesView: View {
    @Environment(SessionStore.self) private var sessionStore
    let companion: CompanionSummary
    let hasUnsavedSettings: Bool
    let onCompanionUpdated: (CompanionSummary) -> Void
    private let services: CompanionConnectedResourcesServices?
    @State private var currentCompanion: CompanionSummary
    @State private var resources: CompanionConnectedResources?
    @State private var plugins: [CompanionPluginAccount] = []
    @State private var loading = true
    @State private var error: String?
    @State private var success: String?
    @State private var loadGeneration = 0
    @State private var mutatingPluginID: String?
    @State private var showingPluginChoices = false
    @State private var showingPluginManagement = false
    @State private var restartTarget: CompanionRuntimeRestartTarget?
    @State private var restartingTarget: CompanionRuntimeRestartTarget?
    @State private var restartRequestIDs: [CompanionRuntimeRestartTarget: UUID] = [:]
    @State private var acceptedOperation: CompanionOperationSummary?

    init(
        companion: CompanionSummary,
        hasUnsavedSettings: Bool = false,
        onCompanionUpdated: @escaping (CompanionSummary) -> Void = { _ in },
        services: CompanionConnectedResourcesServices? = nil
    ) {
        self.companion = companion
        self.hasUnsavedSettings = hasUnsavedSettings
        self.onCompanionUpdated = onCompanionUpdated
        self.services = services
        _currentCompanion = State(initialValue: companion)
        _acceptedOperation = State(initialValue: companion.runtime.latestOperation)
    }

    var body: some View {
        CompanionBackdrop(style: .companion(visualTheme.base)) {
            Group {
                if loading, resources == nil {
                    loadingState
                } else if let error, resources == nil {
                    errorState(error)
                } else if let resources {
                    resourceList(resources)
                }
            }
        }
        .navigationTitle("Connected resources")
        .navigationBarTitleDisplayMode(.inline)
        .tint(visualTheme.accent)
        .task(id: companion.id) { await load() }
        .task(id: runtimePollingID) { await pollRuntimeWhileNeeded() }
        .onChange(of: companion) { _, updated in
            currentCompanion = updated.reconcilingParentProjection(from: currentCompanion)
            acceptedOperation = currentCompanion.runtime.latestOperation
        }
        .confirmationDialog(
            restartConfirmationTitle,
            isPresented: Binding(
                get: { restartTarget != nil },
                set: { if !$0 { restartTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let restartTarget {
                Button(restartConfirmationButton(restartTarget)) {
                    Task { await restart(restartTarget) }
                }
            }
            Button("Cancel", role: .cancel) { restartTarget = nil }
        } message: {
            if restartTarget == .box {
                Text("This queues a full server restart. Active work is interrupted, but the Companion and its saved files remain.")
            } else {
                Text("This queues a fresh Companion process. The server and saved files remain in place.")
            }
        }
        .confirmationDialog(
            "Add connected plugin",
            isPresented: $showingPluginChoices,
            titleVisibility: .visible
        ) {
            ForEach(availablePlugins) { plugin in
                Button("\(pluginProviderName(plugin.provider)) · \(plugin.label)") {
                    Task { await setPlugin(plugin, attached: true) }
                }
            }
            Button("Connect another account") { showingPluginManagement = true }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(availablePlugins.isEmpty
                ? "Connect a plugin account, then attach it to this Companion."
                : "Choose one of your connected plugin accounts.")
        }
        .sheet(isPresented: $showingPluginManagement, onDismiss: { Task { await loadPlugins() } }) {
            PluginManagementView()
                .tint(visualTheme.accent)
        }
        .accessibilityIdentifier("companion.resources")
    }

    private func resourceList(_ resources: CompanionConnectedResources) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                header
                if let error {
                    CompanionErrorNotice(message: error)
                }
                if let success {
                    CompanionSuccessNotice(message: success)
                }
                resourceSection(
                    title: "Skills",
                    symbol: "shippingbox",
                    count: currentCompanion.selectedSkillIDs.count
                ) {
                    if currentCompanion.selectedSkillIDs.isEmpty {
                        emptyRow(
                            title: "No Skills connected",
                            detail: "Attached Skills will appear here.",
                            identifier: "companion.resources.skills.empty"
                        )
                    } else {
                        ForEach(Array(resources.skills.enumerated()), id: \.element.id) { index, skill in
                            if index > 0 { resourceDivider }
                            skillRow(skill)
                        }
                        if resources.hiddenSkillCount > 0 {
                            if !resources.skills.isEmpty { resourceDivider }
                            hiddenSkillsRow(count: resources.hiddenSkillCount)
                        }
                    }
                }

                resourceSection(
                    title: "Connected plugins",
                    symbol: "puzzlepiece.extension",
                    count: attachedPlugins.count
                ) {
                    if attachedPlugins.isEmpty {
                        emptyRow(
                            title: "No plugins attached",
                            detail: canManagePlugins
                                ? "Add one of your connected accounts to make its tools available."
                                : "No attached plugin accounts are available to you.",
                            identifier: "companion.resources.plugins.empty"
                        )
                    } else {
                        ForEach(Array(attachedPlugins.enumerated()), id: \.element.id) { index, plugin in
                            if index > 0 { resourceDivider }
                            pluginRow(plugin)
                        }
                    }
                    if unavailablePluginCount > 0 {
                        if !attachedPlugins.isEmpty { resourceDivider }
                        unavailablePluginsRow(count: unavailablePluginCount)
                    }
                    if canManagePlugins {
                        resourceDivider
                        Button("Add plugin", systemImage: "plus") {
                            showingPluginChoices = true
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 16)
                        .disabled(mutatingPluginID != nil || operationActive)
                        .accessibilityIdentifier("companion.resources.plugins.add")
                    } else if currentCompanion.access == .editor {
                        resourceDivider
                        Text("Only the Companion Owner can change plugin attachments. This protects private accounts already attached by other members.")
                            .font(.caption)
                            .foregroundStyle(Color.companionMuted)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(16)
                            .accessibilityIdentifier("companion.resources.plugins.owner-only")
                    }
                }

                resourceSection(
                    title: "Routines",
                    symbol: "clock",
                    count: resources.routines.count
                ) {
                    if resources.routines.isEmpty {
                        emptyRow(
                            title: "No routines connected",
                            detail: "Scheduled prompts will appear here.",
                            identifier: "companion.resources.routines.empty"
                        )
                    } else {
                        ForEach(Array(resources.routines.enumerated()), id: \.element.id) { index, routine in
                            if index > 0 { resourceDivider }
                            routineRow(routine)
                        }
                    }
                }

                resourceSection(
                    title: "Triggers",
                    symbol: "bolt",
                    count: resources.triggers.count
                ) {
                    if resources.triggers.isEmpty {
                        emptyRow(
                            title: "No triggers connected",
                            detail: "Webhook prompts will appear here.",
                            identifier: "companion.resources.triggers.empty"
                        )
                    } else {
                        ForEach(Array(resources.triggers.enumerated()), id: \.element.id) { index, trigger in
                            if index > 0 { resourceDivider }
                            triggerRow(trigger)
                        }
                    }
                }

                runtimeSection
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 30)
        }
        .refreshable { await load() }
        .scrollIndicators(.hidden)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 13) {
            CompanionAvatar(name: currentCompanion.name, icon: currentCompanion.icon, size: 48, state: .still)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(currentCompanion.name)
                    .font(.headline)
                    .foregroundStyle(Color.companionInk)
                Text("Resources available when this Companion works.")
                    .font(.subheadline)
                    .foregroundStyle(Color.companionMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func resourceSection<Content: View>(
        title: String,
        symbol: String,
        count: Int,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Label(title, systemImage: symbol)
                    .font(.headline)
                    .foregroundStyle(Color.companionInk)
                Spacer()
                Text("\(count)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(Color.companionMuted)
                    .accessibilityLabel("\(count) \(title.lowercased())")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .accessibilityAddTraits(.isHeader)

            Divider()
                .overlay(Color.companionDivider)

            content()
        }
        .companionMaterial(radius: 12)
    }

    private func skillRow(_ skill: CompanionSkillSummary) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(skill.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                if skill.displayName != skill.slug {
                    Text(skill.slug)
                        .font(.caption.monospaced())
                        .foregroundStyle(Color.companionMuted)
                        .textSelection(.enabled)
                }
                Text(skill.description.isEmpty ? "No description provided." : skill.description)
                    .font(.footnote)
                    .foregroundStyle(Color.companionMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            statusBadge(.active, activeLabel: "Enabled")
        }
        .padding(16)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(skill.displayName). \(skill.description.isEmpty ? "No description provided." : skill.description). Enabled")
        .accessibilityIdentifier("companion.resources.skill.\(skill.id)")
    }

    private func hiddenSkillsRow(count: Int) -> some View {
        Label(
            "\(count) selected \(count == 1 ? "Skill is" : "Skills are") not visible to you.",
            systemImage: "eye.slash"
        )
        .font(.footnote)
        .foregroundStyle(Color.companionMuted)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .accessibilityIdentifier("companion.resources.skills.hidden")
    }

    private func pluginRow(_ plugin: CompanionPluginAccount) -> some View {
        HStack(alignment: .center, spacing: 12) {
            PluginMark(provider: plugin.provider, size: 38)
            VStack(alignment: .leading, spacing: 4) {
                Text(plugin.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                Text(pluginProviderName(plugin.provider))
                    .font(.footnote)
                    .foregroundStyle(Color.companionMuted)
            }
            Spacer(minLength: 8)
            statusBadge(plugin.connected ? .active : .error, activeLabel: "Attached")
            if canManagePlugins {
                Button("Detach") {
                    Task { await setPlugin(plugin, attached: false) }
                }
                .font(.caption.weight(.semibold))
                .frame(minWidth: 44, minHeight: 44)
                .disabled(mutatingPluginID != nil || operationActive)
                .accessibilityLabel("Detach \(pluginProviderName(plugin.provider)) account \(plugin.label)")
                .accessibilityIdentifier("companion.resources.plugin.detach.\(plugin.id)")
            }
        }
        .padding(16)
        .accessibilityElement(children: canManagePlugins ? .contain : .combine)
        .accessibilityIdentifier("companion.resources.plugin.\(plugin.id)")
    }

    private func unavailablePluginsRow(count: Int) -> some View {
        Label(
            "\(count) attached plugin \(count == 1 ? "account could" : "accounts could") not be loaded.",
            systemImage: "eye.slash"
        )
        .font(.footnote)
        .foregroundStyle(Color.companionMuted)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .accessibilityIdentifier("companion.resources.plugins.hidden")
    }

    private func routineRow(_ routine: CompanionRoutine) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(routine.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                Text(routine.scheduleDescription)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.companionInk.opacity(0.82))
                HStack(spacing: 7) {
                    Text(routine.cron)
                        .font(.caption.monospaced())
                    Text("·")
                    Text(routine.timezone)
                        .font(.caption)
                }
                .foregroundStyle(Color.companionMuted)
                .fixedSize(horizontal: false, vertical: true)
                if let message = routine.lastErrorMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(Color.companionDanger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            statusBadge(routine.status)
        }
        .padding(16)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(routine.name). \(routine.scheduleDescription). \(routine.timezone). \(routine.status.label)"
        )
        .accessibilityIdentifier("companion.resources.routine.\(routine.id)")
    }

    private func triggerRow(_ trigger: CompanionTrigger) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(trigger.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                Text(trigger.providerName)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.companionInk.opacity(0.82))
                Text(trigger.registrationDescription)
                    .font(.caption)
                    .foregroundStyle(
                        trigger.registrationStatus == .failed
                            ? Color.companionDanger
                            : Color.companionMuted
                    )
                if let message = trigger.lastErrorMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(Color.companionDanger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            statusBadge(trigger.status)
        }
        .padding(16)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(trigger.name). \(trigger.providerName). \(trigger.registrationDescription). \(trigger.status.label)"
        )
        .accessibilityIdentifier("companion.resources.trigger.\(trigger.id)")
    }

    private var runtimeSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Label("Runtime", systemImage: "server.rack")
                    .font(.headline)
                    .foregroundStyle(Color.companionInk)
                Spacer()
                CompanionStatusBadge(runtime: currentCompanion.runtime)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .accessibilityAddTraits(.isHeader)

            Divider().overlay(Color.companionDivider)

            VStack(alignment: .leading, spacing: 14) {
                Text(runtimeMessage)
                    .font(.footnote)
                    .foregroundStyle(runtimeMessageColor)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("companion.resources.runtime.status")

                if canEdit {
                    Button("Restart Companion", systemImage: "arrow.clockwise") {
                        restartTarget = .pi
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .disabled(runtimeControlsDisabled)
                    .accessibilityHint("Restarts the agent process while keeping the server online")
                    .accessibilityIdentifier("companion.resources.restart.companion")

                    Button("Restart server", systemImage: "server.rack") {
                        restartTarget = .box
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .disabled(runtimeControlsDisabled)
                    .accessibilityHint("Restarts the full Box and interrupts active work")
                    .accessibilityIdentifier("companion.resources.restart.server")
                } else {
                    Text("You have read-only access. An Owner or Editor can restart this Companion.")
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("companion.resources.runtime.read-only")
                }
            }
            .padding(16)
        }
        .companionMaterial(radius: 12)
    }

    private func statusBadge(
        _ status: CompanionConnectedResourceStatus,
        activeLabel: String? = nil
    ) -> some View {
        let label = status == .active ? activeLabel ?? status.label : status.label
        return HStack(spacing: 5) {
            Circle()
                .fill(statusColor(status))
                .frame(width: 7, height: 7)
            Text(label)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(Color.companionInk.opacity(0.80))
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(statusColor(status).opacity(0.10), in: Capsule())
        .accessibilityElement(children: .combine)
    }

    private func statusColor(_ status: CompanionConnectedResourceStatus) -> Color {
        switch status {
        case .active: .companionSuccess
        case .disabled: .companionMuted
        case .error: .companionDanger
        }
    }

    private func emptyRow(title: String, detail: String, identifier: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.companionInk)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(Color.companionMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }

    private var resourceDivider: some View {
        Divider()
            .overlay(Color.companionDivider)
            .padding(.leading, 16)
    }

    private var loadingState: some View {
        ScrollView {
            VStack(spacing: 22) {
                ForEach(0..<3, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Connected resources")
                            .font(.headline)
                        Text("Resource name")
                        Text("Resource details available here")
                            .font(.footnote)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .companionMaterial(radius: 12)
                }
            }
            .padding(16)
            .redacted(reason: .placeholder)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Loading connected resources")
        }
    }

    private func errorState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Resources unavailable", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try again") { Task { await load() } }
                .buttonStyle(.glassProminent)
        }
        .padding(24)
    }

    private var visualTheme: CompanionVisualTheme {
        CompanionVisualTheme(icon: currentCompanion.icon)
    }

    private var canEdit: Bool {
        currentCompanion.access.canEditCompanionSettings
    }

    private var attachedPlugins: [CompanionPluginAccount] {
        let attachedIDs = Set(currentCompanion.selectedMCPAccountIDs)
        return plugins
            .filter { attachedIDs.contains($0.id) }
            .sorted {
                let left = pluginProviderName($0.provider)
                let right = pluginProviderName($1.provider)
                if left != right { return left.localizedCaseInsensitiveCompare(right) == .orderedAscending }
                return $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending
            }
    }

    private var availablePlugins: [CompanionPluginAccount] {
        let attachedIDs = Set(currentCompanion.selectedMCPAccountIDs)
        return plugins
            .filter { $0.connected && !attachedIDs.contains($0.id) }
            .sorted {
                let left = pluginProviderName($0.provider)
                let right = pluginProviderName($1.provider)
                if left != right { return left.localizedCaseInsensitiveCompare(right) == .orderedAscending }
                return $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending
            }
    }

    private var unavailablePluginCount: Int {
        max(0, currentCompanion.selectedMCPAccountIDs.count - attachedPlugins.count)
    }

    private var canManagePlugins: Bool {
        currentCompanion.access == .owner
    }

    private var latestOperation: CompanionOperationSummary? {
        acceptedOperation ?? currentCompanion.runtime.latestOperation
    }

    private var operationActive: Bool {
        latestOperation?.isActive == true
    }

    private var runtimeOnline: Bool {
        currentCompanion.runtime.state == .running
            && currentCompanion.runtime.daemonState == .running
    }

    private var runtimeControlsDisabled: Bool {
        restartingTarget != nil
            || mutatingPluginID != nil
            || operationActive
            || hasUnsavedSettings
            || !runtimeOnline
    }

    private var runtimeMessage: String {
        if let operation = latestOperation {
            let label = operationLabel(operation.kind)
            switch operation.status {
            case .pending:
                return "\(label) is queued. Status refreshes automatically."
            case .running:
                if currentCompanion.runtime.state == .stopping { return "The server is stopping for \(label.lowercased())." }
                if currentCompanion.runtime.state == .provisioning { return "The server is starting after \(label.lowercased())." }
                return "\(label) is in progress."
            case .succeeded:
                return "\(label) completed."
            case .failed, .interrupted, .cancelled:
                return operation.error?.message ?? "\(label) did not complete. Retry when it is safe."
            case .unknown:
                return "Runtime operation status is unavailable."
            }
        }
        if let lastError = currentCompanion.runtime.lastError, !lastError.isEmpty { return lastError }
        if runtimeOnline {
            if hasUnsavedSettings { return "Save your Companion settings before restarting." }
            return "Restart the Companion process for a fresh agent, or restart the full server for Box-level recovery."
        }
        return "This Companion must be Online before it can restart. Send a message to start it."
    }

    private var runtimeMessageColor: Color {
        guard let operation = latestOperation else {
            return currentCompanion.runtime.state == .error ? .companionDanger : .companionMuted
        }
        switch operation.status {
        case .failed, .interrupted, .cancelled: return .companionDanger
        default: return .companionMuted
        }
    }

    private var runtimePollingID: String {
        let operation = latestOperation
        return "\(currentCompanion.id):\(operation?.id ?? "none"):\(operation?.status.rawValue ?? "none"):\(currentCompanion.runtime.state.rawValue)"
    }

    private var needsRuntimePolling: Bool {
        operationActive
            || currentCompanion.runtime.state == .provisioning
            || currentCompanion.runtime.state == .stopping
    }

    private var restartConfirmationTitle: String {
        switch restartTarget {
        case .pi: "Restart \(currentCompanion.name)?"
        case .box: "Restart \(currentCompanion.name)'s server?"
        case nil: "Restart Companion?"
        }
    }

    private func restartConfirmationButton(_ target: CompanionRuntimeRestartTarget) -> String {
        target == .pi ? "Restart Companion" : "Restart server"
    }

    private func operationLabel(_ kind: CompanionOperationKind) -> String {
        switch kind {
        case .restartPi: "Companion restart"
        case .restartBox: "Server restart"
        case .applySettings: "Settings apply"
        case .start: "Start"
        case .stop: "Stop"
        case .delete: "Deletion"
        case .unknown: "Runtime operation"
        }
    }

    private func pluginProviderName(_ provider: String) -> String {
        switch provider.lowercased() {
        case "github": "GitHub"
        case "linear": "Linear"
        case "notion": "Notion"
        case "conductor": "Conductor"
        default: provider.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
        }
    }

    private func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        if resources == nil { loading = true }
        do {
            let next: CompanionConnectedResources
            if let services {
                next = try await services.load()
            } else {
                next = try await sessionStore.connectedResources(for: currentCompanion)
            }
            guard !Task.isCancelled, generation == loadGeneration else { return }
            resources = next
            error = nil
            await loadPlugins(expectedGeneration: generation)
            await refreshRuntime()
        } catch {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            self.error = "Connected resources could not be refreshed. Check your connection and try again."
        }
        if generation == loadGeneration { loading = false }
    }

    private func loadPlugins(expectedGeneration: Int? = nil) async {
        do {
            let next = if let services {
                try await services.listPlugins()
            } else {
                try await sessionStore.listCompanionPlugins()
            }
            guard !Task.isCancelled,
                  expectedGeneration == nil || expectedGeneration == loadGeneration else { return }
            plugins = next
            error = nil
            if availablePlugins.isEmpty, canManagePlugins {
                showingPluginChoices = false
            }
        } catch {
            guard !Task.isCancelled,
                  expectedGeneration == nil || expectedGeneration == loadGeneration else { return }
            self.error = companionDisplayMessage(error, fallback: "Plugin accounts could not be refreshed.")
        }
    }

    private func setPlugin(_ plugin: CompanionPluginAccount, attached: Bool) async {
        guard canManagePlugins, mutatingPluginID == nil else { return }
        mutatingPluginID = plugin.id
        error = nil
        success = nil
        var selection = Set(currentCompanion.selectedMCPAccountIDs)
        if attached { selection.insert(plugin.id) } else { selection.remove(plugin.id) }
        do {
            let updated: CompanionSummary
            if let services {
                updated = try await services.updatePluginSelection(selection.sorted())
            } else {
                updated = try await sessionStore.updateCompanionPluginSelection(
                    companionID: currentCompanion.id,
                    selectedMCPAccountIDs: selection.sorted()
                )
            }
            currentCompanion = updated.preservingListProjection(from: currentCompanion)
            acceptedOperation = updated.runtime.latestOperation
            onCompanionUpdated(currentCompanion)
            success = attached
                ? "\(pluginProviderName(plugin.provider)) · \(plugin.label) attached."
                : "\(pluginProviderName(plugin.provider)) · \(plugin.label) detached."
        } catch {
            self.error = companionDisplayMessage(
                error,
                fallback: attached ? "The plugin could not be attached." : "The plugin could not be detached."
            )
        }
        mutatingPluginID = nil
    }

    private func restart(_ target: CompanionRuntimeRestartTarget) async {
        guard canEdit,
              runtimeOnline,
              !hasUnsavedSettings,
              !operationActive,
              restartingTarget == nil else { return }
        restartingTarget = target
        restartTarget = nil
        error = nil
        success = nil
        let requestID = restartRequestIDs[target] ?? UUID()
        restartRequestIDs[target] = requestID
        do {
            let operation: CompanionOperationSummary
            if let services {
                operation = try await services.restart(target, requestID)
            } else {
                operation = try await sessionStore.restartCompanion(
                    companionID: currentCompanion.id,
                    target: target,
                    requestID: requestID
                )
            }
            restartRequestIDs[target] = nil
            acceptedOperation = operation
            success = target == .pi
                ? "Companion restart accepted. It will run after earlier runtime work."
                : "Server restart accepted. It will run after earlier runtime work."
        } catch {
            if let apiError = error as? APIError, apiError.status == 0 {
                self.error = "The restart response was not received. Retry safely reuses the same request."
            } else {
                self.error = companionDisplayMessage(error, fallback: "This Companion could not be restarted.")
            }
        }
        restartingTarget = nil
    }

    private func pollRuntimeWhileNeeded() async {
        guard needsRuntimePolling else { return }
        while !Task.isCancelled, needsRuntimePolling {
            await refreshRuntime()
            guard !Task.isCancelled, needsRuntimePolling else { return }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    private func refreshRuntime() async {
        do {
            let updated: CompanionSummary
            if let services {
                updated = try await services.loadCompanion()
            } else {
                updated = try await sessionStore.companionRuntime(companionID: currentCompanion.id)
            }
            guard !Task.isCancelled else { return }
            currentCompanion = updated.preservingListProjection(from: currentCompanion)
            acceptedOperation = updated.runtime.latestOperation
        } catch {
            guard !Task.isCancelled else { return }
            self.error = companionDisplayMessage(error, fallback: "Restart status could not be refreshed.")
        }
    }
}

#if DEBUG
struct CompanionConnectedResourcesDemoView: View {
    var body: some View {
        NavigationStack {
            CompanionConnectedResourcesView(
                companion: CompanionConnectedResourcesDemoFixtures.companion,
                services: .init(
                    load: { CompanionConnectedResourcesDemoFixtures.resources },
                    listPlugins: { CompanionConnectedResourcesDemoFixtures.plugins },
                    updatePluginSelection: { _ in CompanionConnectedResourcesDemoFixtures.companion },
                    loadCompanion: { CompanionConnectedResourcesDemoFixtures.companion },
                    restart: { target, _ in CompanionConnectedResourcesDemoFixtures.restartOperation(target) }
                )
            )
        }
    }
}

@MainActor
enum CompanionConnectedResourcesDemoFixtures {
    static var companion: CompanionSummary {
        let selectedSkillIDs = ProcessInfo.processInfo.environment["COMPANION_RESOURCES_DEMO_EMPTY"] == "skills"
            ? "[]"
            : #"["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"]"#
        return decode(#"""
        {
          "id":"c96ab360-00f3-4497-a51a-51442db8add1",
          "name":"Luna",
          "persona":"Keep releases calm",
          "model_id":"claude-sonnet",
          "selected_skill_ids":\#(selectedSkillIDs),
          "selected_mcp_account_ids":["55555555-5555-4555-8555-555555555555"],
          "icon":{"shape":6,"mouth":1,"accessory":6,"color":2},
          "access":"viewer",
          "hidden":false,
          "unread":false,
          "last_message":null,
          "runtime":{"state":"running","daemon_state":"running","replying":false,"last_error":null}
        }
        """#)
    }

    static var resources: CompanionConnectedResources {
        let emptySection = ProcessInfo.processInfo.environment["COMPANION_RESOURCES_DEMO_EMPTY"]
        return CompanionConnectedResources(
            skills: emptySection == "skills" ? [] : [decode(#"""
            {
              "id":"11111111-1111-4111-8111-111111111111",
              "slug":"incident-summary",
              "display":{"name":"Incident Summary"},
              "description":"Summarizes incidents into concise operational updates."
            }
            """#)],
            hiddenSkillCount: emptySection == "skills" ? 0 : 1,
            routines: emptySection == "routines" ? [] : [decode(#"""
            {
              "id":"33333333-3333-4333-8333-333333333333",
              "name":"Weekday brief",
              "cron":"0 9 * * 1-5",
              "timezone":"America/New_York",
              "enabled":true,
              "next_fire_at":"2026-08-27T13:00:00.000Z",
              "last_error_message":null
            }
            """#)],
            triggers: emptySection == "triggers" ? [] : [decode(#"""
            {
              "id":"44444444-4444-4444-8444-444444444444",
              "name":"Pull request opened",
              "provider":"github",
              "registration_status":"registered",
              "enabled":true,
              "last_error_message":null
            }
            """#)]
        )
    }

    static var plugins: [CompanionPluginAccount] {
        [decode(#"{"id":"55555555-5555-4555-8555-555555555555","provider":"linear","label":"work","transport":"http","endpoint":"https://mcp.linear.app","connected":true,"created_at":"2026-08-25T08:00:00.000Z","updated_at":"2026-08-25T08:00:00.000Z"}"#)]
    }

    static func restartOperation(_ target: CompanionRuntimeRestartTarget) -> CompanionOperationSummary {
        decode(#"{"id":"77777777-7777-4777-8777-777777777777","kind":"\#(target == .pi ? "restart_pi" : "restart_box")","status":"pending","error":null}"#)
    }

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        try! JSONDecoder().decode(Value.self, from: Data(json.utf8))
    }
}
#endif
