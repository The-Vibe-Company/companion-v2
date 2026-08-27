import SwiftUI
import CompanionKit

@MainActor
struct CompanionSettingsServices {
    let listProviders: () async throws -> CompanionProvidersResponse
    let updateCompanion: (String, UpdateCompanionInput) async throws -> CompanionSummary
    let deleteCompanion: (String, UUID) async throws -> CompanionOperationSummary
    let connectedResources: () async throws -> CompanionConnectedResources
    let listPlugins: () async throws -> [CompanionPluginAccount]
    let updatePluginSelection: ([String]) async throws -> CompanionSummary
    let loadCompanion: () async throws -> CompanionSummary
    let restart: (CompanionRuntimeRestartTarget, UUID) async throws -> CompanionOperationSummary
    let listRoutines: (() async throws -> [CompanionRoutine])?
    let createRoutine: ((CreateCompanionRoutineInput) async throws -> CompanionRoutine)?
    let updateRoutine: ((String, UpdateCompanionRoutineInput) async throws -> CompanionRoutine)?
    let listRoutineRuns: ((String, String?) async throws -> CompanionRoutineRunList)?
    let routineRun: ((String, Int?) async throws -> CompanionRoutineRunDetail)?

    init(
        listProviders: @escaping () async throws -> CompanionProvidersResponse,
        updateCompanion: @escaping (String, UpdateCompanionInput) async throws -> CompanionSummary,
        deleteCompanion: @escaping (String, UUID) async throws -> CompanionOperationSummary,
        connectedResources: @escaping () async throws -> CompanionConnectedResources,
        listPlugins: @escaping () async throws -> [CompanionPluginAccount],
        updatePluginSelection: @escaping ([String]) async throws -> CompanionSummary,
        loadCompanion: @escaping () async throws -> CompanionSummary,
        restart: @escaping (CompanionRuntimeRestartTarget, UUID) async throws -> CompanionOperationSummary,
        listRoutines: (() async throws -> [CompanionRoutine])? = nil,
        createRoutine: ((CreateCompanionRoutineInput) async throws -> CompanionRoutine)? = nil,
        updateRoutine: ((String, UpdateCompanionRoutineInput) async throws -> CompanionRoutine)? = nil,
        listRoutineRuns: ((String, String?) async throws -> CompanionRoutineRunList)? = nil,
        routineRun: ((String, Int?) async throws -> CompanionRoutineRunDetail)? = nil
    ) {
        self.listProviders = listProviders
        self.updateCompanion = updateCompanion
        self.deleteCompanion = deleteCompanion
        self.connectedResources = connectedResources
        self.listPlugins = listPlugins
        self.updatePluginSelection = updatePluginSelection
        self.loadCompanion = loadCompanion
        self.restart = restart
        self.listRoutines = listRoutines
        self.createRoutine = createRoutine
        self.updateRoutine = updateRoutine
        self.listRoutineRuns = listRoutineRuns
        self.routineRun = routineRun
    }
}

private struct LegacyCompanionSettingsView: View {
    @Environment(SessionStore.self) private var sessionStore

    let companion: CompanionSummary
    let onSaved: (CompanionSummary) -> Void
    let onDeletionStarted: (CompanionSummary, UUID) -> Void
    let onDeletionAccepted: (String, CompanionOperationSummary) -> Void
    let onDeletionFailed: (CompanionSummary, UUID, Error) -> Void
    private let services: CompanionSettingsServices?

    @State private var currentCompanion: CompanionSummary
    @State private var providers: CompanionProvidersResponse?
    @State private var providerID: String
    @State private var modelID: String
    @State private var loadingProviders = true
    @State private var saving = false
    @State private var deleting = false
    @State private var error: String?
    @State private var success: String?
    @State private var confirmingDelete = false
    @State private var showingProviders = false
    @State private var deleteRequestID: UUID?

