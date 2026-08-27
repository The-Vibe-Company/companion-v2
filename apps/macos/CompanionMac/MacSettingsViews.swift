import AppKit
import CompanionKit
import SwiftUI

struct CompanionMacCompanionSettingsView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    let initialCompanion: CompanionSummary
    let onSaved: (CompanionSummary) -> Void

    @State private var name: String
    @State private var persona: String
    @State private var providerID: String
    @State private var modelID: String
    @State private var providers: CompanionProvidersResponse?
    @State private var skills: [CompanionSkillReference] = []
    @State private var plugins: [CompanionPluginAccount] = []
    @State private var connectedResources: CompanionConnectedResources?
    @State private var selectedPlugins: Set<String>
    @State private var loading = true
    @State private var saving = false
    @State private var errorMessage: String?

    init(companion: CompanionSummary, onSaved: @escaping (CompanionSummary) -> Void) {
        initialCompanion = companion
        self.onSaved = onSaved
        _name = State(initialValue: companion.name)
        _persona = State(initialValue: companion.persona ?? "")
        _providerID = State(initialValue: companion.runtime.providerIDs.first ?? "")
        _modelID = State(initialValue: companion.modelID ?? "")
        _selectedPlugins = State(initialValue: Set(companion.selectedMCPAccountIDs))
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    CompanionMacErrorNotice(message: errorMessage)
                        .listRowBackground(Color.clear)
                }
                Section("Identity") {
                    TextField("Name", text: $name)
                        .accessibilityIdentifier("companion.settings.name")
                        .disabled(!canEdit)
                    TextField("Instructions", text: $persona, axis: .vertical)
                        .lineLimit(4...10)
                        .accessibilityIdentifier("companion.settings.instructions")
                        .disabled(!canEdit)
                }

                Section("Provider and model") {
                    if connectedProviders.isEmpty {
                        Text("Connect a model provider from workspace settings before changing this Companion.")
                            .font(.callout)
                            .foregroundStyle(Color.companionMacMuted)
                    } else {
                        Picker("Provider", selection: $providerID) {
                            ForEach(connectedProviders) { provider in
                                Text(provider.name).tag(provider.id)
                            }
                        }
                        .disabled(!canEdit)
                        .onChange(of: providerID) { _, value in
                            if let provider = connectedProviders.first(where: { $0.id == value }),
                               !provider.models.contains(where: { $0.id == modelID }) {
                                modelID = provider.defaultModelID ?? ""
                            }
                        }
                        if let provider = selectedProvider {
                            Picker("Model", selection: $modelID) {
                                ForEach(provider.models) { model in
                                    Text(model.name).tag(model.id)
                                }
                            }
                            .disabled(!canEdit)
                        }
                    }
                }

                Section {
                    if skills.isEmpty {
                        Text("No Skills are available to this workspace.")
                            .foregroundStyle(Color.companionMacMuted)
                    } else {
                        ForEach(skills) { skill in
                            HStack {
                                Image(systemName: initialCompanion.selectedSkillIDs.contains(skill.id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(initialCompanion.selectedSkillIDs.contains(skill.id) ? Color.companionMacSuccess : Color.companionMacMuted)
                                Text(skill.slug)
                                    .font(.body.monospaced())
                                Spacer()
                                if initialCompanion.selectedSkillIDs.contains(skill.id) {
                                    Text("Staged")
                                        .font(.caption)
                                        .foregroundStyle(Color.companionMacMuted)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Selected Skills")
                } footer: {
                    Text("Skill selection is managed by the shared Companion contract. This native view shows the current projection and never invents a mutation endpoint.")
                }

                Section {
                    if plugins.isEmpty {
                        Text("No connected Plugins. Add accounts from workspace settings.")
                            .foregroundStyle(Color.companionMacMuted)
                    } else {
                        ForEach(plugins) { plugin in
                            Toggle(isOn: Binding(
                                get: { selectedPlugins.contains(plugin.id) },
                                set: { selected in
                                    if selected { selectedPlugins.insert(plugin.id) }
                                    else { selectedPlugins.remove(plugin.id) }
                                }
                            )) {
                                VStack(alignment: .leading, spacing: CompanionMacMetrics.space / 2) {
                                    Text(plugin.label)
                                    Text("\(plugin.provider) · \(plugin.transport.rawValue)")
                                        .font(.caption)
                                        .foregroundStyle(Color.companionMacMuted)
                                }
                            }
                            .disabled(!canManagePlugins)
                        }
                    }
                } header: {
                    Text("Plugins")
                } footer: {
                    if initialCompanion.access == .editor {
                        Text("Only the Companion Owner can change attached plugin accounts. This protects private accounts selected by another member.")
                    } else if initialCompanion.access == .viewer {
                        Text("Viewer access is read-only.")
                    }
                }

                Section("Connected resources") {
                    if let connectedResources {
                        CompanionMacResourceSummaryRow(
                            title: "Skills",
                            detail: "\(connectedResources.skills.count) connected · \(connectedResources.hiddenSkillCount) unavailable",
                            symbol: "shippingbox"
                        )
                        CompanionMacResourceSummaryRow(
                            title: "Routines",
                            detail: "\(connectedResources.routines.count) scheduled",
                            symbol: "clock"
                        )
                        CompanionMacResourceSummaryRow(
                            title: "Triggers",
                            detail: "\(connectedResources.triggers.count) connected",
                            symbol: "bolt"
                        )
                    } else {
                        Text("No connected resource projection is available.")
                            .foregroundStyle(Color.companionMacMuted)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Companion settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if saving { ProgressView().controlSize(.small) }
                        else { Text("Save") }
                    }
                    .disabled(!canSave)
                    .accessibilityIdentifier("companion.settings.save")
                }
            }
            .overlay {
                if loading { ProgressView("Loading settings…") }
            }
        }
        .frame(minWidth: 560, minHeight: 620)
        .task { await load() }
    }

    private var canEdit: Bool {
        initialCompanion.access.canEditCompanionSettings
    }

    private var canSave: Bool {
        canEdit && !saving && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !providerID.isEmpty && !modelID.isEmpty
    }

    private var canManagePlugins: Bool {
        initialCompanion.access == .owner
    }

    private var connectedProviders: [CompanionProviderDefinition] {
        providers?.connectedDefinitions ?? []
    }

    private var selectedProvider: CompanionProviderDefinition? {
        connectedProviders.first(where: { $0.id == providerID })
    }

    private func load() async {
        do {
            async let providerResponse = sessionStore.listCompanionProviders()
            async let accessibleSkills = sessionStore.listAccessibleCompanionSkills()
            async let pluginAccounts = sessionStore.listCompanionPlugins()
            async let resources = sessionStore.connectedResources(for: initialCompanion)
            let (providerResponseValue, skillValue, pluginValue, resourcesValue) = try await (
                providerResponse,
                accessibleSkills,
                pluginAccounts,
                resources
            )
            providers = providerResponseValue
            skills = skillValue
            plugins = pluginValue
            connectedResources = resourcesValue
            if providerID.isEmpty {
                providerID = providerResponseValue.defaultProviderID
                    ?? providerResponseValue.connectedDefinitions.first?.id
                    ?? ""
            }
            if modelID.isEmpty { modelID = selectedProvider?.defaultModelID ?? "" }
            errorMessage = nil
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "Companion settings are temporarily unavailable.")
        }
        loading = false
    }

    private func save() async {
        guard canSave else { return }
        saving = true
        errorMessage = nil
        do {
            var updated = try await sessionStore.updateCompanion(
                companionID: initialCompanion.id,
                input: UpdateCompanionInput(
                    name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                    persona: persona.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : persona,
                    providerID: providerID,
                    modelID: modelID,
                    icon: initialCompanion.icon ?? CompanionSummary.Icon(shape: 1, mouth: 1, accessory: 1, color: 2)
                )
            )
            if canManagePlugins, Set(updated.selectedMCPAccountIDs) != selectedPlugins {
                updated = try await sessionStore.updateCompanionPluginSelection(
                    companionID: initialCompanion.id,
                    selectedMCPAccountIDs: Array(selectedPlugins).sorted()
                )
            }
            onSaved(updated)
            dismiss()
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "Companion settings could not be saved.")
        }
        saving = false
    }
}

