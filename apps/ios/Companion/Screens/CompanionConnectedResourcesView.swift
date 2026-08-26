import SwiftUI
import CompanionKit
import UIKit

@MainActor
struct CompanionConnectedResourcesServices {
    let load: () async throws -> CompanionConnectedResources
    let listPlugins: () async throws -> [CompanionPluginAccount]
    let updatePluginSelection: ([String]) async throws -> CompanionSummary
    let loadCompanion: () async throws -> CompanionSummary
    let restart: (CompanionRuntimeRestartTarget, UUID) async throws -> CompanionOperationSummary
    let createRoutine: ((CreateCompanionRoutineInput) async throws -> CompanionRoutine)?
    let updateRoutine: ((String, UpdateCompanionRoutineInput) async throws -> CompanionRoutine)?
    let deleteRoutine: ((String) async throws -> Void)?
    let createTrigger: ((CreateCompanionTriggerInput) async throws -> CompanionTrigger)?
    let updateTrigger: ((String, UpdateCompanionTriggerInput) async throws -> CompanionTrigger)?
    let deleteTrigger: ((String) async throws -> Void)?
    let rotateTriggerSecret: ((String) async throws -> CompanionTrigger)?
    let saveMemberTimezone: ((String) async throws -> String)?

    init(
        load: @escaping () async throws -> CompanionConnectedResources,
        listPlugins: @escaping () async throws -> [CompanionPluginAccount],
        updatePluginSelection: @escaping ([String]) async throws -> CompanionSummary,
        loadCompanion: @escaping () async throws -> CompanionSummary,
        restart: @escaping (CompanionRuntimeRestartTarget, UUID) async throws -> CompanionOperationSummary,
        createRoutine: ((CreateCompanionRoutineInput) async throws -> CompanionRoutine)? = nil,
        updateRoutine: ((String, UpdateCompanionRoutineInput) async throws -> CompanionRoutine)? = nil,
        deleteRoutine: ((String) async throws -> Void)? = nil,
        createTrigger: ((CreateCompanionTriggerInput) async throws -> CompanionTrigger)? = nil,
        updateTrigger: ((String, UpdateCompanionTriggerInput) async throws -> CompanionTrigger)? = nil,
        deleteTrigger: ((String) async throws -> Void)? = nil,
        rotateTriggerSecret: ((String) async throws -> CompanionTrigger)? = nil,
        saveMemberTimezone: ((String) async throws -> String)? = nil
    ) {
        self.load = load
        self.listPlugins = listPlugins
        self.updatePluginSelection = updatePluginSelection
        self.loadCompanion = loadCompanion
        self.restart = restart
        self.createRoutine = createRoutine
        self.updateRoutine = updateRoutine
        self.deleteRoutine = deleteRoutine
        self.createTrigger = createTrigger
        self.updateTrigger = updateTrigger
        self.deleteTrigger = deleteTrigger
        self.rotateTriggerSecret = rotateTriggerSecret
        self.saveMemberTimezone = saveMemberTimezone
    }
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
    @State private var resourceActionError: String?
    @State private var busyResourceID: String?
    @State private var routineToDelete: CompanionRoutine?
    @State private var triggerToDelete: CompanionTrigger?
    @State private var editingRoutine: CompanionRoutine?
    @State private var editingTrigger: CompanionTrigger?
    @State private var showingNewRoutine = false
    @State private var showingNewTrigger = false
    @State private var confirmingRotateTriggerID: String?

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
        CompanionBackdrop {
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
        .confirmationDialog(
            "Delete this routine?",
            isPresented: Binding(
                get: { routineToDelete != nil },
                set: { if !$0 { routineToDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: routineToDelete
        ) { routine in
            Button("Delete \(routine.name)", role: .destructive) {
                Task { await deleteRoutine(routine) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("This removes the scheduled prompt from the Companion.")
        }
        .confirmationDialog(
            "Delete this trigger?",
            isPresented: Binding(
                get: { triggerToDelete != nil },
                set: { if !$0 { triggerToDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: triggerToDelete
        ) { trigger in
            Button("Delete \(trigger.name)", role: .destructive) {
                Task { await deleteTrigger(trigger) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Existing webhook requests will stop being accepted.")
        }
        .sheet(isPresented: $showingNewRoutine) {
            CompanionRoutineEditorView(
                memberTimezone: effectiveMemberTimezone,
                memberTimezoneWasUnset: sessionStore.memberTimezone == nil,
                saveMemberTimezone: { try await saveMemberTimezone($0) },
                create: { try await createRoutine($0) },
                update: { id, input in try await updateRoutine(id: id, input: input) }
            ) {
                showingNewRoutine = false
                Task { await load() }
            }
            .tint(visualTheme.accent)
        }
        .sheet(item: $editingRoutine) { routine in
            CompanionRoutineEditorView(
                initial: routine,
                memberTimezone: effectiveMemberTimezone,
                memberTimezoneWasUnset: false,
                saveMemberTimezone: { try await saveMemberTimezone($0) },
                create: { try await createRoutine($0) },
                update: { id, input in try await updateRoutine(id: id, input: input) }
            ) {
                editingRoutine = nil
                Task { await load() }
            }
            .tint(visualTheme.accent)
        }
        .sheet(isPresented: $showingNewTrigger) {
            CompanionTriggerEditorView(
                create: { try await createTrigger($0) },
                update: { id, input in try await updateTrigger(id: id, input: input) }
            ) {
                showingNewTrigger = false
                Task { await load() }
            }
            .tint(visualTheme.accent)
        }
        .sheet(item: $editingTrigger) { trigger in
            CompanionTriggerEditorView(
                initial: trigger,
                create: { try await createTrigger($0) },
                update: { id, input in try await updateTrigger(id: id, input: input) }
            ) {
                editingTrigger = nil
                Task { await load() }
            }
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
                if let resourceActionError {
                    CompanionErrorNotice(message: resourceActionError)
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
                Text("Times shown in \(effectiveMemberTimezone).")
                    .font(.caption)
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
                if canEditResources, title == "Routines" {
                    Button {
                        showingNewRoutine = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.body.weight(.semibold))
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Add a routine")
                    .accessibilityIdentifier("companion.resources.routines.add")
                } else if canEditResources, title == "Triggers" {
                    Button {
                        showingNewTrigger = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.body.weight(.semibold))
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Add a trigger")
                    .accessibilityIdentifier("companion.resources.triggers.add")
                }
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
                if let nextFire = MemberTimezone.formatInstant(
                    routine.nextFireAt,
                    in: effectiveMemberTimezone
                ) {
                    Text("Next \(nextFire) · \(effectiveMemberTimezone)")
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                }
                if let lastFire = MemberTimezone.formatInstant(
                    routine.lastFiredAt,
                    in: effectiveMemberTimezone
                ) {
                    Text("Last fired \(lastFire) · \(effectiveMemberTimezone)")
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                }
                if let message = routine.lastErrorMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(Color.companionDanger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            statusBadge(routine.status)
            if canEditResources {
                if busyResourceID == routine.id {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Updating routine \(routine.name)")
                } else {
                    Menu {
                        Button(routine.enabled ? "Turn off" : "Turn on") {
                            Task { await toggleRoutine(routine) }
                        }
                        Button("Edit", systemImage: "pencil") {
                            editingRoutine = routine
                        }
                        Button("Delete", systemImage: "trash", role: .destructive) {
                            routineToDelete = routine
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.body.weight(.semibold))
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Actions for routine \(routine.name)")
                    .accessibilityIdentifier("companion.resources.routine-actions.\(routine.id)")
                }
            }
        }
        .padding(16)
        .accessibilityElement(children: canEditResources ? .contain : .combine)
        .accessibilityLabel(
            routineAccessibilityLabel(routine)
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
                if let lastFire = MemberTimezone.formatInstant(
                    trigger.lastFiredAt,
                    in: effectiveMemberTimezone
                ) {
                    Text("Last fired \(lastFire) · \(effectiveMemberTimezone)")
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                }
                if let message = trigger.lastErrorMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(Color.companionDanger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            statusBadge(trigger.status)
            if canEditResources, trigger.webhookURL != nil {
                Button {
                    copyWebhookURL(trigger)
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.body.weight(.semibold))
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Copy webhook URL for \(trigger.name)")
                .accessibilityIdentifier("companion.resources.trigger-copy.\(trigger.id)")
            }
            if canEditResources {
                if busyResourceID == trigger.id {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Updating trigger \(trigger.name)")
                } else {
                    Menu {
                        Button(trigger.enabled ? "Turn off" : "Turn on") {
                            Task { await toggleTrigger(trigger) }
                        }
                        Button("Edit", systemImage: "pencil") {
                            editingTrigger = trigger
                        }
                        if trigger.webhookURL != nil {
                            Button("Copy webhook URL", systemImage: "doc.on.doc") {
                                copyWebhookURL(trigger)
                            }
                            Button(
                                confirmingRotateTriggerID == trigger.id ? "Confirm rotate secret" : "Rotate secret",
                                systemImage: "arrow.triangle.2.circlepath"
                            ) {
                                if confirmingRotateTriggerID == trigger.id {
                                    Task { await rotateTriggerSecret(trigger) }
                                } else {
                                    confirmingRotateTriggerID = trigger.id
                                }
                            }
                        }
                        Button("Delete", systemImage: "trash", role: .destructive) {
                            triggerToDelete = trigger
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.body.weight(.semibold))
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Actions for trigger \(trigger.name)")
                    .accessibilityIdentifier("companion.resources.trigger-actions.\(trigger.id)")
                }
            }
        }
        .padding(16)
        .accessibilityElement(children: canEditResources ? .contain : .combine)
        .accessibilityLabel(
            triggerAccessibilityLabel(trigger)
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

    private func routineAccessibilityLabel(_ routine: CompanionRoutine) -> String {
        var parts = [routine.name, routine.scheduleDescription, routine.timezone]
        if let next = MemberTimezone.formatInstant(routine.nextFireAt, in: effectiveMemberTimezone) {
            parts.append("Next \(next) in \(effectiveMemberTimezone)")
        }
        if let last = MemberTimezone.formatInstant(routine.lastFiredAt, in: effectiveMemberTimezone) {
            parts.append("Last fired \(last) in \(effectiveMemberTimezone)")
        }
        parts.append(routine.status.label)
        return parts.joined(separator: ". ")
    }

    private func triggerAccessibilityLabel(_ trigger: CompanionTrigger) -> String {
        var parts = [trigger.name, trigger.providerName, trigger.registrationDescription]
        if let last = MemberTimezone.formatInstant(trigger.lastFiredAt, in: effectiveMemberTimezone) {
            parts.append("Last fired \(last) in \(effectiveMemberTimezone)")
        }
        parts.append(trigger.status.label)
        return parts.joined(separator: ". ")
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

    private var canEditResources: Bool {
        currentCompanion.access.canEditCompanionSettings
    }

    private var effectiveMemberTimezone: String {
        sessionStore.memberTimezone ?? MemberTimezone.deviceIdentifier
    }

    private func saveMemberTimezone(_ identifier: String) async throws -> String {
        if let save = services?.saveMemberTimezone {
            return try await save(identifier)
        }
        let profile = try await sessionStore.updateUserProfile(timezone: identifier)
        return profile.timezone ?? identifier
    }

    private func createRoutine(_ input: CreateCompanionRoutineInput) async throws -> CompanionRoutine {
        guard canEditResources else { throw APIError(status: 403, code: "forbidden", message: "You cannot edit this Companion.") }
        if let create = services?.createRoutine { return try await create(input) }
        return try await sessionStore.createCompanionRoutine(companionID: companion.id, input: input)
    }

    private func updateRoutine(
        id: String,
        input: UpdateCompanionRoutineInput
    ) async throws -> CompanionRoutine {
        guard canEditResources else { throw APIError(status: 403, code: "forbidden", message: "You cannot edit this Companion.") }
        if let update = services?.updateRoutine { return try await update(id, input) }
        return try await sessionStore.updateCompanionRoutine(
            companionID: companion.id,
            routineID: id,
            input: input
        )
    }

    private func deleteRoutine(_ routine: CompanionRoutine) async {
        guard canEditResources, busyResourceID == nil else { return }
        busyResourceID = routine.id
        resourceActionError = nil
        routineToDelete = nil
        do {
            if let delete = services?.deleteRoutine {
                try await delete(routine.id)
            } else {
                try await sessionStore.deleteCompanionRoutine(companionID: companion.id, routineID: routine.id)
            }
            await load()
        } catch {
            resourceActionError = companionDisplayMessage(error, fallback: "The routine could not be deleted.")
        }
        busyResourceID = nil
    }

    private func toggleRoutine(_ routine: CompanionRoutine) async {
        guard canEditResources, busyResourceID == nil else { return }
        busyResourceID = routine.id
        resourceActionError = nil
        do {
            _ = try await updateRoutine(
                id: routine.id,
                input: UpdateCompanionRoutineInput(enabled: !routine.enabled)
            )
            await load()
        } catch {
            resourceActionError = companionDisplayMessage(error, fallback: "The routine could not be updated.")
        }
        busyResourceID = nil
    }

    private func createTrigger(_ input: CreateCompanionTriggerInput) async throws -> CompanionTrigger {
        guard canEditResources else { throw APIError(status: 403, code: "forbidden", message: "You cannot edit this Companion.") }
        if let create = services?.createTrigger { return try await create(input) }
        return try await sessionStore.createCompanionTrigger(companionID: companion.id, input: input)
    }

    private func updateTrigger(
        id: String,
        input: UpdateCompanionTriggerInput
    ) async throws -> CompanionTrigger {
        guard canEditResources else { throw APIError(status: 403, code: "forbidden", message: "You cannot edit this Companion.") }
        if let update = services?.updateTrigger { return try await update(id, input) }
        return try await sessionStore.updateCompanionTrigger(
            companionID: companion.id,
            triggerID: id,
            input: input
        )
    }

    private func deleteTrigger(_ trigger: CompanionTrigger) async {
        guard canEditResources, busyResourceID == nil else { return }
        busyResourceID = trigger.id
        resourceActionError = nil
        triggerToDelete = nil
        do {
            if let delete = services?.deleteTrigger {
                try await delete(trigger.id)
            } else {
                try await sessionStore.deleteCompanionTrigger(companionID: companion.id, triggerID: trigger.id)
            }
            await load()
        } catch {
            resourceActionError = companionDisplayMessage(error, fallback: "The trigger could not be deleted.")
        }
        busyResourceID = nil
    }

    private func toggleTrigger(_ trigger: CompanionTrigger) async {
        guard canEditResources, busyResourceID == nil else { return }
        busyResourceID = trigger.id
        resourceActionError = nil
        do {
            _ = try await updateTrigger(
                id: trigger.id,
                input: UpdateCompanionTriggerInput(enabled: !trigger.enabled)
            )
            await load()
        } catch {
            resourceActionError = companionDisplayMessage(error, fallback: "The trigger could not be updated.")
        }
        busyResourceID = nil
    }

    private func copyWebhookURL(_ trigger: CompanionTrigger) {
        guard canEditResources, let webhookURL = trigger.webhookURL else { return }
        UIPasteboard.general.string = webhookURL
        resourceActionError = nil
    }

    private func rotateTriggerSecret(_ trigger: CompanionTrigger) async {
        guard canEditResources, busyResourceID == nil else { return }
        busyResourceID = trigger.id
        resourceActionError = nil
        confirmingRotateTriggerID = nil
        do {
            if let rotate = services?.rotateTriggerSecret {
                _ = try await rotate(trigger.id)
            } else {
                _ = try await sessionStore.rotateCompanionTriggerSecret(
                    companionID: companion.id,
                    triggerID: trigger.id
                )
            }
            await load()
        } catch {
            resourceActionError = companionDisplayMessage(error, fallback: "The webhook secret could not be rotated.")
        }
        busyResourceID = nil
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
              "prompt":"Summarize the pull request.",
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