    init(
        companion: CompanionSummary,
        onSaved: @escaping (CompanionSummary) -> Void,
        onDeletionStarted: @escaping (CompanionSummary, UUID) -> Void = { _, _ in },
        onDeletionAccepted: @escaping (String, CompanionOperationSummary) -> Void,
        onDeletionFailed: @escaping (CompanionSummary, UUID, Error) -> Void = { _, _, _ in },
        services: CompanionSettingsServices? = nil
    ) {
        self.companion = companion
        self.onSaved = onSaved
        self.onDeletionStarted = onDeletionStarted
        self.onDeletionAccepted = onDeletionAccepted
        self.onDeletionFailed = onDeletionFailed
        self.services = services
        _currentCompanion = State(initialValue: companion)
        _providerID = State(initialValue: companion.runtime.providerIDs.first ?? "")
        _modelID = State(initialValue: companion.modelID ?? "")
    }

    var body: some View {
        CompanionBackdrop {
            Form {
                if let error {
                    Section { CompanionErrorNotice(message: error) }
                }
                if let success {
                    Section { CompanionSuccessNotice(message: success) }
                }

                identitySection
                intelligenceSection
                resourcesSection

                if canDelete {
                    deleteSection
                }
            }
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("Companion settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if canEdit {
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") {
                        Task { await save() }
                    }
                    .disabled(!canSave)
                    .accessibilityIdentifier("companion.settings.save")
                }
            }
        }
        .confirmationDialog(
            "Delete \(currentCompanion.name)?",
            isPresented: $confirmingDelete,
            titleVisibility: .visible
        ) {
            Button("Delete Companion", role: .destructive) {
                Task { await deleteCompanion() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its Box, thread, and Companion record will be permanently deleted. This cannot be undone.")
        }
        .sheet(isPresented: $showingProviders, onDismiss: { Task { await loadProviders() } }) {
            ProviderManagementView()
        }
        .task(id: companion.id) { await loadProviders() }
        .onChange(of: providerID) { selectDefaultModel() }
        .onChange(of: companion) { _, updated in syncServerProjection(updated) }
    }

    private var resourcesSection: some View {
        Section {
            NavigationLink {
                CompanionConnectedResourcesView(
                    companion: currentCompanion,
                    hasUnsavedSettings: changed,
                    onCompanionUpdated: resourceCompanionUpdated,
                    services: services.map { services in
                        CompanionConnectedResourcesServices(
                            load: services.connectedResources,
                            listPlugins: services.listPlugins,
                            updatePluginSelection: services.updatePluginSelection,
                            loadCompanion: services.loadCompanion,
                            restart: services.restart
                        )
                    }
                )
            } label: {
                Label {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Connected resources")
                        Text("Skills, plugins, routines, triggers, and runtime controls")
                            .font(.caption)
                            .foregroundStyle(Color.companionMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } icon: {
                    Image(systemName: "link")
                }
                .frame(minHeight: 44)
            }
            .accessibilityIdentifier("companion.settings.resources")
        } header: {
            Text("Resources")
        } footer: {
            Text("Plugin changes apply between turns. Detaching an account from this Companion does not disconnect it from Plugins.")
        }
    }

    private var identitySection: some View {
        Section {
            HStack(spacing: 14) {
                CompanionAvatar(
                    name: currentCompanion.name,
                    icon: currentCompanion.icon,
                    size: 64,
                    state: .still
                )
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 4) {
                    Text(currentCompanion.name)
                        .font(.headline)
                        .accessibilityIdentifier("companion.settings.identity.name")
                    Text(currentCompanion.persona ?? "No instructions")
                        .font(.subheadline)
                        .foregroundStyle(Color.companionMuted)
                        .lineLimit(3)
                }

                Spacer(minLength: 0)
            }
            .frame(minHeight: 70)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(currentCompanion.name). \(currentCompanion.persona ?? "No instructions")")
            .accessibilityIdentifier("companion.settings.identity.summary")

            if canEdit {
                NavigationLink {
                    CompanionIdentityEditorView(
                        companion: currentCompanion,
                        onSaved: identitySaved,
                        updateCompanion: services?.updateCompanion
                    )
                } label: {
                    Label("Edit", systemImage: "pencil")
                        .frame(minHeight: 44)
                }
                .disabled(busy)
                .accessibilityLabel("Edit identity")
                .accessibilityIdentifier("companion.settings.identity.edit")
            }
        } header: {
            Text("Identity")
        } footer: {
            if !canEdit {
                Text("You have read-only access to this Companion.")
            }
        }
    }

    @ViewBuilder
    private var intelligenceSection: some View {
        Section {
            if loadingProviders && providers == nil {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Loading model providers…")
                        .foregroundStyle(Color.companionMuted)
                }
            } else if connectedProviders.isEmpty {
                Text("No connected model provider is available.")
                    .foregroundStyle(Color.companionMuted)
                if canEdit && providers?.canManage == true {
                    Button("Open providers", systemImage: "cpu") { showingProviders = true }
                }
                Button("Try again", systemImage: "arrow.clockwise") {
                    Task { await loadProviders() }
                }
            } else {
                Picker("Model provider", selection: $providerID) {
                    ForEach(connectedProviders) { provider in
                        Text(provider.name).tag(provider.id)
                    }
                }
                .disabled(!canEdit || busy)
                .accessibilityIdentifier("companion.settings.provider")

                if let selectedProvider {
                    Picker("Model", selection: $modelID) {
                        ForEach(selectedProvider.models) { model in
                            Text(model.name).tag(model.id)
                        }
                    }
                    .disabled(!canEdit || busy)
                    .accessibilityIdentifier("companion.settings.model")
                }

                if canEdit && providers?.canManage == true {
                    Button("Manage providers", systemImage: "slider.horizontal.3") {
                        showingProviders = true
                    }
                }
            }
        } header: {
            Text("Intelligence")
        } footer: {
            Text("Provider and model changes are applied in order between turns. Saving never wakes an asleep Box.")
        }
    }

    private var deleteSection: some View {
        Section {
            Button(deleteLabel, systemImage: "trash", role: .destructive) {
                confirmingDelete = true
            }
            .disabled(busy || deletionActive)
            .accessibilityIdentifier("companion.settings.delete")

            if let message = currentCompanion.deletionOperation?.error?.message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(Color.companionDanger)
            }
        } header: {
            Text("Delete Companion")
        } footer: {
            Text("Permanently deletes its Box and transcript. This cannot be undone.")
        }
    }

    private var canEdit: Bool {
        currentCompanion.access.canEditCompanionSettings
    }

    private var canDelete: Bool {
        currentCompanion.access.canDeleteCompanion
    }

    private var busy: Bool {
        saving || deleting || deletionActive
    }

    private var deletionActive: Bool {
        currentCompanion.deletionOperation?.isActive == true
    }

    private var connectedProviders: [CompanionProviderDefinition] {
        providers?.connectedDefinitions ?? []
    }

    private var selectedProvider: CompanionProviderDefinition? {
        connectedProviders.first(where: { $0.id == providerID })
    }

    private var changed: Bool {
        providerID != currentCompanion.runtime.providerIDs.first
            || modelID != currentCompanion.modelID
    }

    private var canSave: Bool {
        canEdit
            && !busy
            && changed
            && selectedProvider?.models.contains(where: { $0.id == modelID }) == true
    }

    private var deleteLabel: String {
        if deleting { return "Deleting…" }
        if deleteRequestID != nil { return "Retry Delete" }
        guard let operation = currentCompanion.deletionOperation else { return "Delete Companion" }
        if operation.isActive { return "Deletion requested" }
        if operation.status == .failed || operation.status == .interrupted || operation.status == .cancelled {
            return "Retry Delete"
        }
        return "Delete Companion"
    }

    private func loadProviders() async {
        loadingProviders = true
        do {
            let response: CompanionProvidersResponse
            if let services {
                response = try await services.listProviders()
            } else {
                response = try await sessionStore.listCompanionProviders()
            }
            providers = response
            if providerID.isEmpty {
                providerID = response.connectedDefinitions.first?.id ?? ""
            }
            selectDefaultModel()
            error = nil
        } catch {
            self.error = companionDisplayMessage(
                error,
                fallback: "Model providers are temporarily unavailable."
            )
        }
        loadingProviders = false
    }

    private func selectDefaultModel() {
        guard let selectedProvider else {
            modelID = ""
            return
        }
        if !selectedProvider.models.contains(where: { $0.id == modelID }) {
            modelID = selectedProvider.defaultModelID ?? ""
        }
    }

    private func save() async {
        guard canSave else { return }
        saving = true
        error = nil
        success = nil
        let input = UpdateCompanionInput(
            name: currentCompanion.name,
            persona: currentCompanion.persona,
            providerID: providerID,
            modelID: modelID,
            icon: currentCompanion.icon ?? .init(shape: 1, mouth: 1, accessory: 1, color: 2)
        )
        do {
            let response: CompanionSummary
            if let services {
                response = try await services.updateCompanion(currentCompanion.id, input)
            } else {
                response = try await sessionStore.updateCompanion(
                    companionID: currentCompanion.id,
                    input: input
                )
            }
            let updated = response.preservingListProjection(from: currentCompanion)
            currentCompanion = updated
            providerID = updated.runtime.providerIDs.first ?? providerID
            modelID = updated.modelID ?? modelID
            success = "Settings saved."
            onSaved(updated)
        } catch {
            self.error = companionDisplayMessage(
                error,
                fallback: "Companion settings could not be saved."
            )
        }
        saving = false
    }

    private func deleteCompanion() async {
        guard canDelete, !deleting else { return }
        deleting = true
        error = nil
        success = nil
        let requestID = deleteRequestID ?? UUID()
        deleteRequestID = requestID
        onDeletionStarted(currentCompanion, requestID)
        do {
            let operation: CompanionOperationSummary
            if let services {
                operation = try await services.deleteCompanion(currentCompanion.id, requestID)
            } else {
                operation = try await sessionStore.deleteCompanion(
                    companionID: currentCompanion.id,
                    requestID: requestID
                )
            }
            deleteRequestID = nil
            onDeletionAccepted(currentCompanion.id, operation)
        } catch {
            onDeletionFailed(currentCompanion, requestID, error)
            if let apiError = error as? APIError, apiError.status == 0 {
                self.error = "The deletion response was not received. Retry Delete safely reuses the same request."
            } else {
                self.error = companionDisplayMessage(
                    error,
                    fallback: "This Companion could not be deleted."
                )
            }
        }
        deleting = false
    }

    private func syncServerProjection(_ updated: CompanionSummary) {
        currentCompanion = updated.preservingListProjection(from: currentCompanion)
        if updated.deletionOperation != nil { deleteRequestID = nil }
    }

    private func resourceCompanionUpdated(_ updated: CompanionSummary) {
        currentCompanion = updated.preservingListProjection(from: currentCompanion)
        onSaved(currentCompanion)
    }

    private func identitySaved(_ updated: CompanionSummary) {
        currentCompanion = updated.preservingListProjection(from: currentCompanion)
        success = "Identity saved."
        error = nil
        onSaved(currentCompanion)
    }
}