private struct CompanionMacResourceSummaryRow: View {
    let title: String
    let detail: String
    let symbol: String

    var body: some View {
        HStack(spacing: CompanionMacMetrics.space * 2) {
            Image(systemName: symbol)
                .foregroundStyle(Color.companionMacAccent)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: CompanionMacMetrics.space / 2) {
                Text(title)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(Color.companionMacMuted)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct CompanionMacCreateCompanionView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    let onCreated: (CompanionSummary) -> Void

    @State private var name = ""
    @State private var persona = ""
    @State private var providerID = ""
    @State private var modelID = ""
    @State private var providers: CompanionProvidersResponse?
    @State private var skills: [CompanionSkillReference] = []
    @State private var plugins: [CompanionPluginAccount] = []
    @State private var selectedSkills: Set<String> = []
    @State private var selectedPlugins: Set<String> = []
    @State private var loading = true
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    CompanionMacErrorNotice(message: errorMessage)
                        .listRowBackground(Color.clear)
                }
                Section("Identity") {
                    HStack(spacing: CompanionMacMetrics.space * 3) {
                        CompanionMacAvatar(name: name.isEmpty ? "Companion" : name, icon: defaultIcon, size: 56)
                        VStack(alignment: .leading, spacing: CompanionMacMetrics.space) {
                            Text("New Companion")
                                .font(.headline)
                            Text("One durable teammate and thread")
                                .font(.caption)
                                .foregroundStyle(Color.companionMacMuted)
                        }
                    }
                    TextField("Name", text: $name)
                        .accessibilityIdentifier("companion.create.name")
                    TextField("Instructions (optional)", text: $persona, axis: .vertical)
                        .lineLimit(3...8)
                }

                Section("Provider and model") {
                    if connectedProviders.isEmpty {
                        Text("Connect a provider first from workspace settings.")
                            .foregroundStyle(Color.companionMacMuted)
                    } else {
                        Picker("Provider", selection: $providerID) {
                            ForEach(connectedProviders) { provider in
                                Text(provider.name).tag(provider.id)
                            }
                        }
                        .onChange(of: providerID) { _, value in
                            modelID = connectedProviders.first(where: { $0.id == value })?.defaultModelID ?? ""
                        }
                        if let provider = selectedProvider {
                            Picker("Model", selection: $modelID) {
                                ForEach(provider.models) { model in
                                    Text(model.name).tag(model.id)
                                }
                            }
                        }
                    }
                }

                if !skills.isEmpty {
                    Section("Skills") {
                        ForEach(skills) { skill in
                            Toggle(skill.slug, isOn: Binding(
                                get: { selectedSkills.contains(skill.id) },
                                set: { selected in
                                    if selected { selectedSkills.insert(skill.id) }
                                    else { selectedSkills.remove(skill.id) }
                                }
                            ))
                            .font(.body.monospaced())
                        }
                    }
                }

                if !plugins.isEmpty {
                    Section("Plugins") {
                        ForEach(plugins) { plugin in
                            Toggle(plugin.label, isOn: Binding(
                                get: { selectedPlugins.contains(plugin.id) },
                                set: { selected in
                                    if selected { selectedPlugins.insert(plugin.id) }
                                    else { selectedPlugins.remove(plugin.id) }
                                }
                            ))
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("New Companion")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await create() }
                    } label: {
                        if saving { ProgressView().controlSize(.small) }
                        else { Text("Create") }
                    }
                    .disabled(!canCreate)
                    .accessibilityIdentifier("companion.create.save")
                }
            }
            .overlay {
                if loading { ProgressView("Loading providers…") }
            }
        }
        .frame(minWidth: 560, minHeight: 620)
        .task { await load() }
    }

    private var defaultIcon: CompanionSummary.Icon {
        CompanionSummary.Icon(shape: 1, mouth: 1, accessory: 1, color: 2)
    }

    private var connectedProviders: [CompanionProviderDefinition] {
        providers?.connectedDefinitions ?? []
    }

    private var selectedProvider: CompanionProviderDefinition? {
        connectedProviders.first(where: { $0.id == providerID })
    }

    private var canCreate: Bool {
        !saving && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !providerID.isEmpty && !modelID.isEmpty
    }

    private func load() async {
        do {
            async let providerResponse = sessionStore.listCompanionProviders()
            async let accessibleSkills = sessionStore.listAccessibleCompanionSkills()
            async let pluginAccounts = sessionStore.listCompanionPlugins()
            let (providerValue, skillValue, pluginValue) = try await (
                providerResponse,
                accessibleSkills,
                pluginAccounts
            )
            providers = providerValue
            skills = skillValue
            plugins = pluginValue
            providerID = providerValue.defaultProviderID ?? providerValue.connectedDefinitions.first?.id ?? ""
            modelID = connectedProviders.first(where: { $0.id == providerID })?.defaultModelID ?? ""
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "Provider settings are temporarily unavailable.")
        }
        loading = false
    }

    private func create() async {
        guard canCreate else { return }
        saving = true
        errorMessage = nil
        do {
            let companion = try await sessionStore.createCompanion(
                CreateCompanionInput(
                    name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                    persona: persona.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : persona,
                    providerID: providerID,
                    modelID: modelID,
                    selectedSkillIDs: Array(selectedSkills).sorted(),
                    selectedMCPAccountIDs: Array(selectedPlugins).sorted(),
                    icon: defaultIcon
                )
            )
            onCreated(companion)
            dismiss()
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "The Companion could not be created.")
        }
        saving = false
    }
}

