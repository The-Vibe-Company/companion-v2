import SwiftUI
import CompanionKit

struct MemberSettingsView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss

    let session: Session
    @State private var name: String
    @State private var timezone: String
    @State private var saving = false
    @State private var error: String?
    @State private var success: String?

    init(session: Session) {
        self.session = session
        _name = State(initialValue: session.user.name ?? "")
        _timezone = State(initialValue: session.user.timezone ?? MemberTimezone.deviceIdentifier)
    }

    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                Form {
                    if let error {
                        Section {
                            CompanionErrorNotice(message: error)
                        }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    }

                    if let success {
                        Section {
                            CompanionSuccessNotice(message: success)
                        }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    }

                    Section {
                        TextField("Name", text: $name)
                            .textContentType(.name)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("member-settings.name")

                        NavigationLink {
                            MemberTimezonePickerView(selection: $timezone)
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Timezone")
                                Text(timezone)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(Color.companionMuted)
                            }
                        }
                        .accessibilityIdentifier("member-settings.timezone")
                    } header: {
                        Text("Member profile")
                    } footer: {
                        Text("Routine schedules use this IANA timezone. Next-fire and last-fired times are shown here too.")
                    }

                    if session.user.timezone == nil {
                        Section {
                            Label(
                                "No timezone is saved yet. The device timezone is shown as the default and will be saved when you save these settings.",
                                systemImage: "location"
                            )
                            .font(.footnote)
                            .foregroundStyle(Color.companionMuted)
                        }
                    }
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("Member settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if saving {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Text("Save")
                        }
                    }
                    .disabled(saveDisabled)
                    .accessibilityLabel(saving ? "Saving member settings" : "Save member settings")
                    .accessibilityIdentifier("member-settings.save")
                }
            }
            .tint(Color.companionAccent)
        }
    }

    private var saveDisabled: Bool {
        saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !hasChanges
    }

    private var hasChanges: Bool {
        let currentName = (session.user.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let editedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return editedName != currentName || timezone != (session.user.timezone ?? "")
    }

    private func save() async {
        guard !saveDisabled else { return }
        saving = true
        error = nil
        success = nil
        let editedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let currentName = (session.user.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let profile = try await sessionStore.updateUserProfile(
                name: editedName == currentName ? nil : editedName,
                timezone: timezone == session.user.timezone ? nil : timezone
            )
            name = profile.name
            timezone = profile.timezone ?? MemberTimezone.deviceIdentifier
            success = "Member settings saved."
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Member settings could not be saved.")
        }
        saving = false
    }
}

struct MemberTimezonePickerView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String
    @State private var query = ""

    private let identifiers = MemberTimezone.pickerIdentifiers()

    var body: some View {
        List(filteredIdentifiers, id: \.self) { identifier in
            Button {
                selection = identifier
                dismiss()
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(identifier)
                            .font(.body.monospaced())
                            .foregroundStyle(Color.companionInk)
                        Text(MemberTimezone.displayName(for: identifier))
                            .font(.caption)
                            .foregroundStyle(Color.companionMuted)
                    }
                    Spacer(minLength: 8)
                    if identifier == selection {
                        Image(systemName: "checkmark")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Color.companionAccent)
                            .accessibilityHidden(true)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                identifier == selection
                    ? "\(identifier), \(MemberTimezone.displayName(for: identifier)), selected"
                    : "\(identifier), \(MemberTimezone.displayName(for: identifier))"
            )
            .accessibilityAddTraits(
                identifier == selection ? .isSelected : []
            )
        }
        .navigationTitle("Choose timezone")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search timezones")
        .overlay {
            if filteredIdentifiers.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
        .accessibilityIdentifier("member-settings.timezone-picker")
    }

    private var filteredIdentifiers: [String] {
        guard !query.isEmpty else { return identifiers }
        return identifiers.filter { identifier in
            identifier.localizedCaseInsensitiveContains(query)
                || MemberTimezone.displayName(for: identifier)
                    .localizedCaseInsensitiveContains(query)
        }
    }
}
