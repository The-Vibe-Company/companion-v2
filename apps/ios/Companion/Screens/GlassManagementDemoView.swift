#if DEBUG
import SwiftUI
import CompanionKit

struct GlassManagementDemoView: View {
    private struct DemoProvider: Identifiable {
        let id: String
        let name: String
        let models: [String]
    }

    private static let providerCatalog = [
        DemoProvider(id: "anthropic", name: "Claude", models: ["Claude Opus 4.8", "Claude Sonnet 4.6", "Claude Haiku 4.5"]),
        DemoProvider(id: "openai-codex", name: "Codex", models: ["GPT-5.5", "GPT-5.4", "GPT-5.4 mini"]),
        DemoProvider(id: "kimi-coding", name: "Kimi", models: ["Kimi K2.7 Code", "Kimi For Coding HighSpeed"]),
        DemoProvider(id: "moonshotai", name: "Moonshot", models: ["Kimi K2.6", "Kimi K2.7 Code", "Kimi K2.7 Code HighSpeed"]),
        DemoProvider(id: "zai", name: "z.ai", models: ["GLM-4.7", "GLM-5-Turbo"]),
        DemoProvider(id: "openai", name: "OpenAI API", models: ["GPT-5.5", "GPT-5.4", "GPT-5.4 mini"]),
        DemoProvider(id: "google", name: "Google Gemini", models: ["Gemini 3.1 Pro Preview", "Gemini 3.1 Flash Lite", "Gemini 2.5 Pro"]),
    ]

    private enum Surface: String, CaseIterable, Identifiable {
        case create = "Create"
        case providers = "Providers"
        case plugins = "Plugins"

        var id: String { rawValue }
    }

    @State private var surface: Surface = .create
    @State private var companionName = "Nova"
    @State private var icon = CompanionSummary.Icon(shape: 6, mouth: 1, accessory: 6, color: 8)
    @State private var selectedProviderID = "anthropic"
    @State private var selectedModel = "Claude Sonnet 4.6"
    @State private var selectedPlugins: Set<String> = ["Linear"]
    @State private var selectedLinearAccount = "work"
    @State private var selectedGitHubAccount = "personal"
    @State private var created = false
    @State private var codexConnected = false
    @State private var secondLinearAccountAdded = false
    @State private var customPluginAdded = false