struct CompanionMacMemberSettingsView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    let session: Session
    @State private var name: String
    @State private var timezone: String
    @State private var saving = false
    @State private var errorMessage: String?

    init(session: Session) {
        self.session = session
        _name = State(initialValue: session.user.name ?? "")
        _timezone = State(initialValue: session.user.timezone ?? TimeZone.current.identifier)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    CompanionMacErrorNotice(message: errorMessage)
                        .listRowBackground(Color.clear)
                }
                Section("Profile") {
                    TextField("Name", text: $name)
                    TextField("Email", text: .constant(session.user.email))
                        .disabled(true)
                }
                Section {
                    Picker("Timezone", selection: $timezone) {
                        ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { value in
                            Text(value).tag(value)
                        }
                    }
                } header: {
                    Text("Timezone")
                } footer: {
                    Text("Used for routine defaults and displayed schedule times across Companion clients.")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Member settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if saving { ProgressView().controlSize(.small) }
                        else { Text("Save") }
                    }
                    .disabled(saving)
                }
            }
        }
        .frame(minWidth: 480, minHeight: 380)
    }

    private func save() async {
        guard !saving else { return }
        saving = true
        errorMessage = nil
        do {
            _ = try await sessionStore.updateUserProfile(
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                timezone: timezone
            )
            dismiss()
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "Your profile could not be saved.")
        }
        saving = false
    }
}

