import SwiftUI
import CompanionKit

struct PluginManagementView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var model = CompanionPluginSheetModel(accounts: [])
    @State private var loading = true
    @State private var error: String?
    @State private var success: String?
    @State private var showingAddPlugin = false
    @State private var curatedPlugin: CuratedCompanionPlugin?
    @State private var pluginToDisconnect: CompanionPluginAccount?

    var body: some View {
        CompanionSheetCanvas {
            ScrollView {
                VStack(spacing: 20) {
                    CompanionSheetHeader(
                        title: "Plugins",
                        leadingStyle: .back,
                        leadingAction: { dismiss() }
                    ) {
                        Button {
                            model.yoursOnly.toggle()
                        } label: {
                            Text("Yours")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(
                                    model.yoursOnly ? CompanionIOSTheme.primaryCTAText : CompanionIOSTheme.textPrimary
                                )
                                .padding(.horizontal, 16)
                                .frame(height: 36)
                                .background(
                                    model.yoursOnly ? CompanionIOSTheme.primaryCTA : CompanionIOSTheme.card,
                                    in: Capsule()
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityValue(model.yoursOnly ? "Selected" : "Not selected")
                        .accessibilityIdentifier("plugins.yours")
                    }

                    searchField
                    if let error { CompanionErrorNotice(message: error) }
                    if let success { CompanionSuccessNotice(message: success) }

                    if loading && model.accounts.isEmpty {
                        loadingRows
                    } else if model.sections.isEmpty {
                        ContentUnavailableView.search(text: model.query)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 28)
                    } else {
                        ForEach(model.sections) { section in
                            pluginSection(section)
                        }
                    }

                    Button {
                        showingAddPlugin = true
                    } label: {
                        Label("Add custom MCP", systemImage: "terminal")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(CompanionIOSTheme.textPrimary)
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(CompanionIOSTheme.card, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("plugins.add-custom")

                    Text("Gmail can search and read email, then create drafts for review. Companion never sends mail.")
                        .font(.system(size: 15))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .refreshable { await reload() }
            .scrollDismissesKeyboard(.interactively)
        }
        .toolbar(.hidden, for: .navigationBar)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .sheet(isPresented: $showingAddPlugin) {
            AddPluginView {
                showingAddPlugin = false
                success = "Plugin connected."
                Task { await reload() }
            }
        }
        .sheet(item: $curatedPlugin) { plugin in
            ConnectCuratedPluginView(plugin: plugin) {
                curatedPlugin = nil
                success = "\(plugin.title) account connected."
                Task { await reload() }
            }
        }
        .confirmationDialog(
            "Remove \(pluginToDisconnect?.label ?? "plugin")?",
            isPresented: Binding(
                get: { pluginToDisconnect != nil },
                set: { if !$0 { pluginToDisconnect = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove plugin", role: .destructive) {
                guard let plugin = pluginToDisconnect else { return }
                pluginToDisconnect = nil
                Task { await disconnect(plugin) }
            }
            Button("Cancel", role: .cancel) { pluginToDisconnect = nil }
        } message: {
            Text("Its encrypted credential and all Companion attachments will be removed.")
        }
        .task { await reload() }
    }

    private var searchField: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(CompanionIOSTheme.textSecondary)
            TextField("Search plugins", text: $model.query)
                .font(.system(size: 16))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
        .background(CompanionIOSTheme.card, in: Capsule())
        .accessibilityIdentifier("plugins.search")
    }

    private var loadingRows: some View {
        VStack(spacing: 12) {
            ForEach(0..<3, id: \.self) { _ in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 12).frame(width: 44, height: 44)
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 4).frame(width: 110, height: 16)
                        RoundedRectangle(cornerRadius: 4).frame(height: 13)
                    }
                }
                .foregroundStyle(CompanionIOSTheme.textSecondary.opacity(0.16))
                .padding(16)
                .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18))
                .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading plugins")
    }

    private func pluginSection(_ section: CompanionPluginSheetSection) -> some View {
        CompanionSheetSection(section.title) {
            CompanionSheetCard {
                ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { CompanionSheetSeparator(leading: 72) }
                    pluginRow(row)
                }
            }
        }
    }

    private func pluginRow(_ row: CompanionPluginSheetRow) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                PluginMark(provider: row.item.provider, size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.item.title)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.textPrimary)
                    Text(row.item.detail)
                        .font(.system(size: 15))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                trailingState(row)
            }

            if !row.accounts.isEmpty {
                accountChips(row)
                    .padding(.leading, 56)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .accessibilityIdentifier("plugins.catalog.\(row.item.provider)")
    }

    @ViewBuilder
    private func trailingState(_ row: CompanionPluginSheetRow) -> some View {
        switch row.connectionState {
        case .add:
            Button("Add") { connect(row.item) }
                .pluginStateStyle(background: CompanionIOSTheme.chip, foreground: CompanionIOSTheme.textPrimary)
        case .authorize:
            Button("Authorize") { connect(row.item) }
                .pluginStateStyle(background: CompanionIOSTheme.actionBlue, foreground: Color.white)
        case .added:
            Text("Added")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .padding(.horizontal, 14)
                .frame(height: 34)
                .background(CompanionIOSTheme.chip, in: Capsule())
                .accessibilityLabel("Added")
        }
    }

    private func accountChips(_ row: CompanionPluginSheetRow) -> some View {
        FlowLayout(spacing: 7) {
            ForEach(row.accounts.sorted(by: accountOrder)) { account in
                Menu {
                    if !account.connected, row.item.id.hasPrefix("custom:") == false {
                        Button("Authorize") { connect(row.item, suggestedLabel: account.label) }
                    }
                    Button("Remove", systemImage: "trash", role: .destructive) {
                        pluginToDisconnect = account
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text(account.label)
                        if account.connected {
                            Image(systemName: "checkmark")
                                .foregroundStyle(CompanionIOSTheme.toggleGreen)
                        }
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    .background(CompanionIOSTheme.chip, in: Capsule())
                }
                .accessibilityLabel(
                    account.connected ? "\(account.label), connected" : "\(account.label), authorization required"
                )
            }

            if !row.item.id.hasPrefix("custom:") {
                Button {
                    connect(row.item)
                } label: {
                    Label("Account", systemImage: "plus")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                        .padding(.horizontal, 10)
                        .frame(height: 30)
                        .background(CompanionIOSTheme.chip, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add another \(row.item.title) account")
            }
        }
    }

    private func connect(_ item: CompanionPluginCatalogItem, suggestedLabel: String? = nil) {
        guard !item.id.hasPrefix("custom:") else {
            showingAddPlugin = true
            return
        }
        curatedPlugin = CuratedCompanionPlugin(
            id: item.id,
            provider: item.provider,
            title: item.title,
            detail: item.detail
        )
    }

    private func accountOrder(_ left: CompanionPluginAccount, _ right: CompanionPluginAccount) -> Bool {
        if left.connected != right.connected { return left.connected }
        return left.label.localizedCaseInsensitiveCompare(right.label) == .orderedAscending
    }

    private func reload() async {
        loading = true
        do {
            model.accounts = try await sessionStore.listCompanionPlugins()
            error = nil
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Plugins are temporarily unavailable.")
        }
        loading = false
    }

    private func disconnect(_ plugin: CompanionPluginAccount) async {
        do {
            try await sessionStore.deleteCompanionPlugin(accountID: plugin.id)
            success = "\(plugin.label) removed."
            error = nil
            await reload()
        } catch {
            self.error = companionDisplayMessage(error, fallback: "\(plugin.label) could not be removed.")
        }
    }
}

private extension View {
    func pluginStateStyle(background: Color, foreground: Color) -> some View {
        self
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(foreground)
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(background, in: Capsule())
            .buttonStyle(.plain)
    }
}

private struct FlowLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        layout(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let result = layout(proposal: ProposedViewSize(width: bounds.width, height: proposal.height), subviews: subviews)
        for (index, point) in result.points.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: .unspecified)
        }
    }

    private func layout(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
        let width = proposal.width ?? .greatestFiniteMagnitude
        var points: [CGPoint] = []
        var cursor = CGPoint.zero
        var rowHeight: CGFloat = 0
        var usedWidth: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if cursor.x > 0, cursor.x + size.width > width {
                cursor.x = 0
                cursor.y += rowHeight + spacing
                rowHeight = 0
            }
            points.append(cursor)
            cursor.x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            usedWidth = max(usedWidth, cursor.x - spacing)
        }
        return (CGSize(width: min(width, usedWidth), height: cursor.y + rowHeight), points)
    }
}