    init(initialSurface: String = Surface.create.rawValue) {
        _surface = State(initialValue: Surface(rawValue: initialSurface) ?? .create)
    }

    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                ScrollView {
                    VStack(spacing: 14) {
                        Picker("Management surface", selection: $surface) {
                            ForEach(Surface.allCases) { value in
                                Text(value.rawValue).tag(value)
                            }
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("demo.management.surface")

                        switch surface {
                        case .create: createSurface
                        case .providers: providerSurface
                        case .plugins: pluginSurface
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("Companion Studio")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var createSurface: some View {
        Group {
            CompanionManagementHeader(
                eyebrow: "New teammate",
                title: "Create a Companion",
                detail: "A polished native flow for identity, intelligence, and tightly scoped tools.",
                symbol: "sparkles"
            )

            if created { CompanionSuccessNotice(message: "Nova is ready for her first message.") }

            CompanionManagementCard("Identity") {
                HStack(spacing: 18) {
                    CompanionAvatar(name: companionName, icon: icon, size: 84, state: .thinking)
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("Companion name", text: $companionName)
                            .font(.title3.weight(.semibold))
                            .padding(14)
                            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .accessibilityIdentifier("demo.management.name")
                        Button("Surprise me", systemImage: "dice.fill") { randomizeIcon() }
                            .buttonStyle(.glass)
                    }
                }
            }

            CompanionManagementCard("Intelligence") {
                Picker("Model provider", selection: $selectedProviderID) {
                    ForEach(Self.providerCatalog) { provider in
                        Text(provider.name).tag(provider.id)
                    }
                }
                Picker("Model", selection: $selectedModel) {
                    ForEach(selectedProvider.models, id: \.self) { model in
                        Text(model).tag(model)
                    }
                }
                .pickerStyle(.menu)
                .onChange(of: selectedProviderID) {
                    selectedModel = selectedProvider.models.first ?? ""
                }
            }

            CompanionManagementCard("Plugins") {
                pluginToggle(
                    "Linear",
                    provider: "linear",
                    accounts: ["work", "client"],
                    selectedAccount: $selectedLinearAccount
                )
                Divider().overlay(Color.companionDivider)
                pluginToggle(
                    "GitHub",
                    provider: "github",
                    accounts: ["personal"],
                    selectedAccount: $selectedGitHubAccount
                )
            }

            Button("Create Companion", systemImage: "sparkles") {
                created = true
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .disabled(companionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("demo.management.create")
        }
    }

    private var providerSurface: some View {
        Group {
            CompanionManagementHeader(
                eyebrow: "Models",
                title: "Model providers",
                detail: "Encrypted, write-only connections with an explicit workspace default.",
                symbol: "cpu"
            )

            CompanionManagementCard("Connected") {
                demoProviderRow(id: "anthropic", name: "Claude", method: "Subscription", isDefault: true)
                if codexConnected {
                    Divider().overlay(Color.companionDivider)
                    demoProviderRow(id: "openai-codex", name: "Codex", method: "Subscription", isDefault: false)
                }
            }

            CompanionManagementCard("Provider catalog") {
                ForEach(Array(Self.providerCatalog.enumerated()), id: \.element.id) { index, provider in
                    if index > 0 { Divider().overlay(Color.companionDivider) }
                    HStack(spacing: 12) {
                        ProviderMark(providerID: provider.id, size: 38)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(provider.name)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color.companionInk)
                            Text("\(provider.models.count) models")
                                .font(.caption)
                                .foregroundStyle(Color.companionMuted)
                        }
                        Spacer()
                        Image(systemName: providerIsConnected(provider.id) ? "checkmark.circle.fill" : "plus.circle")
                            .foregroundStyle(providerIsConnected(provider.id) ? Color.companionSuccess : Color.companionMuted)
                    }
                    .padding(.vertical, 4)
                    .accessibilityIdentifier("demo.management.provider.\(provider.id)")
                }
            }

            if !codexConnected {
                Button("Connect Codex", systemImage: "plus") { codexConnected = true }
                    .buttonStyle(.glassProminent)
                    .accessibilityIdentifier("demo.management.connect-provider")
            }

            Label("Credentials stay encrypted and can never be read back.", systemImage: "lock.shield.fill")
                .font(.footnote)
                .foregroundStyle(Color.companionMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
        }
    }

    private var pluginSurface: some View {
        Group {
            CompanionManagementHeader(
                eyebrow: "Tools",
                title: "Plugins",
                detail: "Reusable MCP connections, attached deliberately to each Companion.",
                symbol: "puzzlepiece.extension.fill"
            )

            CompanionManagementCard("Connected") {
                demoPluginRow(provider: "linear", label: "Linear · work", endpoint: "https://mcp.linear.app")
                if secondLinearAccountAdded {
                    Divider().overlay(Color.companionDivider)
                    demoPluginRow(provider: "linear", label: "Linear · client", endpoint: "https://mcp.linear.app")
                }
                if customPluginAdded {
                    Divider().overlay(Color.companionDivider)
                    demoPluginRow(provider: "custom", label: "Knowledge MCP", endpoint: "https://mcp.example.com")
                }
            }

            CompanionManagementCard("Available plugins") {
                demoCatalogPluginRow(provider: "linear", title: "Linear", count: secondLinearAccountAdded ? 2 : 1)
                Divider().overlay(Color.companionDivider)
                demoCatalogPluginRow(provider: "github", title: "GitHub", count: 0)
                Divider().overlay(Color.companionDivider)
                demoCatalogPluginRow(provider: "notion", title: "Notion", count: 0)
                Divider().overlay(Color.companionDivider)
                demoCatalogPluginRow(provider: "conductor", title: "Conductor", count: 0)
                Divider().overlay(Color.companionDivider)
                demoCatalogPluginRow(
                    provider: "gmail",
                    title: "Gmail",
                    count: 0,
                    detail: "Search and read email, and create drafts for review in Gmail. It never sends mail."
                )
            }

            if !secondLinearAccountAdded {
                Button("Add another Linear account", systemImage: "plus") {
                    secondLinearAccountAdded = true
                }
                .buttonStyle(.glassProminent)
                .accessibilityIdentifier("demo.management.add-linear-account")
            }

            if !customPluginAdded {
                Button("Add custom MCP", systemImage: "plus") { customPluginAdded = true }
                    .buttonStyle(.glass)
                    .accessibilityIdentifier("demo.management.add-plugin")
            }
        }
    }

    private func pluginToggle(
        _ label: String,
        provider: String,
        accounts: [String],
        selectedAccount: Binding<String>
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Binding(
                get: { selectedPlugins.contains(label) },
                set: { selected in
                    if selected { selectedPlugins.insert(label) }
                    else { selectedPlugins.remove(label) }
                }
            )) {
                HStack(spacing: 11) {
                    PluginMark(provider: provider, size: 38)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(label)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.companionInk)
                        Text(accounts.count == 1 ? "1 connected account" : "\(accounts.count) connected accounts")
                            .font(.caption)
                            .foregroundStyle(Color.companionMuted)
                    }
                }
            }
            .tint(Color.companionAccent)
            .padding(.vertical, 3)

            if selectedPlugins.contains(label) {
                HStack {
                    CompanionFieldLabel("Account")
                    Spacer()
                    if accounts.count == 1 {
                        Text(accounts[0])
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.companionMuted)
                    } else {
                        Picker("\(label) account", selection: selectedAccount) {
                            ForEach(accounts, id: \.self) { account in
                                Text(account).tag(account)
                            }
                        }
                        .pickerStyle(.menu)
                        .accessibilityIdentifier("demo.management.plugin-account.\(provider)")
                    }
                }
                .padding(.leading, 49)
            }
        }
    }

    private func demoProviderRow(
        id: String,
        name: String,
        method: String,
        isDefault: Bool
    ) -> some View {
        HStack(spacing: 12) {
            ProviderMark(providerID: id, size: 42)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(name).font(.headline)
                    if isDefault {
                        Text("DEFAULT")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color.companionAccent)
                    }
                }
                Text(method)
                    .font(.caption)
                    .foregroundStyle(Color.companionMuted)
            }
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color.companionSuccess)
        }
        .padding(.vertical, 4)
    }

    private func demoPluginRow(provider: String, label: String, endpoint: String) -> some View {
        HStack(spacing: 12) {
            PluginMark(provider: provider, size: 42)
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(.headline)
                Text(endpoint)
                    .font(.caption.monospaced())
                    .foregroundStyle(Color.companionMuted)
                    .lineLimit(1)
            }
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color.companionSuccess)
        }
        .padding(.vertical, 4)
    }

    private func demoCatalogPluginRow(
        provider: String,
        title: String,
        count: Int,
        detail: String? = nil
    ) -> some View {
        HStack(spacing: 12) {
            PluginMark(provider: provider, size: 38)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer()
            Text(count == 0 ? "Connect" : count == 1 ? "1 account" : "\(count) accounts")
                .font(.caption.weight(.semibold))
                .foregroundStyle(count == 0 ? Color.companionMuted : Color.companionAccent)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("demo.management.plugin.\(provider)")
    }

    private var selectedProvider: DemoProvider {
        Self.providerCatalog.first(where: { $0.id == selectedProviderID }) ?? Self.providerCatalog[0]
    }

    private func providerIsConnected(_ id: String) -> Bool {
        id == "anthropic" || id == "openai-codex" && codexConnected
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
}

#Preview("Liquid Glass management") {
    GlassManagementDemoView()
}
#endif