struct CompanionMacProviderManagementView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var response: CompanionProvidersResponse?
    @State private var selectedProviderID = ""
    @State private var credential = ""
    @State private var authorizationCode = ""
    @State private var loading = true
    @State private var working = false
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage { CompanionMacErrorNotice(message: errorMessage).listRowBackground(Color.clear) }
                if let message {
                    Label(message, systemImage: "checkmark.circle")
                        .foregroundStyle(Color.companionMacSuccess)
                        .listRowBackground(Color.clear)
                }
                Section("Connected providers") {
                    if connectedDefinitions.isEmpty {
                        Text("No providers connected yet.")
                            .foregroundStyle(Color.companionMacMuted)
                    } else {
                        ForEach(connectedDefinitions) { provider in
                            HStack {
                                VStack(alignment: .leading, spacing: CompanionMacMetrics.space / 2) {
                                    Text(provider.name)
                                    if provider.id == response?.defaultProviderID {
                                        Text("Default")
                                            .font(.caption)
                                            .foregroundStyle(Color.companionMacAccent)
                                    }
                                }
                                Spacer()
                                if provider.id != response?.defaultProviderID {
                                    Button("Set default") { Task { await setDefault(provider.id) } }
                                }
                                Button("Remove", role: .destructive) { Task { await remove(provider.id) } }
                            }
                        }
                    }
                }

                Section("Connect provider") {
                    Picker("Provider", selection: $selectedProviderID) {
                        Text("Choose provider").tag("")
                        ForEach(response?.catalog ?? []) { provider in
                            Text(provider.name).tag(provider.id)
                        }
                    }
                    if let provider = selectedProvider {
                        Text(provider.description)
                            .font(.caption)
                            .foregroundStyle(Color.companionMacMuted)
                        if provider.authMethods.contains(.apiKey) {
                            SecureField("API key", text: $credential)
                                .textContentType(.password)
                            Button("Save encrypted API key") {
                                Task { await saveAPIKey(provider.id) }
                            }
                            .disabled(working || credential.isEmpty)
                        }
                        if provider.authMethods.contains(.subscription) {
                            Button("Open browser authorization") {
                                Task { await beginSubscription(provider.id) }
                            }
                            .disabled(working)
                            TextField("Authorization code (if requested)", text: $authorizationCode)
                            Button("Complete authorization") {
                                Task { await completeSubscription() }
                            }
                            .disabled(working || authorizationCode.isEmpty)
                        }
                    }
                } footer: {
                    Text("Credentials are write-only and encrypted by the control plane. They are never displayed or logged by this client.")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Providers")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .overlay {
                if loading { ProgressView("Loading providers…") }
            }
        }
        .frame(minWidth: 600, minHeight: 520)
        .task { await reload() }
    }

    private var connectedDefinitions: [CompanionProviderDefinition] {
        response?.connectedDefinitions ?? []
    }

    private var selectedProvider: CompanionProviderDefinition? {
        response?.catalog.first(where: { $0.id == selectedProviderID })
    }

    private func reload() async {
        do {
            response = try await sessionStore.listCompanionProviders()
            if selectedProviderID.isEmpty { selectedProviderID = response?.catalog.first?.id ?? "" }
            errorMessage = nil
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "Providers are temporarily unavailable.")
        }
        loading = false
    }

    private func saveAPIKey(_ providerID: String) async {
        guard !working, !credential.isEmpty else { return }
        working = true
        defer { working = false }
        do {
            _ = try await sessionStore.saveCompanionProvider(providerID: providerID, credential: credential)
            credential = ""
            message = "Provider connected."
            await reload()
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "The provider could not be connected.")
        }
    }

    private func setDefault(_ providerID: String) async {
        guard !working else { return }
        working = true
        defer { working = false }
        do {
            try await sessionStore.setDefaultCompanionProvider(providerID: providerID)
            message = "Default provider updated."
            await reload()
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "The default provider could not be changed.")
        }
    }

    private func remove(_ providerID: String) async {
        guard !working else { return }
        working = true
        defer { working = false }
        do {
            try await sessionStore.deleteCompanionProvider(providerID: providerID)
            message = "Provider disconnected."
            await reload()
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "The provider could not be disconnected.")
        }
    }

    private func beginSubscription(_ providerID: String) async {
        guard !working else { return }
        working = true
        defer { working = false }
        do {
            let flow = try await sessionStore.startCompanionProviderOAuth(providerID: providerID)
            if let url = flow.authorizationURL ?? flow.verificationURL {
                NSWorkspace.shared.open(url)
                message = flow.userCode.map { "Enter code \($0) in the provider window, then complete authorization." }
                    ?? "Complete authorization in the provider window, then enter the returned code."
            }
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "Provider authorization could not be started.")
        }
    }

    private func completeSubscription() async {
        guard !working, !authorizationCode.isEmpty else { return }
        working = true
        defer { working = false }
        do {
            _ = try await sessionStore.completeCompanionProviderOAuth(
                authorizationCode: authorizationCode.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            authorizationCode = ""
            message = "Provider connected."
            await reload()
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "Provider authorization could not be completed.")
        }
    }
}

