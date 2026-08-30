import SwiftUI
import CompanionKit

struct CompanionRoutineEditorView: View {
    @Environment(\.dismiss) private var dismiss

    let initial: CompanionRoutine?
    let memberTimezone: String
    let memberTimezoneWasUnset: Bool
    let saveMemberTimezone: (String) async throws -> String
    let create: (CreateCompanionRoutineInput) async throws -> CompanionRoutine
    let update: (String, UpdateCompanionRoutineInput) async throws -> CompanionRoutine
    let onSaved: () -> Void

    @State private var name: String
    @State private var prompt: String
    @State private var cron: String
    @State private var timezone: String
    @State private var enabled: Bool
    @State private var createID: String
    @State private var saving = false
    @State private var error: String?

    init(
        initial: CompanionRoutine? = nil,
        memberTimezone: String,
        memberTimezoneWasUnset: Bool,
        saveMemberTimezone: @escaping (String) async throws -> String,
        create: @escaping (CreateCompanionRoutineInput) async throws -> CompanionRoutine,
        update: @escaping (String, UpdateCompanionRoutineInput) async throws -> CompanionRoutine,
        onSaved: @escaping () -> Void
    ) {
        self.initial = initial
        self.memberTimezone = memberTimezone
        self.memberTimezoneWasUnset = memberTimezoneWasUnset
        self.saveMemberTimezone = saveMemberTimezone
        self.create = create
        self.update = update
        self.onSaved = onSaved
        _name = State(initialValue: initial?.name ?? "")
        _prompt = State(initialValue: initial?.prompt ?? "")
        _cron = State(initialValue: initial?.cron ?? "0 9 * * 1-5")
        _timezone = State(initialValue: initial?.timezone ?? memberTimezone)
        _enabled = State(initialValue: initial?.enabled ?? true)
        _createID = State(initialValue: UUID().uuidString.lowercased())
    }

    var body: some View {
        NavigationStack {
            Form {
                if let error {
                    Section {
                        CompanionErrorNotice(message: error)
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }

                Section {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.sentences)
                        .accessibilityIdentifier("companion.routine-editor.name")
                    TextField("Prompt", text: $prompt, axis: .vertical)
                        .lineLimit(4...10)
                        .textInputAutocapitalization(.sentences)
                        .accessibilityIdentifier("companion.routine-editor.prompt")
                    TextField("Cron", text: $cron)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("companion.routine-editor.cron")
                    LabeledContent("Timezone") {
                        Text(timezone)
                            .font(.body.monospaced())
                            .foregroundStyle(Color.companionMuted)
                            .multilineTextAlignment(.trailing)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Timezone \(timezone)")
                    Toggle("Enabled", isOn: $enabled)
                        .accessibilityIdentifier("companion.routine-editor.enabled")
                } header: {
                    Text(initial == nil ? "New routine" : "Edit routine")
                } footer: {
                    Text("Cron is evaluated as local wall-clock time in this timezone. Change your member timezone from Account › Member settings.")
                }

                if initial == nil, memberTimezoneWasUnset {
                    Section {
                        Label(
                            "Your device timezone (\(memberTimezone)) is the default. Saving this routine will save it to your member profile first.",
                            systemImage: "location"
                        )
                        .font(.footnote)
                        .foregroundStyle(Color.companionMuted)
                    }
                }

                if !scheduleIsValid {
                    Section {
                        Label(scheduleError, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(Color.companionDanger)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle(initial == nil ? "New routine" : "Edit routine")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await saveRoutine() }
                    } label: {
                        if saving {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Text(initial == nil ? "Create" : "Save")
                        }
                    }
                    .disabled(saveDisabled)
                    .accessibilityLabel(saving ? "Saving routine" : initial == nil ? "Create routine" : "Save routine")
                    .accessibilityIdentifier("companion.routine-editor.save")
                }
            }
            .tint(Color.companionAccent)
        }
    }

    private var saveDisabled: Bool {
        saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !scheduleIsValid
    }

    private var scheduleIsValid: Bool {
        cron.split(whereSeparator: { $0.isWhitespace }).count == 5
            && MemberTimezone.isKnownIdentifier(timezone)
    }

    private var scheduleError: String {
        if !MemberTimezone.isKnownIdentifier(timezone) {
            return "Choose a supported IANA timezone."
        }
        return "Enter a five-field cron expression."
    }

    private func saveRoutine() async {
        guard !saveDisabled else { return }
        saving = true
        error = nil
        do {
            if let initial {
                _ = try await update(
                    initial.id,
                    UpdateCompanionRoutineInput(
                        name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                        prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                        cron: cron.trimmingCharacters(in: .whitespacesAndNewlines),
                        timezone: timezone,
                        enabled: enabled
                    )
                )
            } else {
                // Persist the explicit default before the routine. If this fails, no routine is
                // created with a timezone the member profile does not know about.
                if memberTimezoneWasUnset {
                    timezone = try await saveMemberTimezone(memberTimezone)
                }
                _ = try await create(
                    CreateCompanionRoutineInput(
                        id: createID,
                        name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                        prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                        cron: cron.trimmingCharacters(in: .whitespacesAndNewlines),
                        timezone: timezone,
                        enabled: enabled
                    )
                )
            }
            onSaved()
            dismiss()
        } catch {
            self.error = companionDisplayMessage(error, fallback: "The routine could not be saved.")
        }
        saving = false
    }
}

struct CompanionTriggerEditorView: View {
    @Environment(\.dismiss) private var dismiss

