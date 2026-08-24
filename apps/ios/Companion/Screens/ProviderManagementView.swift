import SwiftUI
import CompanionKit

struct ProviderManagementView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var providers: CompanionProvidersResponse?
    @State private var loading = true
    @State private var error: String?
    @State private var success: String?
    @State private var warning: String?
    @State private var showingConnector = false
    @State private var connectorProviderID: String?
    @State private var providerToDisconnect: CompanionProviderDefinition?

    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                ScrollView {
                    VStack(spacing: 14) {
                        CompanionManagementHeader(
                            eyebrow: "Models",
                            title: "Model providers",
                            detail: "Connect the intelligence behind every Companion. Credentials stay encrypted and write-only.",
                            symbol: "cpu"
                        )

                        if let error { CompanionErrorNotice(message: error) }
                        if let warning { CompanionWarningNotice(message: warning) }
                        if let success { CompanionSuccessNotice(message: success) }

                        if loading && providers == nil {
                            ProgressView("Loading providers…")
                                .padding(28)
                                .frame(maxWidth: .infinity)
                                .companionGlass(radius: 22)
                        } else if let providers {
                            connectedProviders(providers)
                            availableProviders(providers)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .scrollIndicators(.hidden)
                .refreshable { await reload() }
            }
            .navigationTitle("Providers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Connect", systemImage: "plus") { openConnector() }
                        .disabled(providers?.canManage != true)
                }
            }
            .sheet(isPresented: $showingConnector) {
                if let providers {
                    ConnectProviderView(
                        catalog: providers.catalog,
                        initialProviderID: connectorProviderID,
                        shouldMakeDefault: providers.connections.isEmpty
                    ) { result in
                        showingConnector = false
                        switch result {
                        case .connected(let message):
                            success = message
                            warning = nil
                            error = nil
                        case .connectedWithoutDefault(let message):
                            success = nil
                            warning = message
                            error = nil
                        }
                        Task { await reload() }
                    }
                }
            }
            .confirmationDialog(
                "Disconnect \(providerToDisconnect?.name ?? "provider")?",
                isPresented: Binding(
                    get: { providerToDisconnect != nil },
                    set: { if !$0 { providerToDisconnect = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) {
                    guard let provider = providerToDisconnect else { return }
                    providerToDisconnect = nil
                    Task { await disconnect(provider) }
                }
                Button("Cancel", role: .cancel) { providerToDisconnect = nil }
            } message: {
                Text("Companions using this provider must be moved to another model first.")
            }
            .task { await reload() }
        }
    }

    @ViewBuilder
    private func connectedProviders(_ response: CompanionProvidersResponse) -> some View {
        CompanionManagementCard("Connected") {
            if response.connectedDefinitions.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("No provider connected")
                        .font(.headline)
                        .foregroundStyle(Color.companionInk)
                    Text("Connect a provider before creating your first Companion.")
                        .font(.subheadline)
                        .foregroundStyle(Color.companionMuted)
                    if response.canManage {
                        Button("Connect a provider", systemImage: "plus") { openConnector() }
                            .buttonStyle(.glassProminent)
                            .padding(.top, 4)
                    }
                }
            } else {
                ForEach(Array(response.connectedDefinitions.enumerated()), id: \.element.id) { index, provider in
                    if index > 0 { Divider().overlay(Color.companionDivider) }
                    providerRow(provider, response: response)
                }
            }
        }

        if !response.canManage {
            Label(
                "Only workspace owners and admins can change model providers.",
                systemImage: "lock.fill"
            )
            .font(.footnote)
            .foregroundStyle(Color.companionMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
        }
    }

    @ViewBuilder
    private func availableProviders(_ response: CompanionProvidersResponse) -> some View {
        CompanionManagementCard("Provider catalog") {
            ForEach(Array(response.catalog.enumerated()), id: \.element.id) { index, provider in
                if index > 0 { Divider().overlay(Color.companionDivider) }
                HStack(spacing: 12) {
                    ProviderMark(providerID: provider.id, size: 38)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(provider.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.companionInk)
                        Text(provider.description)
                            .font(.caption)
                            .foregroundStyle(Color.companionMuted)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    if response.connections.contains(where: { $0.providerID == provider.id }) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(Color.companionSuccess)
                            .accessibilityLabel("Connected")
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func providerRow(
        _ provider: CompanionProviderDefinition,
        response: CompanionProvidersResponse
    ) -> some View {
        let connection = response.connections.first(where: { $0.providerID == provider.id })
        let isDefault = response.defaultProviderID == provider.id
        return HStack(spacing: 12) {
            ProviderMark(providerID: provider.id, size: 42)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    Text(provider.name)
                        .font(.headline)
                        .foregroundStyle(Color.companionInk)
                    if isDefault {
                        Text("DEFAULT")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color.companionAccent)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.companionAccent.opacity(0.10), in: Capsule())
                    }
                }
                Text(connection?.authMethod == .subscription ? "Subscription" : "API key")
                    .font(.caption)
                    .foregroundStyle(Color.companionMuted)
            }
            Spacer()
            if response.canManage {
                Menu {
                    if !isDefault {
                        Button("Make default", systemImage: "star") {
                            Task { await makeDefault(provider) }
                        }
                    }
                    Button("Reconnect", systemImage: "arrow.triangle.2.circlepath") {
                        openConnector(providerID: provider.id)
                    }
                    Button("Disconnect", systemImage: "trash", role: .destructive) {
                        providerToDisconnect = provider
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Manage \(provider.name)")
            }
        }
        .padding(.vertical, 4)
    }

    private func reload() async {
        loading = true
        do {
            providers = try await sessionStore.listCompanionProviders()
            error = nil
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Model providers are temporarily unavailable.")
        }
        loading = false
    }

    private func makeDefault(_ provider: CompanionProviderDefinition) async {
        do {
            try await sessionStore.setDefaultCompanionProvider(providerID: provider.id)
            success = "\(provider.name) is now the default provider."
            warning = nil
            error = nil
            await reload()
        } catch {
            self.error = companionDisplayMessage(error, fallback: "The default provider could not be changed.")
        }
    }

    private func disconnect(_ provider: CompanionProviderDefinition) async {
        do {
            try await sessionStore.deleteCompanionProvider(providerID: provider.id)
            success = "\(provider.name) disconnected."
            warning = nil
            error = nil
            await reload()
        } catch {
            self.error = companionDisplayMessage(error, fallback: "\(provider.name) could not be disconnected.")
        }
    }

    private func openConnector(providerID: String? = nil) {
        connectorProviderID = providerID
        showingConnector = true
    }
}

private enum ProviderConnectionResult {
    case connected(String)
    case connectedWithoutDefault(String)
}

private struct ConnectProviderView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let catalog: [CompanionProviderDefinition]
    let shouldMakeDefault: Bool
    let onConnected: (ProviderConnectionResult) -> Void

    @State private var providerID = ""
    @State private var authMethod: CompanionProviderAuthMethod = .apiKey
    @State private var credential = ""
    @State private var authorizationCode = ""
    @State private var oauth: CompanionProviderOAuthStart?
    @State private var makeDefault: Bool
    @State private var waitingForApproval = false
    @State private var submitting = false
    @State private var error: String?

    init(
        catalog: [CompanionProviderDefinition],
        initialProviderID: String?,
        shouldMakeDefault: Bool,
        onConnected: @escaping (ProviderConnectionResult) -> Void
    ) {
        self.catalog = catalog
        self.shouldMakeDefault = shouldMakeDefault
        self.onConnected = onConnected
        _providerID = State(
            initialValue: initialProviderID.flatMap { candidate in
                catalog.contains(where: { $0.id == candidate }) ? candidate : nil
            } ?? catalog.first?.id ?? ""
        )
        _makeDefault = State(initialValue: shouldMakeDefault)
    }

    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                ScrollView {
                    VStack(spacing: 14) {
                        CompanionManagementHeader(
                            eyebrow: "Secure connection",
                            title: selectedProvider?.name ?? "Choose a provider",
                            detail: selectedProvider?.description ?? "Select the model provider your Companions will use.",
                            symbol: "link.badge.plus"
                        )

                        if let error { CompanionErrorNotice(message: error) }

                        CompanionManagementCard("Provider") {
                            Picker("Model provider", selection: $providerID) {
                                ForEach(catalog) { provider in
                                    Text(provider.name).tag(provider.id)
                                }
                            }
                            .pickerStyle(.menu)
                            .disabled(submitting)

                            if let selectedProvider, selectedProvider.authMethods.count > 1 {
                                Picker("Connection method", selection: $authMethod) {
                                    ForEach(selectedProvider.authMethods, id: \.self) { method in
                                        Text(method == .apiKey ? "API key" : "Subscription").tag(method)
                                    }
                                }
                                .pickerStyle(.segmented)
                                .disabled(submitting)
                            }
                        }

                        if authMethod == .apiKey {
                            apiKeyCard
                        } else {
                            subscriptionCard
                        }

                        CompanionManagementCard {
                            Toggle("Make this the default provider", isOn: $makeDefault)
                                .font(.subheadline.weight(.semibold))
                                .disabled(submitting)
                            Text("New Companions will select this provider first. Existing Companions are unchanged.")
                                .font(.caption)
                                .foregroundStyle(Color.companionMuted)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("Connect provider")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                if authMethod == .apiKey {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(submitting ? "Connecting…" : "Connect") {
                            Task { await connectAPIKey() }
                        }
                        .disabled(!canSubmitAPIKey || submitting)
                    }
                }
            }
            .task {
                selectSupportedAuthMethod()
            }
            .onChange(of: providerID) {
                oauth = nil
                authorizationCode = ""
                error = nil
                selectSupportedAuthMethod()
                Task { await sessionStore.cancelCompanionProviderOAuth() }
            }
            .onDisappear {
                Task { await sessionStore.cancelCompanionProviderOAuth() }
            }
        }
    }

    private var apiKeyCard: some View {
        CompanionManagementCard("API key") {
            CompanionFieldLabel(
                "Secret key",
                detail: "Saved encrypted. It cannot be viewed again after connecting."
            )
            SecureField("Paste your API key", text: $credential)
                .textContentType(.password)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(14)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(Color.companionBorder, lineWidth: 0.7)
                }
        }
    }

    @ViewBuilder
    private var subscriptionCard: some View {
        CompanionManagementCard("Subscription") {
            if let oauth {
                switch oauth.flow {
                case .authorizationCode:
                    Text("Finish signing in, then paste the authorization code below.")
                        .font(.subheadline)
                        .foregroundStyle(Color.companionMuted)
                    if let url = oauth.authorizationURL {
                        Button("Open \(selectedProvider?.name ?? "provider")", systemImage: "safari") {
                            openURL(url)
                        }
                        .buttonStyle(.glass)
                    }
                    CompanionFieldLabel("Authorization code")
                    TextField("Paste code or callback value", text: $authorizationCode)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(14)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    Button(submitting ? "Connecting…" : "Complete connection", systemImage: "checkmark") {
                        Task { await completeAuthorizationCode() }
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(authorizationCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || submitting)

                case .deviceCode:
                    Text("Enter this one-time code in the provider page, then return here.")
                        .font(.subheadline)
                        .foregroundStyle(Color.companionMuted)
                    if let code = oauth.userCode {
                        Text(code)
                            .font(.title2.monospaced().weight(.bold))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity)
                            .padding(16)
                            .background(Color.companionInk.opacity(0.05), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .accessibilityLabel("One-time code \(code)")
                    }
                    if let url = oauth.verificationURL {
                        Button("Open provider page", systemImage: "safari") { openURL(url) }
                            .buttonStyle(.glass)
                    }
                    Button(waitingForApproval ? "Still waiting…" : "Check connection", systemImage: "arrow.clockwise") {
                        Task { await pollDeviceCode() }
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(submitting)
                }
            } else {
                Text("Use your existing subscription. Companion never sees your password.")
                    .font(.subheadline)
                    .foregroundStyle(Color.companionMuted)
                Button(submitting ? "Starting…" : "Continue with \(selectedProvider?.name ?? "provider")", systemImage: "arrow.up.right.square") {
                    Task { await startSubscription() }
                }
                .buttonStyle(.glassProminent)
                .disabled(!canStartSubscription || submitting)
            }
        }
    }

    private var selectedProvider: CompanionProviderDefinition? {
        catalog.first(where: { $0.id == providerID })
    }

    private var canSubmitAPIKey: Bool {
        selectedProvider?.authMethods.contains(.apiKey) == true
            && !credential.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !credential.contains("\n")
            && !credential.contains("\r")
    }

    private var canStartSubscription: Bool {
        selectedProvider?.authMethods.contains(.subscription) == true
            && ["anthropic", "openai-codex"].contains(providerID)
    }

    private func selectSupportedAuthMethod() {
        guard let provider = selectedProvider else { return }
        if !provider.authMethods.contains(authMethod) {
            authMethod = provider.authMethods.first ?? .apiKey
        }
    }

    private func connectAPIKey() async {
        guard canSubmitAPIKey else { return }
        let connectionProviderID = providerID
        let providerName = selectedProvider?.name ?? "Provider"
        let shouldSetDefault = makeDefault || shouldMakeDefault
        submitting = true
        error = nil
        do {
            _ = try await sessionStore.saveCompanionProvider(
                providerID: connectionProviderID,
                credential: credential.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            await finishConnection(
                providerID: connectionProviderID,
                providerName: providerName,
                shouldSetDefault: shouldSetDefault
            )
        } catch {
            self.error = companionDisplayMessage(error, fallback: "The provider could not be connected.")
        }
        submitting = false
    }

    private func startSubscription() async {
        guard canStartSubscription else { return }
        submitting = true
        error = nil
        do {
            let started = try await sessionStore.startCompanionProviderOAuth(providerID: providerID)
            oauth = started
            if let url = started.authorizationURL ?? started.verificationURL { openURL(url) }
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Subscription sign-in could not be started.")
        }
        submitting = false
    }

    private func completeAuthorizationCode() async {
        let connectionProviderID = oauth?.providerID ?? providerID
        let providerName = catalog.first(where: { $0.id == connectionProviderID })?.name ?? "Provider"
        let shouldSetDefault = makeDefault || shouldMakeDefault
        submitting = true
        error = nil
        do {
            _ = try await sessionStore.completeCompanionProviderOAuth(
                authorizationCode: authorizationCode.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            await finishConnection(
                providerID: connectionProviderID,
                providerName: providerName,
                shouldSetDefault: shouldSetDefault
            )
        } catch {
            self.error = companionDisplayMessage(error, fallback: "The authorization code could not be verified.")
        }
        submitting = false
    }

    private func pollDeviceCode() async {
        let connectionProviderID = oauth?.providerID ?? providerID
        let providerName = catalog.first(where: { $0.id == connectionProviderID })?.name ?? "Provider"
        let shouldSetDefault = makeDefault || shouldMakeDefault
        submitting = true
        error = nil
        waitingForApproval = false
        do {
            let result = try await sessionStore.pollCompanionProviderOAuth()
            if result.status == .connected {
                await finishConnection(
                    providerID: connectionProviderID,
                    providerName: providerName,
                    shouldSetDefault: shouldSetDefault
                )
            } else {
                waitingForApproval = true
            }
        } catch {
            self.error = companionDisplayMessage(error, fallback: "The subscription status could not be checked.")
        }
        submitting = false
    }

    private func finishConnection(
        providerID: String,
        providerName: String,
        shouldSetDefault: Bool
    ) async {
        if shouldSetDefault {
            do {
                try await sessionStore.setDefaultCompanionProvider(providerID: providerID)
            } catch {
                onConnected(.connectedWithoutDefault(
                    "\(providerName) is connected, but the default provider could not be changed. You can retry from its menu."
                ))
                return
            }
        }
        let suffix = shouldSetDefault ? " and set as default." : "."
        onConnected(.connected("\(providerName) connected\(suffix)"))
    }
}

struct ProviderMark: View {
    let providerID: String
    var size: CGFloat = 42

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(foreground)
            .frame(width: size, height: size)
            .background(background, in: RoundedRectangle(cornerRadius: size * 0.32, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                    .stroke(Color.white.opacity(0.8), lineWidth: 0.7)
            }
            .accessibilityHidden(true)
    }

    private var symbol: String {
        switch providerID {
        case "anthropic": return "a.circle.fill"
        case "openai-codex", "openai": return "sparkles"
        case "google": return "g.circle.fill"
        case "zai": return "z.circle.fill"
        case "kimi-coding", "moonshotai": return "moon.stars.fill"
        default: return "cpu.fill"
        }
    }

    private var background: Color {
        switch providerID {
        case "anthropic": return Color(red: 0.92, green: 0.86, blue: 0.76)
        case "openai-codex", "openai": return Color.companionInk
        case "google": return Color(red: 0.83, green: 0.91, blue: 1.0)
        case "zai": return Color(red: 0.84, green: 0.88, blue: 1.0)
        case "kimi-coding": return Color(red: 0.82, green: 0.92, blue: 0.90)
        case "moonshotai": return Color(red: 0.88, green: 0.86, blue: 1.0)
        default: return Color.companionAccentGold.opacity(0.34)
        }
    }

    private var foreground: Color {
        ["openai-codex", "openai"].contains(providerID) ? .white : .companionInk
    }
}
