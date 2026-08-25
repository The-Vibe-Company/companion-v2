import SwiftUI
import CompanionKit

struct CreateCompanionView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    let onCreated: (CompanionSummary) -> Void

    @State private var name = ""
    @State private var icon = CompanionSummary.Icon(shape: 6, mouth: 1, accessory: 6, color: 2)
    @State private var providers: CompanionProvidersResponse?
    @State private var plugins: [CompanionPluginAccount] = []
    @State private var providerID = ""
    @State private var modelID = ""
    @State private var selectedPluginIDs: Set<String> = []
    @State private var loading = true
    @State private var submitting = false
    @State private var error: String?
    @State private var showingProviders = false
    @State private var showingPlugins = false

    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                ScrollView {
                    VStack(spacing: 14) {
                        CompanionManagementHeader(
                            eyebrow: "New teammate",
                            title: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Create a Companion" : name,
                            detail: "Choose a look, an intelligence, and the tools this durable teammate can use.",
                            symbol: "sparkles"
                        )

                        if let error { CompanionErrorNotice(message: error) }

                        identityCard

                        if loading && providers == nil {
                            ProgressView("Loading workspace…")
                                .padding(28)
                                .frame(maxWidth: .infinity)
                                .companionGlass(radius: 22)
                        } else {
                            providerCard
                            pluginCard
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("New Companion")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(submitting ? "Creating…" : "Create") { Task { await create() } }
                        .disabled(!canCreate || submitting)
                }
            }
            .sheet(isPresented: $showingProviders, onDismiss: { Task { await loadWorkspace() } }) {
                ProviderManagementView()
            }
            .sheet(isPresented: $showingPlugins, onDismiss: { Task { await loadWorkspace() } }) {
                PluginManagementView()
            }
            .task { await loadWorkspace() }
            .onChange(of: providerID) { selectDefaultModel() }
        }
    }

    private var identityCard: some View {
        CompanionManagementCard("Identity") {
            HStack(spacing: 18) {
                CompanionAvatar(name: displayName, icon: icon, size: 86, state: .thinking)
                    .accessibilityLabel("Preview for \(displayName)")

                VStack(alignment: .leading, spacing: 10) {
                    TextField("Companion name", text: $name)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .font(.title3.weight(.semibold))
                        .padding(14)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .stroke(Color.companionBorder, lineWidth: 0.7)
                        }
                        .accessibilityLabel("Companion name")

                    Button("Surprise me", systemImage: "dice.fill") { randomizeIcon() }
                        .buttonStyle(.glass)
                }
            }

            HStack(spacing: 8) {
                iconControl("Shape", symbol: "square.on.circle", part: .shape)
                iconControl("Face", symbol: "face.smiling", part: .mouth)
                iconControl("Style", symbol: "wand.and.stars", part: .accessory)
                iconControl("Color", symbol: "paintpalette.fill", part: .color)
            }
        }
    }

    @ViewBuilder
    private var providerCard: some View {
        CompanionManagementCard("Intelligence") {
            if connectedProviders.isEmpty {
                VStack(alignment: .leading, spacing: 9) {
                    Text("Connect a model provider first")
                        .font(.headline)
                        .foregroundStyle(Color.companionInk)
                    Text("API keys and subscription credentials are encrypted and never shown again.")
                        .font(.subheadline)
                        .foregroundStyle(Color.companionMuted)
                    Button("Open providers", systemImage: "cpu") { showingProviders = true }
                        .buttonStyle(.glassProminent)
                }
            } else {
                CompanionFieldLabel("Model provider")
                Picker("Model provider", selection: $providerID) {
                    ForEach(connectedProviders) { provider in
                        Text(provider.name).tag(provider.id)
                    }
                }
                .pickerStyle(.menu)

                if let provider = selectedProvider {
                    CompanionFieldLabel(
                        "Model",
                        detail: provider.description
                    )
                    Picker("Model", selection: $modelID) {
                        ForEach(provider.models) { model in
                            Text(model.name).tag(model.id)
                        }
                    }
                    .pickerStyle(.menu)
                }

                Button("Manage providers", systemImage: "slider.horizontal.3") {
                    showingProviders = true
                }
                .buttonStyle(.glass)
            }
        }
    }

    private var pluginCard: some View {
        CompanionManagementCard("Plugins") {
            if plugins.isEmpty {
                VStack(alignment: .leading, spacing: 9) {
                    Text("No plugins yet")
                        .font(.headline)
                        .foregroundStyle(Color.companionInk)
                    Text("You can create this Companion without plugins, or connect an MCP server now.")
                        .font(.subheadline)
                        .foregroundStyle(Color.companionMuted)
                    Button("Add a plugin", systemImage: "plus") { showingPlugins = true }
                        .buttonStyle(.glass)
                }
            } else {
                Text("Choose only the tools this Companion needs. You can change them later.")
                    .font(.subheadline)
                    .foregroundStyle(Color.companionMuted)

                ForEach(Array(pluginGroups.enumerated()), id: \.element.provider) { index, group in
                    if index > 0 { Divider().overlay(Color.companionDivider) }
                    Toggle(isOn: pluginGroupSelection(group)) {
                        HStack(spacing: 11) {
                            PluginMark(provider: group.provider, size: 38)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(group.title)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Color.companionInk)
                                Text(group.accounts.count == 1 ? "1 connected account" : "\(group.accounts.count) connected accounts")
                                    .font(.caption)
                                    .foregroundStyle(Color.companionMuted)
                            }
                        }
                    }
                    .tint(Color.companionAccent)
                    .padding(.vertical, 3)
                    .accessibilityIdentifier("create.plugin.\(group.provider)")

                    if groupIsSelected(group) {
                        HStack(spacing: 10) {
                            CompanionFieldLabel("Account")
                            Spacer()
                            if group.accounts.count == 1, let account = group.accounts.first {
                                Text(account.label)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Color.companionMuted)
                            } else {
                                Picker("\(group.title) account", selection: selectedAccount(in: group)) {
                                    ForEach(group.accounts) { account in
                                        Text(account.label).tag(account.id)
                                    }
                                }
                                .pickerStyle(.menu)
                                .accessibilityIdentifier("create.plugin-account.\(group.provider)")
                            }
                        }
                        .padding(.leading, 49)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }

                Button("Manage plugins", systemImage: "puzzlepiece.extension") {
                    showingPlugins = true
                }
                .buttonStyle(.glass)
            }
        }
    }

    private enum IconPart {
        case shape
        case mouth
        case accessory
        case color
    }

    private struct PluginGroup {
        let provider: String
        let title: String
        let accounts: [CompanionPluginAccount]
    }

    private func iconControl(_ title: String, symbol: String, part: IconPart) -> some View {
        Button {
            cycle(part)
        } label: {
            VStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.subheadline.weight(.semibold))
                Text(title)
                    .font(.caption2.weight(.semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(.glass)
        .accessibilityHint("Cycles to the next \(title.lowercased())")
    }

    private var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "New Companion" : trimmed
    }

    private var connectedProviders: [CompanionProviderDefinition] {
        providers?.connectedDefinitions ?? []
    }

    private var selectedProvider: CompanionProviderDefinition? {
        connectedProviders.first(where: { $0.id == providerID })
    }

    private var canCreate: Bool {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmedName.isEmpty
            && trimmedName.count <= 120
            && selectedProvider?.models.contains(where: { $0.id == modelID }) == true
    }

    private var pluginGroups: [PluginGroup] {
        Dictionary(grouping: plugins, by: \.provider)
            .map { provider, accounts in
                PluginGroup(
                    provider: provider,
                    title: pluginTitle(provider),
                    accounts: accounts.sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
                )
            }
            .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    private func pluginGroupSelection(_ group: PluginGroup) -> Binding<Bool> {
        Binding(
            get: { groupIsSelected(group) },
            set: { selected in
                let accountIDs = Set(group.accounts.map(\.id))
                if selected {
                    if selectedPluginIDs.isDisjoint(with: accountIDs), let first = group.accounts.first {
                        selectedPluginIDs.insert(first.id)
                    }
                } else {
                    selectedPluginIDs.subtract(accountIDs)
                }
            }
        )
    }

    private func selectedAccount(in group: PluginGroup) -> Binding<String> {
        let accountIDs = Set(group.accounts.map(\.id))
        return Binding(
            get: {
                selectedPluginIDs.first(where: { accountIDs.contains($0) }) ?? group.accounts.first?.id ?? ""
            },
            set: { accountID in
                selectedPluginIDs.subtract(accountIDs)
                if accountIDs.contains(accountID) { selectedPluginIDs.insert(accountID) }
            }
        )
    }

    private func groupIsSelected(_ group: PluginGroup) -> Bool {
        !selectedPluginIDs.isDisjoint(with: Set(group.accounts.map(\.id)))
    }

    private func pluginTitle(_ provider: String) -> String {
        switch provider.lowercased() {
        case "github": return "GitHub"
        case "linear": return "Linear"
        case "notion": return "Notion"
        case "conductor": return "Conductor"
        default:
            return provider.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
        }
    }

    private func loadWorkspace() async {
        loading = true
        do {
            async let nextProviders = sessionStore.listCompanionProviders()
            async let nextPlugins = sessionStore.listCompanionPlugins()
            let (providerResponse, pluginResponse) = try await (nextProviders, nextPlugins)
            providers = providerResponse
            plugins = pluginResponse
            let validPluginIDs = Set(pluginResponse.map(\.id))
            selectedPluginIDs.formIntersection(validPluginIDs)
            selectInitialProvider(from: providerResponse)
            error = nil
        } catch {
            self.error = companionDisplayMessage(error, fallback: "The workspace configuration could not be loaded.")
        }
        loading = false
    }

    private func selectInitialProvider(from response: CompanionProvidersResponse) {
        let connectedIDs = Set(response.connections.map(\.providerID))
        let preferred = response.defaultProviderID.flatMap { connectedIDs.contains($0) ? $0 : nil }
        if !connectedIDs.contains(providerID) {
            providerID = preferred ?? response.connectedDefinitions.first?.id ?? ""
        }
        selectDefaultModel()
    }

    private func selectDefaultModel() {
        guard let provider = selectedProvider else {
            modelID = ""
            return
        }
        if !provider.models.contains(where: { $0.id == modelID }) {
            modelID = provider.defaultModelID ?? ""
        }
    }

    private func create() async {
        guard canCreate else { return }
        submitting = true
        error = nil
        let input = CreateCompanionInput(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            providerID: providerID,
            modelID: modelID,
            selectedMCPAccountIDs: selectedPluginIDs.sorted(),
            icon: icon
        )
        do {
            let companion = try await sessionStore.createCompanion(input)
            onCreated(companion)
            dismiss()
        } catch {
            self.error = companionDisplayMessage(error, fallback: "The Companion could not be created.")
        }
        submitting = false
    }

    private func randomizeIcon() {
        withAnimation(.spring(duration: 0.35, bounce: 0.24)) {
            icon = .init(
                shape: .random(in: 0..<8),
                mouth: .random(in: 0..<5),
                accessory: .random(in: 0..<7),
                color: .random(in: 0..<11)
            )
        }
    }

    private func cycle(_ part: IconPart) {
        withAnimation(.spring(duration: 0.28, bounce: 0.2)) {
            switch part {
            case .shape:
                icon = .init(shape: (icon.shape + 1) % 8, mouth: icon.mouth, accessory: icon.accessory, color: icon.color)
            case .mouth:
                icon = .init(shape: icon.shape, mouth: (icon.mouth + 1) % 5, accessory: icon.accessory, color: icon.color)
            case .accessory:
                icon = .init(shape: icon.shape, mouth: icon.mouth, accessory: (icon.accessory + 1) % 7, color: icon.color)
            case .color:
                icon = .init(shape: icon.shape, mouth: icon.mouth, accessory: icon.accessory, color: (icon.color + 1) % 11)
            }
        }
    }
}