#if DEBUG
struct CompanionSettingsDemoView: View {
    @State private var companion: CompanionSummary
    @State private var showingSettings = false
    @State private var deletionRequested = false

    private let access: CompanionAccess
    private let transcriptionAvailable: Bool

    init() {
        let rawAccess = ProcessInfo.processInfo.environment["COMPANION_SETTINGS_DEMO_ACCESS"] ?? "owner"
        let access = CompanionAccess(rawValue: rawAccess) ?? .viewer
        self.access = access
        transcriptionAvailable = ProcessInfo.processInfo.environment[
            "COMPANION_SETTINGS_DEMO_TRANSCRIPTION_AVAILABLE"
        ] == "true"
        _companion = State(initialValue: CompanionSettingsDemoFixtures.companion(access: access))
    }

    var body: some View {
        NavigationStack {
            if deletionRequested {
                ContentUnavailableView(
                    "Deletion requested",
                    systemImage: "trash.circle",
                    description: Text("The Companion will remain visible until its Box is permanently deleted.")
                )
            } else {
                ChatView(
                    companion: companion,
                    services: CompanionSettingsDemoFixtures.chatServices(
                        access: access,
                        transcriptionAvailable: transcriptionAvailable
                    )
                ) {
                    showingSettings = true
                }
                .navigationDestination(isPresented: $showingSettings) {
                    CompanionSettingsView(
                        companion: companion,
                        onSaved: { companion = $0 },
                        onDeletionStarted: { _, _ in
                            deletionRequested = true
                            showingSettings = false
                        },
                        onDeletionAccepted: { _, operation in
                            deletionRequested = operation.isActive
                            showingSettings = !operation.isActive
                        },
                        services: CompanionSettingsDemoFixtures.services(access: access)
                    )
                }
            }
        }
    }
}