    let initial: CompanionTrigger?
    let create: (CreateCompanionTriggerInput) async throws -> CompanionTrigger
    let update: (String, UpdateCompanionTriggerInput) async throws -> CompanionTrigger
    let onSaved: () -> Void
    let accountOptions: [CompanionPluginAccount]

    @State private var name: String
    @State private var prompt: String
    @State private var provider: CompanionTriggerProvider
    @State private var mode: CompanionTriggerMode
    @State private var providerAccountID: String
    @State private var repository: String
    @State private var events: String
    @State private var enabled: Bool
    @State private var createID: String
    @State private var saving = false
    @State private var error: String?

    init(
        initial: CompanionTrigger? = nil,
        accountOptions: [CompanionPluginAccount] = [],
        create: @escaping (CreateCompanionTriggerInput) async throws -> CompanionTrigger,
        update: @escaping (String, UpdateCompanionTriggerInput) async throws -> CompanionTrigger,
        onSaved: @escaping () -> Void
    ) {
        self.initial = initial
        self.create = create
        self.update = update
        self.onSaved = onSaved
        self.accountOptions = accountOptions
        _name = State(initialValue: initial?.name ?? "")
        _prompt = State(initialValue: initial?.prompt ?? "")
        let defaultProvider = accountOptions.compactMap { CompanionTriggerProvider(rawValue: $0.provider) }
            .first(where: { $0 == .github || $0 == .linear }) ?? .webhook
        let selectedProvider = CompanionTriggerProvider(rawValue: initial?.provider ?? defaultProvider.rawValue) ?? .webhook
        let matchingAccounts = accountOptions.filter {
            $0.connected && $0.provider.lowercased() == selectedProvider.rawValue
        }
        let soleAccount = matchingAccounts.count == 1 ? matchingAccounts[0] : nil
        _provider = State(initialValue: selectedProvider)
        _mode = State(initialValue: initial?.mode ?? .relay)
        _providerAccountID = State(initialValue: initial?.providerAccountID ?? soleAccount?.id ?? "")
        _repository = State(initialValue: initial?.target?.repo ?? "")
        _events = State(initialValue: initial?.target?.events?.joined(separator: ", ") ?? "")
        _enabled = State(initialValue: initial?.enabled ?? true)
        _createID = State(initialValue: UUID().uuidString.lowercased())
    }

