import SwiftUI
import CompanionKit
import UIKit

struct MemberSettingsView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss

    let session: Session
    @AppStorage(CompanionPreferenceKeys.automaticReview) private var automaticReview = true
    @AppStorage private var automaticTimezone: Bool
    @AppStorage(CompanionPreferenceKeys.notifications) private var notificationsEnabled = true
    @AppStorage(CompanionPreferenceKeys.appearance) private var appearanceValue = CompanionAppearancePreference.system.rawValue
    @AppStorage(CompanionPreferenceKeys.haptics) private var hapticsEnabled = true
    @State private var timezone: String
    @State private var timezoneError: String?
    @State private var savingTimezone = false

    init(session: Session) {
        self.session = session
        _automaticTimezone = AppStorage(
            wrappedValue: session.user.timezone == nil,
            CompanionPreferenceKeys.automaticTimezone
        )
        _timezone = State(initialValue: session.user.timezone ?? MemberTimezone.deviceIdentifier)
    }

    var body: some View {
        NavigationStack {
            CompanionSheetCanvas {
                ScrollView {
                    VStack(spacing: 20) {
                        CompanionSheetHeader(
                            title: "Settings",
                            leadingStyle: .close,
                            leadingAction: { dismiss() }
                        )

                        if let timezoneError {
                            CompanionErrorNotice(message: timezoneError)
                        }

                        profileCard
                        pluginsCard
                        botSettings
                        deviceSettings
                        legalCard
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 32)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: MemberSettingsRoute.self) { route in
                switch route {
                case .profile:
                    MemberProfileEditorView(session: session)
                case .plugins:
                    PluginManagementView()
                case .timezone:
                    MemberTimezonePickerView(selection: timezoneBinding)
                case .appearance:
                    CompanionAppearanceSettingsView(selection: appearanceBinding)
                case .haptics:
                    CompanionHapticsSettingsView(enabled: $hapticsEnabled)
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onChange(of: automaticReview) { _, _ in selectionFeedback() }
        .onChange(of: notificationsEnabled) { _, _ in selectionFeedback() }
        .onChange(of: automaticTimezone) { _, enabled in
            selectionFeedback()
            guard enabled else { return }
            timezone = MemberTimezone.deviceIdentifier
            Task { await saveTimezone() }
        }
    }

    private var profileCard: some View {
        NavigationLink(value: MemberSettingsRoute.profile) {
            CompanionSheetCard {
                HStack(spacing: 12) {
                    CompanionAccountAvatar(name: profileName)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(profileName)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(CompanionIOSTheme.textPrimary)
                        Text(session.user.email)
                            .font(.system(size: 15))
                            .foregroundStyle(CompanionIOSTheme.textSecondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 68)
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings.profile")
    }

    private var pluginsCard: some View {
        NavigationLink(value: MemberSettingsRoute.plugins) {
            CompanionSheetCard {
                CompanionSheetValueRow(
                    title: "Plugins",
                    detail: "Tools and skills for your Companions",
                    symbol: "puzzlepiece.extension"
                )
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings.plugins")
    }

    private var botSettings: some View {
        CompanionSheetSection("Bot") {
            CompanionSheetCard {
                CompanionSheetToggleRow(
                    title: "Auto-review",
                    detail: "Require approval for risky shell, MCP, and computer actions",
                    isOn: $automaticReview
                )
                CompanionSheetSeparator()
                CompanionSheetToggleRow(
                    title: "Set Time Zone Automatically",
                    detail: "Use this device’s current time zone for schedules and time references",
                    isOn: $automaticTimezone
                )
                CompanionSheetSeparator()
                NavigationLink(value: MemberSettingsRoute.timezone) {
                    CompanionSheetValueRow(
                        title: "Time Zone",
                        value: savingTimezone ? "Saving…" : timezone
                    )
                }
                .buttonStyle(.plain)
                .disabled(automaticTimezone || savingTimezone)
                .opacity(automaticTimezone ? 0.55 : 1)
                .accessibilityIdentifier("settings.timezone")
            }
        }
    }

    private var deviceSettings: some View {
        CompanionSheetCard {
            CompanionSheetToggleRow(title: "Notifications", isOn: $notificationsEnabled)
            CompanionSheetSeparator()
            NavigationLink(value: MemberSettingsRoute.appearance) {
                CompanionSheetValueRow(title: "Appearance", value: appearance.label)
            }
            .buttonStyle(.plain)
            CompanionSheetSeparator()
            NavigationLink(value: MemberSettingsRoute.haptics) {
                CompanionSheetValueRow(title: "Haptics", value: hapticsEnabled ? "On" : "Off")
            }
            .buttonStyle(.plain)
        }
    }

    private var legalCard: some View {
        CompanionSheetCard {
            Link(destination: URL(string: "https://thecompanion.sh/privacy")!) {
                CompanionSheetValueRow(title: "Privacy Policy")
            }
            .buttonStyle(.plain)
            CompanionSheetSeparator()
            Link(destination: URL(string: "https://thecompanion.sh/terms")!) {
                CompanionSheetValueRow(title: "Terms of Service")
            }
            .buttonStyle(.plain)
        }
    }

    private var profileName: String {
        let value = (sessionStore.currentSession?.user.name ?? session.user.name ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? "Companion member" : value
    }

    private var appearance: CompanionAppearancePreference {
        CompanionAppearancePreference(rawValue: appearanceValue) ?? .system
    }

    private var appearanceBinding: Binding<CompanionAppearancePreference> {
        Binding(
            get: { appearance },
            set: { appearanceValue = $0.rawValue }
        )
    }

    private var timezoneBinding: Binding<String> {
        Binding(
            get: { timezone },
            set: { value in
                timezone = value
                automaticTimezone = false
                Task { await saveTimezone() }
            }
        )
    }

    private func saveTimezone() async {
        guard !savingTimezone else { return }
        savingTimezone = true
        timezoneError = nil
        do {
            let profile = try await sessionStore.updateUserProfile(timezone: timezone)
            timezone = profile.timezone ?? timezone
        } catch {
            timezoneError = companionDisplayMessage(error, fallback: "The time zone could not be saved.")
        }
        savingTimezone = false
    }

    private func selectionFeedback() {
        guard hapticsEnabled else { return }
        UISelectionFeedbackGenerator().selectionChanged()
    }
}

private enum MemberSettingsRoute: Hashable {
    case profile
    case plugins
    case timezone
    case appearance
    case haptics
}

private struct MemberProfileEditorView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    let session: Session
    @State private var name: String
    @State private var saving = false
    @State private var error: String?

    init(session: Session) {
        self.session = session
        _name = State(initialValue: session.user.name ?? "")
    }

    var body: some View {
        CompanionSheetCanvas {
            ScrollView {
                VStack(spacing: 20) {
                    CompanionSheetHeader(
                        title: "Profile",
                        leadingStyle: .back,
                        leadingAction: { dismiss() }
                    )
                    if let error { CompanionErrorNotice(message: error) }
                    CompanionSheetCard {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Name")
                                .font(.system(size: 13))
                                .foregroundStyle(CompanionIOSTheme.textSecondary)
                            TextField("Your name", text: $name)
                                .font(.system(size: 17))
                                .textContentType(.name)
                                .autocorrectionDisabled()
                                .padding(.horizontal, 14)
                                .frame(minHeight: 48)
                                .background(CompanionIOSTheme.canvas, in: RoundedRectangle(cornerRadius: 12))
                            Text(session.user.email)
                                .font(.system(size: 15))
                                .foregroundStyle(CompanionIOSTheme.textSecondary)
                        }
                        .padding(16)
                    }
                    Button(saving ? "Saving…" : "Save profile") {
                        Task { await save() }
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.primaryCTAText)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(CompanionIOSTheme.primaryCTA, in: Capsule())
                    .disabled(saveDisabled)
                    .opacity(saveDisabled ? 0.45 : 1)

                    Button("Sign out", role: .destructive) {
                        Task { await sessionStore.signOut() }
                    }
                    .font(.system(size: 15, weight: .semibold))
                    .frame(minHeight: 44)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    private var normalizedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var saveDisabled: Bool {
        saving || normalizedName.isEmpty || normalizedName == (session.user.name ?? "")
    }

    private func save() async {
        guard !saveDisabled else { return }
        saving = true
        error = nil
        do {
            _ = try await sessionStore.updateUserProfile(name: normalizedName)
            dismiss()
        } catch {
            self.error = companionDisplayMessage(error, fallback: "The profile could not be saved.")
        }
        saving = false
    }
}

private struct CompanionAppearanceSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: CompanionAppearancePreference

    var body: some View {
        CompanionSheetCanvas {
            VStack(spacing: 20) {
                CompanionSheetHeader(
                    title: "Appearance",
                    leadingStyle: .back,
                    leadingAction: { dismiss() }
                )
                CompanionSheetCard {
                    Picker("Appearance", selection: $selection) {
                        ForEach(CompanionAppearancePreference.allCases, id: \.self) { preference in
                            Text(preference.label).tag(preference)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(16)
                }
                Text("Your appearance preference is saved on this device.")
                    .font(.system(size: 15))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .toolbar(.hidden, for: .navigationBar)
    }
}

private struct CompanionHapticsSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var enabled: Bool

    var body: some View {
        CompanionSheetCanvas {
            VStack(spacing: 20) {
                CompanionSheetHeader(
                    title: "Haptics",
                    leadingStyle: .back,
                    leadingAction: { dismiss() }
                )
                CompanionSheetCard {
                    CompanionSheetToggleRow(
                        title: "Haptic feedback",
                        detail: "Use a soft system tap for controls and successful actions",
                        isOn: $enabled
                    )
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .toolbar(.hidden, for: .navigationBar)
    }
}

struct MemberTimezonePickerView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String
    @State private var query = ""

    private let identifiers = MemberTimezone.pickerIdentifiers()

    var body: some View {
        CompanionSheetCanvas {
            VStack(spacing: 12) {
                CompanionSheetHeader(
                    title: "Time Zone",
                    leadingStyle: .back,
                    leadingAction: { dismiss() }
                )
                .padding(.horizontal, 16)

                List(filteredIdentifiers, id: \.self) { identifier in
                    Button {
                        selection = identifier
                        dismiss()
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(identifier)
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                                Text(MemberTimezone.displayName(for: identifier))
                                    .font(.system(size: 15))
                                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                            }
                            Spacer(minLength: 8)
                            if identifier == selection {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(CompanionIOSTheme.actionBlue)
                                    .accessibilityHidden(true)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(CompanionIOSTheme.card)
                    .accessibilityLabel(
                        identifier == selection
                            ? "\(identifier), \(MemberTimezone.displayName(for: identifier)), selected"
                            : "\(identifier), \(MemberTimezone.displayName(for: identifier))"
                    )
                    .accessibilityAddTraits(identifier == selection ? .isSelected : [])
                }
                .scrollContentBackground(.hidden)
                .searchable(text: $query, prompt: "Search time zones")
                .overlay {
                    if filteredIdentifiers.isEmpty {
                        ContentUnavailableView.search(text: query)
                    }
                }
            }
            .padding(.top, 8)
        }
        .toolbar(.hidden, for: .navigationBar)
        .accessibilityIdentifier("member-settings.timezone-picker")
    }

    private var filteredIdentifiers: [String] {
        guard !query.isEmpty else { return identifiers }
        return identifiers.filter { identifier in
            identifier.localizedCaseInsensitiveContains(query)
                || MemberTimezone.displayName(for: identifier).localizedCaseInsensitiveContains(query)
        }
    }
}