@MainActor
private enum CompanionSettingsDemoFixtures {
    static func companion(access: CompanionAccess) -> CompanionSummary {
        decode(#"""
        {
          "id":"c96ab360-00f3-4497-a51a-51442db8add1",
          "name":"Luna",
          "persona":"Keep releases calm",
          "model_id":"claude-sonnet",
          "selected_skill_ids":["11111111-1111-4111-8111-111111111111"],
          "selected_mcp_account_ids":["55555555-5555-4555-8555-555555555555"],
          "icon":{"shape":6,"mouth":1,"accessory":6,"color":2},
          "access":"\#(access.rawValue)",
          "hidden":false,
          "unread":false,
          "last_message":{"preview":"Release notes are ready.","role":"assistant","created_at":"2026-08-25T08:00:00.000Z"},
          "runtime":{"state":"running","daemon_state":"running","replying":false,"last_error":null,"provider_ids":["anthropic"],"latest_operation":null}
        }
        """#)
    }

    static func services(access: CompanionAccess) -> CompanionSettingsServices {
        CompanionSettingsServices(
            listProviders: { providers },
            updateCompanion: { _, input in updatedCompanion(input: input, access: access) },
            deleteCompanion: { _, _ in deleteOperation },
            connectedResources: { CompanionConnectedResourcesDemoFixtures.resources },
            listPlugins: { plugins },
            updatePluginSelection: { selectedIDs in
                companion(access: access, selectedMCPAccountIDs: selectedIDs)
            },
            loadCompanion: { companion(access: access) },
            restart: { target, _ in restartOperation(target) }
        )
    }

    private static let plugins: [CompanionPluginAccount] = [
        decode(#"{"id":"55555555-5555-4555-8555-555555555555","provider":"linear","label":"work","transport":"http","endpoint":"https://mcp.linear.app","connected":true,"created_at":"2026-08-25T08:00:00.000Z","updated_at":"2026-08-25T08:00:00.000Z"}"#),
        decode(#"{"id":"66666666-6666-4666-8666-666666666666","provider":"github","label":"personal","transport":"http","endpoint":"https://api.githubcopilot.com/mcp","connected":true,"created_at":"2026-08-25T08:00:00.000Z","updated_at":"2026-08-25T08:00:00.000Z"}"#),
    ]

    static func chatServices(
        access: CompanionAccess,
        transcriptionAvailable: Bool
    ) -> ChatServices {
        let currentCompanion = companion(access: access)
        let currentThread: CompanionThread = decode(#"""
        {
          "companion_id":"c96ab360-00f3-4497-a51a-51442db8add1",
          "viewer_id":"user-1",
          "read_only":\#(access == .viewer ? "true" : "false"),
          "can_send":\#(access == .viewer ? "false" : "true"),
          "transcription_available":\#(transcriptionAvailable ? "true" : "false"),
          "entries":[],
          "queued_count":0,
          "interrupted_turn":null
        }
        """#)
        return ChatServices(
            thread: { _ in currentThread },
            listCompanions: { [currentCompanion] },
            decide: { _, _, _ in currentThread },
            retryTurn: { _, _, _ in deleteOperation },
            cancelTurn: { _, _ in currentThread },
            listSkills: { [] },
            listPlugins: { [] },
            listProviders: { providers }
        )
    }

    private static var providers: CompanionProvidersResponse {
        decode(#"""
        {
          "catalog":[{
            "id":"anthropic",
            "name":"Claude",
            "auth_methods":["api_key"],
            "description":"Claude models",
            "models":[{"id":"claude-sonnet","name":"Sonnet","default":true}]
          }],
          "connections":[{
            "provider_id":"anthropic",
            "auth_method":"api_key",
            "connected_by":"user-1",
            "created_at":"2026-08-25T08:00:00.000Z",
            "updated_at":"2026-08-25T08:00:00.000Z"
          }],
          "default_provider_id":"anthropic",
          "can_manage":true
        }
        """#)
    }

    private static var deleteOperation: CompanionOperationSummary {
        decode(#"""
        {
          "id":"14757274-8d64-455c-a394-334665a258f0",
          "kind":"delete",
          "status":"pending",
          "error":null
        }
        """#)
    }

    private static func restartOperation(
        _ target: CompanionRuntimeRestartTarget
    ) -> CompanionOperationSummary {
        decode(#"{"id":"77777777-7777-4777-8777-777777777777","kind":"\#(target == .pi ? "restart_pi" : "restart_box")","status":"pending","error":null}"#)
    }

    private static func companion(
        access: CompanionAccess,
        selectedMCPAccountIDs: [String]
    ) -> CompanionSummary {
        let object: [String: Any] = [
            "id": "c96ab360-00f3-4497-a51a-51442db8add1",
            "name": "Luna",
            "persona": "Keep releases calm",
            "model_id": "claude-sonnet",
            "selected_skill_ids": ["11111111-1111-4111-8111-111111111111"],
            "selected_mcp_account_ids": selectedMCPAccountIDs,
            "icon": ["shape": 6, "mouth": 1, "accessory": 6, "color": 2],
            "access": access.rawValue,
            "hidden": false,
            "unread": false,
            "last_message": NSNull(),
            "runtime": [
                "state": "running",
                "daemon_state": "running",
                "replying": false,
                "last_error": NSNull(),
                "provider_ids": ["anthropic"],
                "latest_operation": NSNull(),
            ],
        ]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(CompanionSummary.self, from: data)
    }

    private static func updatedCompanion(
        input: UpdateCompanionInput,
        access: CompanionAccess
    ) -> CompanionSummary {
        let object: [String: Any] = [
            "id": "c96ab360-00f3-4497-a51a-51442db8add1",
            "name": input.name,
            "persona": input.persona.map { $0 as Any } ?? NSNull(),
            "model_id": input.modelID,
            "selected_skill_ids": ["11111111-1111-4111-8111-111111111111"],
            "selected_mcp_account_ids": ["55555555-5555-4555-8555-555555555555"],
            "icon": [
                "shape": input.icon.shape,
                "mouth": input.icon.mouth,
                "accessory": input.icon.accessory,
                "color": input.icon.color,
            ],
            "access": access.rawValue,
            "hidden": false,
            "unread": false,
            "last_message": NSNull(),
            "runtime": [
                "state": "running",
                "daemon_state": "running",
                "replying": false,
                "last_error": NSNull(),
                "provider_ids": [input.providerID],
                "latest_operation": NSNull(),
            ],
        ]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(CompanionSummary.self, from: data)
    }

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        try! JSONDecoder().decode(Value.self, from: Data(json.utf8))
    }
}
#endif