struct CompanionMacPluginManagementView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var plugins: [CompanionPluginAccount] = []
    @State private var provider = "custom"
    @State private var label = ""
    @State private var transport: CompanionPluginTransport = .http
    @State private var endpoint = ""
    @State private var command = ""
    @State private var args = ""
    @State private var credentialName = ""
    @State private var credentialValue = ""
    @State private var loading = true
    @State private var working = false
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage { CompanionMacErrorNotice(message: errorMessage).listRowBackground(Color.clear) }
                if let message {
                    Label(message, systemImage: "checkmark.circle")
                        .foregroundStyle(Color.companionMacSuccess)
                        .listRowBackground(Color.clear)
                }
                Section("Connected Plugins") {
                    if plugins.isEmpty {
                        Text("No connected Plugin accounts.")
                            .foregroundStyle(Color.companionMacMuted)
                    } else {
                        ForEach(plugins) { plugin in
                            HStack {
                                VStack(alignment: .leading, spacing: CompanionMacMetrics.space / 2) {
                                    Text(plugin.label)
                                    Text("\(plugin.provider) · \(plugin.transport.rawValue)")
                                        .font(.caption.monospaced())
                                        .foregroundStyle(Color.companionMacMuted)
                                }
                                Spacer()
                                Button("Remove", role: .destructive) {
                                    Task { await remove(plugin) }
                                }
                                .disabled(working)
                            }
                        }
                    }
                }

                Section("Add custom account") {
                    TextField("Provider", text: $provider)
                    TextField("Account label", text: $label)
                    Picker("Transport", selection: $transport) {
                        Text("HTTP").tag(CompanionPluginTransport.http)
                        Text("Command").tag(CompanionPluginTransport.stdio)
                    }
                    if transport == .http {
                        TextField("Endpoint URL", text: $endpoint)
                    } else {
                        TextField("Command", text: $command)
                        TextField("Arguments (one per line)", text: $args, axis: .vertical)
                            .lineLimit(2...6)
                    }
                    TextField(
                        transport == .http ? "Credential header name" : "Credential environment name",
                        text: $credentialName
                    )
                    SecureField("Credential value", text: $credentialValue)
                    Button("Connect Plugin") {
                        Task { await save() }
                    }
                    .disabled(!canSave || working)
                } footer: {
                    Text("HTTP credentials use a header name. Command credentials use an environment variable name. Values are encrypted and write-only.")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Plugins")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .overlay {
                if loading { ProgressView("Loading Plugins…") }
            }
        }
        .frame(minWidth: 620, minHeight: 600)
        .task { await reload() }
    }

    private var canSave: Bool {
        !provider.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (transport == .http
                ? URL(string: endpoint.trimmingCharacters(in: .whitespacesAndNewlines))?.scheme != nil
                : !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private func reload() async {
        do {
            plugins = try await sessionStore.listCompanionPlugins()
            errorMessage = nil
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "Plugins are temporarily unavailable.")
        }
        loading = false
    }

    private func save() async {
        guard canSave, !working else { return }
        working = true
        defer { working = false }
        do {
            _ = try await sessionStore.saveCompanionPlugin(
                SaveCompanionPluginInput(
                    provider: provider.trimmingCharacters(in: .whitespacesAndNewlines),
                    label: label.trimmingCharacters(in: .whitespacesAndNewlines),
                    transport: transport,
                    url: transport == .http ? endpoint.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
                    command: transport == .stdio ? command.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
                    args: transport == .stdio
                        ? args.split(whereSeparator: { $0.isNewline }).map(String.init)
                        : [],
                    credentialName: credentialName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : credentialName,
                    credentialValue: credentialValue.isEmpty ? nil : credentialValue
                )
            )
            label = ""
            endpoint = ""
            command = ""
            args = ""
            credentialName = ""
            credentialValue = ""
            message = "Plugin connected."
            await reload()
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "The Plugin could not be connected.")
        }
    }

    private func remove(_ plugin: CompanionPluginAccount) async {
        guard !working else { return }
        working = true
        defer { working = false }
        do {
            try await sessionStore.deleteCompanionPlugin(accountID: plugin.id)
            message = "Plugin removed."
            await reload()
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "The Plugin could not be removed.")
        }
    }
}