    var body: some View {
        NavigationStack {
            Form {
                if let error {
                    Section {
                        CompanionErrorNotice(message: error)
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }

                Section {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.sentences)
                        .accessibilityIdentifier("companion.trigger-editor.name")
                    Picker("Provider", selection: $provider) {
                        Text("Webhook").tag(CompanionTriggerProvider.webhook)
                        Text("Custom").tag(CompanionTriggerProvider.custom)
                        Text("GitHub").tag(CompanionTriggerProvider.github)
                        Text("Linear").tag(CompanionTriggerProvider.linear)
                    }
                    .accessibilityIdentifier("companion.trigger-editor.provider")
                    .onChange(of: provider) { _, _ in chooseSoleAccount() }

                    if eligibleAccounts.count == 1, let account = eligibleAccounts.first {
                        LabeledContent("Connected account", value: account.label)
                            .accessibilityIdentifier("companion.trigger-editor.account-reused")
                    } else if eligibleAccounts.count > 1 {
                        Picker("Connected account", selection: $providerAccountID) {
                            Text("Choose account").tag("")
                            ForEach(eligibleAccounts) { account in
                                Text(account.label).tag(account.id)
                            }
                        }
                        .accessibilityIdentifier("companion.trigger-editor.account")
                    } else if provider == .github || provider == .linear {
                        Text("Connect this provider in Plugins. Companion will reuse that account automatically.")
                            .font(.footnote)
                            .foregroundStyle(Color.companionMuted)
                    }

                    Picker("Mode", selection: $mode) {
                        Text("Notify me").tag(CompanionTriggerMode.notify)
                        Text("Ask the Companion").tag(CompanionTriggerMode.relay)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("companion.trigger-editor.mode")
                    TextField("Prompt", text: $prompt, axis: .vertical)
                        .lineLimit(4...10)
                        .textInputAutocapitalization(.sentences)
                        .accessibilityIdentifier("companion.trigger-editor.prompt")
                    Toggle("Enabled", isOn: $enabled)
                        .accessibilityIdentifier("companion.trigger-editor.enabled")
                } header: {
                    Text(initial == nil ? "New trigger" : "Edit trigger")
                } footer: {
                    Text("Companion registers the provider event end to end. No webhook URL or separate key is required.")
                }

                if provider == .github {
                    Section {
                        TextField("Repository (owner/name)", text: $repository)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("companion.trigger-editor.repository")
                        TextField("Events (comma separated)", text: $events)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("companion.trigger-editor.events")
                    } header: {
                        Text("GitHub webhook")
                    } footer: {
                        Text("Use an owner/name repository and event names such as pull_request, push, or *.")
                    }
                }

                if !formIsValid {
                    Section {
                        Label(formError, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(Color.companionDanger)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle(initial == nil ? "New trigger" : "Edit trigger")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await saveTrigger() }
                    } label: {
                        if saving {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Text(initial == nil ? "Create" : "Save")
                        }
                    }
                    .disabled(saveDisabled)
                    .accessibilityLabel(saving ? "Saving trigger" : initial == nil ? "Create trigger" : "Save trigger")
                    .accessibilityIdentifier("companion.trigger-editor.save")
                }
            }
            .tint(Color.companionAccent)
        }
    }

    private var normalizedEvents: [String] {
        events
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
    }

    private var target: CompanionTriggerTarget? {
        guard provider == .github else { return nil }
        return CompanionTriggerTarget(
            repo: repository.trimmingCharacters(in: .whitespacesAndNewlines),
            events: normalizedEvents
        )
    }

    private var formIsValid: Bool {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        guard provider == .github else { return true }
        return repository.trimmingCharacters(in: .whitespacesAndNewlines).contains("/")
            && !normalizedEvents.isEmpty
    }

    private var formError: String {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Enter a trigger name."
        }
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Enter a prompt."
        }
        return "GitHub triggers need a repository and at least one event."
    }

    private var saveDisabled: Bool {
        saving || !formIsValid || provider == .unknown || (eligibleAccounts.count > 1 && providerAccountID.isEmpty)
    }

    private var eligibleAccounts: [CompanionPluginAccount] {
        guard provider == .github || provider == .linear else { return [] }
        return accountOptions.filter { $0.connected && $0.provider.lowercased() == provider.rawValue }
    }

    private func chooseSoleAccount() {
        if eligibleAccounts.count == 1 {
            providerAccountID = eligibleAccounts[0].id
        } else if !eligibleAccounts.contains(where: { $0.id == providerAccountID }) {
            providerAccountID = ""
        }
    }

    private func saveTrigger() async {
        guard !saveDisabled else { return }
        saving = true
        error = nil
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if let initial {
                _ = try await update(
                    initial.id,
                    UpdateCompanionTriggerInput(
                        name: trimmedName,
                        prompt: trimmedPrompt,
                        mode: mode,
                        provider: provider,
                        providerAccountID: providerAccountID.isEmpty ? nil : providerAccountID,
                        target: target,
                        enabled: enabled
                    )
                )
            } else {
                _ = try await create(
                    CreateCompanionTriggerInput(
                        id: createID,
                        name: trimmedName,
                        prompt: trimmedPrompt,
                        mode: mode,
                        provider: provider,
                        providerAccountID: providerAccountID.isEmpty ? nil : providerAccountID,
                        target: target,
                        enabled: enabled
                    )
                )
            }
            onSaved()
            dismiss()
        } catch {
            self.error = companionDisplayMessage(error, fallback: "The trigger could not be saved.")
        }
        saving = false
    }
}
