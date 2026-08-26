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
}

struct CompanionSettingsView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let companion: CompanionSummary
    let onSaved: (CompanionSummary) -> Void
    let onDeletionAccepted: (String, CompanionOperationSummary) -> Void
    let onDeletionAmbiguous: (String, UUID) -> Void
    private let services: CompanionSettingsServices?

    @State private var currentCompanion: CompanionSummary
    @State private var name: String
    @State private var instructions: String
    @State private var icon: CompanionSummary.Icon
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
        onDeletionAccepted: @escaping (String, CompanionOperationSummary) -> Void,
        onDeletionAmbiguous: @escaping (String, UUID) -> Void = { _, _ in },
        services: CompanionSettingsServices? = nil
    ) {
        self.companion = companion
        self.onSaved = onSaved
        self.onDeletionAccepted = onDeletionAccepted
        self.onDeletionAmbiguous = onDeletionAmbiguous
        self.services = services
        _currentCompanion = State(initialValue: companion)
        _name = State(initialValue: companion.name)
        _instructions = State(initialValue: companion.persona ?? "")
        _icon = State(initialValue: companion.icon ?? .init(shape: 1, mouth: 1, accessory: 1, color: 2))
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
        .onChange(of: name) { enforceNameLimit() }
        .onChange(of: instructions) { enforceInstructionsLimit() }
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
            VStack(spacing: 14) {
                CompanionAvatar(name: displayName, icon: icon, size: 82)
                    .accessibilityLabel("Preview for \(displayName)")

                if canEdit {
                    Button("Surprise me", systemImage: "dice.fill") { randomizeIcon() }
                        .buttonStyle(.glass)
                        .accessibilityIdentifier("companion.settings.randomize-icon")

                    Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                        GridRow {
                            iconControl("Shape", symbol: "square.on.circle", part: .shape)
                            iconControl("Face", symbol: "face.smiling", part: .mouth)
                        }
                        GridRow {
                            iconControl("Style", symbol: "wand.and.stars", part: .accessory)
                            iconControl("Color", symbol: "paintpalette.fill", part: .color)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)

            LabeledContent("Name") {
                TextField("Companion name", text: $name)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .disabled(!canEdit || busy)
                    .accessibilityIdentifier("companion.settings.name")
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Instructions")
                    .font(.subheadline.weight(.semibold))
                TextField("What this Companion is for", text: $instructions, axis: .vertical)
                    .lineLimit(3...6)
                    .disabled(!canEdit || busy)
                    .accessibilityIdentifier("companion.settings.instructions")
                Text("Applied after active work settles and before the next turn starts.")
                    .font(.caption)
                    .foregroundStyle(Color.companionMuted)
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

    private enum IconPart {
        case shape
        case mouth
        case accessory
        case color
    }

    private func iconControl(_ title: String, symbol: String, part: IconPart) -> some View {
        Button {
            cycle(part)
        } label: {
            Label(title, systemImage: symbol)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.glass)
        .accessibilityHint("Cycles to the next \(title.lowercased())")
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

    private var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? currentCompanion.name : trimmed
    }

    private var changed: Bool {
        name.trimmingCharacters(in: .whitespacesAndNewlines) != currentCompanion.name
            || normalizedInstructions != currentCompanion.persona
            || icon != currentCompanion.icon
            || providerID != currentCompanion.runtime.providerIDs.first
            || modelID != currentCompanion.modelID
    }

    private var normalizedInstructions: String? {
        let value = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private var canSave: Bool {
        canEdit
            && !busy
            && changed
            && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            persona: normalizedInstructions,
            providerID: providerID,
            modelID: modelID,
            icon: icon
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
            name = updated.name
            instructions = updated.persona ?? ""
            icon = updated.icon ?? icon
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
            onDeletionAmbiguous(currentCompanion.id, requestID)
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

    private func enforceNameLimit() {
        if name.count > 120 { name = String(name.prefix(120)) }
    }

    private func enforceInstructionsLimit() {
        if instructions.count > 280 { instructions = String(instructions.prefix(280)) }
    }

    private func syncServerProjection(_ updated: CompanionSummary) {
        currentCompanion = updated.preservingListProjection(from: currentCompanion)
        if updated.deletionOperation != nil { deleteRequestID = nil }
    }

    private func resourceCompanionUpdated(_ updated: CompanionSummary) {
        currentCompanion = updated.preservingListProjection(from: currentCompanion)
        onSaved(currentCompanion)
    }

    private func randomizeIcon() {
        updateIcon {
            .init(
                shape: .random(in: 0..<8),
                mouth: .random(in: 0..<5),
                accessory: .random(in: 0..<7),
                color: .random(in: 0..<11)
            )
        }
    }

    private func cycle(_ part: IconPart) {
        updateIcon {
            switch part {
            case .shape:
                return .init(shape: (icon.shape + 1) % 8, mouth: icon.mouth, accessory: icon.accessory, color: icon.color)
            case .mouth:
                return .init(shape: icon.shape, mouth: (icon.mouth + 1) % 5, accessory: icon.accessory, color: icon.color)
            case .accessory:
                return .init(shape: icon.shape, mouth: icon.mouth, accessory: (icon.accessory + 1) % 7, color: icon.color)
            case .color:
                return .init(shape: icon.shape, mouth: icon.mouth, accessory: icon.accessory, color: (icon.color + 1) % 11)
            }
        }
    }

    private func updateIcon(_ mutation: () -> CompanionSummary.Icon) {
        let next = mutation()
        if reduceMotion {
            icon = next
        } else {
            withAnimation(.easeOut(duration: 0.18)) { icon = next }
        }
    }
}

#if DEBUG
struct CompanionSettingsDemoView: View {
    @State private var companion: CompanionSummary
    @State private var showingSettings = false
    @State private var deletionRequested = false

    private let access: CompanionAccess

    init() {
        let rawAccess = ProcessInfo.processInfo.environment["COMPANION_SETTINGS_DEMO_ACCESS"] ?? "owner"
        let access = CompanionAccess(rawValue: rawAccess) ?? .viewer
        self.access = access
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
                ChatView(companion: companion) {
                    showingSettings = true
                }
                .navigationDestination(isPresented: $showingSettings) {
                    CompanionSettingsView(
                        companion: companion,
                        onSaved: { companion = $0 },
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
