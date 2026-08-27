import SwiftUI
import CompanionKit
import UIKit

struct CompanionSettingsView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(NotificationCoordinator.self) private var notifications
    @Environment(\.dismiss) private var dismiss

    let companion: CompanionSummary
    let onSaved: (CompanionSummary) -> Void
    let onDeletionStarted: (CompanionSummary, UUID) -> Void
    let onDeletionAccepted: (String, CompanionOperationSummary) -> Void
    let onDeletionFailed: (CompanionSummary, UUID, Error) -> Void
    private let services: CompanionSettingsServices?

    @State private var model: CompanionBotDetailSheetModel
    @State private var editingTitle = false
    @State private var showingCharacterPicker = false
    @State private var showingInstructions = false
    @State private var showingNewRoutine = false
    @State private var routinesLoading = true
    @State private var savingIdentity = false
    @State private var error: String?
    @AppStorage private var notificationsEnabled: Bool
    @FocusState private var titleFocused: Bool

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
        _model = State(initialValue: CompanionBotDetailSheetModel(companion: companion))
        _notificationsEnabled = AppStorage(
            wrappedValue: true,
            CompanionPreferenceKeys.notificationPrefix + companion.id
        )
    }

    var body: some View {
        CompanionSheetCanvas {
            ScrollView {
                VStack(spacing: 22) {
                    CompanionSheetHeader(
                        title: "Bot details",
                        leadingStyle: .back,
                        leadingAction: { dismiss() }
                    )

                    characterHero
                    titleCard
                    if let error { CompanionErrorNotice(message: error) }
                    characterSection
                    instructionsCard
                    routinesSection
                    notificationsCard

                    if !canEdit {
                        Text("You have read-only access to this Bot.")
                            .font(.system(size: 15))
                            .foregroundStyle(CompanionIOSTheme.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 36)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .toolbar(.hidden, for: .navigationBar)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .task(id: companion.id) { await loadRoutines() }
        .onChange(of: companion) { _, updated in
            model = CompanionBotDetailSheetModel(companion: updated, routines: model.routines)
        }
        .onChange(of: titleFocused) { _, focused in
            if !focused, editingTitle { Task { await saveIdentity() } }
        }
        .sheet(isPresented: $showingCharacterPicker) {
            CompanionCharacterPickerSheet(icon: model.icon) { icon in
                model.icon = icon
                showingCharacterPicker = false
                Task { await saveIdentity() }
            }
        }
        .sheet(isPresented: $showingInstructions) {
            CompanionInstructionsSheet(companion: model.companion) { persona in
                try await update(persona: persona)
            } onSaved: { updated in
                apply(updated)
                showingInstructions = false
            }
        }
        .sheet(isPresented: $showingNewRoutine) {
            CompanionRoutineEditorView(
                memberTimezone: sessionStore.memberTimezone ?? MemberTimezone.deviceIdentifier,
                memberTimezoneWasUnset: sessionStore.memberTimezone == nil,
                saveMemberTimezone: { identifier in
                    let profile = try await sessionStore.updateUserProfile(timezone: identifier)
                    return profile.timezone ?? identifier
                },
                create: { try await createRoutine($0) },
                update: { id, input in try await updateRoutine(id: id, input: input) }
            ) {
                showingNewRoutine = false
                Task { await loadRoutines() }
            }
        }
    }

    private var characterHero: some View {
        Button {
            guard canEdit else { return }
            showingCharacterPicker = true
            UISelectionFeedbackGenerator().selectionChanged()
        } label: {
            CharacterMark(name: model.name, icon: model.icon, size: 104)
                .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
        .disabled(!canEdit)
        .accessibilityLabel(canEdit ? "Change (model.name)'s character" : "(model.name)'s character")
        .accessibilityIdentifier("companion.details.character")
    }

    private var titleCard: some View {
        CompanionSheetCard {
            HStack(spacing: 12) {
                if editingTitle && canEdit {
                    TextField("Bot name", text: $model.name)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.textPrimary)
                        .focused($titleFocused)
                        .submitLabel(.done)
                        .onSubmit { titleFocused = false }
                        .accessibilityIdentifier("companion.details.name")
                } else {
                    Text(model.name)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.textPrimary)
                }
                Spacer()
                if savingIdentity {
                    ProgressView().controlSize(.small)
                } else if canEdit {
                    Button {
                        editingTitle = true
                        titleFocused = true
                    } label: {
                        Image(systemName: "pencil")
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Edit Bot name")
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, 6)
            .frame(minHeight: 64)
        }
    }

    private var characterSection: some View {
        CompanionSheetSection("Character") {
            CompanionSheetCard {
                CompanionCharacterControls(icon: $model.icon, canEdit: canEdit && !savingIdentity) {
                    Task { await saveIdentity() }
                }
                CompanionSheetSeparator()
                Button {
                    model.icon = defaultIcon
                    Task { await saveIdentity() }
                } label: {
                    CompanionSheetValueRow(
                        title: "Reset to default",
                        showsChevron: false
                    )
                }
                .buttonStyle(.plain)
                .disabled(!canEdit || savingIdentity || model.icon == defaultIcon)
            }
            Text("How this Bot's mark looks everywhere")
                .font(.system(size: 15))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .padding(.horizontal, 4)
        }
    }

    private var instructionsCard: some View {
        CompanionSheetCard {
            Button { showingInstructions = true } label: {
                CompanionSheetValueRow(
                    title: "Instructions",
                    detail: instructionPreview,
                    symbol: "doc.text"
                )
            }
            .buttonStyle(.plain)
            .disabled(!canEdit)
            .accessibilityIdentifier("companion.details.instructions")
        }
    }

    private var routinesSection: some View {
        CompanionSheetSection("Routines") {
            CompanionSheetCard {
                if routinesLoading && model.routines.isEmpty {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading routines…")
                            .font(.system(size: 15))
                            .foregroundStyle(CompanionIOSTheme.textSecondary)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ForEach(Array(model.routines.enumerated()), id: \.element.id) { index, routine in
                        if index > 0 { CompanionSheetSeparator(leading: 52) }
                        NavigationLink {
                            CompanionRoutineDetailSheet(
                                companionID: companion.id,
                                routine: routine,
                                canEdit: canEdit,
                                services: services,
                                onUpdated: { updated in
                                    replaceRoutine(updated)
                                }
                            )
                        } label: {
                            routineRow(routine)
                        }
                        .buttonStyle(.plain)
                    }
                }

                if canEdit {
                    if !model.routines.isEmpty || routinesLoading { CompanionSheetSeparator() }
                    Button {
                        showingNewRoutine = true
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "plus")
                                .frame(width: 24)
                            Text("Add routine")
                                .font(.system(size: 17, weight: .semibold))
                            Spacer()
                        }
                        .foregroundStyle(CompanionIOSTheme.actionBlue)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 56)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("companion.details.add-routine")
                }
            }
        }
    }

    private func routineRow(_ routine: CompanionRoutine) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "clock")
                .font(.system(size: 18))
                .foregroundStyle(CompanionIOSTheme.textPrimary)
                .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(routine.name)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                Text(model.promptPreview(for: routine))
                    .font(.system(size: 15))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .padding(.top, 4)
        }
        .padding(16)
        .frame(minHeight: 72)
        .contentShape(Rectangle())
    }

    private var notificationsCard: some View {
        CompanionSheetCard {
            CompanionSheetToggleRow(title: "Notifications", isOn: $notificationsEnabled)
                .disabled(!canEdit)
                .onChange(of: notificationsEnabled) { _, enabled in
                    guard canEdit else { return }
                    UISelectionFeedbackGenerator().selectionChanged()
                    if enabled { Task { await notifications.requestAuthorizationAndRegister() } }
                }
        }
    }

    private var canEdit: Bool { model.companion.access.canEditCompanionSettings }
    private var defaultIcon: CompanionSummary.Icon { .init(shape: 1, mouth: 0, accessory: 0, color: 2) }
    private var instructionPreview: String {
        let value = model.companion.persona?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? "Add a persona and working style" : value
    }

    private func loadRoutines() async {
        routinesLoading = true
        do {
            model.routines = if let list = services?.listRoutines {
                try await list()
            } else {
                try await sessionStore.listCompanionRoutines(companionID: companion.id)
            }
            error = nil
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Routines are temporarily unavailable.")
        }
        routinesLoading = false
    }

    private func saveIdentity() async {
        guard model.canSaveIdentity, !savingIdentity else {
            editingTitle = false
            return
        }
        savingIdentity = true
        error = nil
        do {
            let updated = try await update(persona: model.companion.persona)
            apply(updated)
            editingTitle = false
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Bot details could not be saved.")
        }
        savingIdentity = false
    }

    private func update(persona: String?) async throws -> CompanionSummary {
        guard let providerID = model.companion.runtime.providerIDs.first,
              let modelID = model.companion.modelID else {
            throw APIError(status: 409, code: "model_unavailable", message: "This Bot has no active model.")
        }
        let input = UpdateCompanionInput(
            name: model.normalizedName,
            persona: persona,
            providerID: providerID,
            modelID: modelID,
            icon: model.icon
        )
        if let services { return try await services.updateCompanion(model.companion.id, input) }
        return try await sessionStore.updateCompanion(companionID: model.companion.id, input: input)
    }

    private func apply(_ updated: CompanionSummary) {
        let reconciled = updated.preservingListProjection(from: model.companion)
        model = CompanionBotDetailSheetModel(companion: reconciled, routines: model.routines)
        onSaved(reconciled)
    }

    private func createRoutine(_ input: CreateCompanionRoutineInput) async throws -> CompanionRoutine {
        if let create = services?.createRoutine { return try await create(input) }
        return try await sessionStore.createCompanionRoutine(companionID: companion.id, input: input)
    }

    private func updateRoutine(id: String, input: UpdateCompanionRoutineInput) async throws -> CompanionRoutine {
        if let update = services?.updateRoutine { return try await update(id, input) }
        return try await sessionStore.updateCompanionRoutine(companionID: companion.id, routineID: id, input: input)
    }

    private func replaceRoutine(_ routine: CompanionRoutine) {
        if let index = model.routines.firstIndex(where: { $0.id == routine.id }) {
            model.routines[index] = routine
        }
    }
}

private struct CompanionCharacterPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var icon: CompanionSummary.Icon
    let onDone: (CompanionSummary.Icon) -> Void

    init(icon: CompanionSummary.Icon, onDone: @escaping (CompanionSummary.Icon) -> Void) {
        _icon = State(initialValue: icon)
        self.onDone = onDone
    }

    var body: some View {
        NavigationStack {
            CompanionSheetCanvas {
                ScrollView {
                    VStack(spacing: 20) {
                        CompanionSheetHeader(title: "Character", leadingStyle: .back) { dismiss() }
                        CompanionSheetCard {
                            CompanionCharacterControls(icon: $icon, canEdit: true) {}
                        }
                        Button("Done") { onDone(icon) }
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(CompanionIOSTheme.primaryCTAText)
                            .frame(maxWidth: .infinity, minHeight: 50)
                            .background(CompanionIOSTheme.primaryCTA, in: Capsule())
                    }
                    .padding(16)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

private struct CompanionCharacterControls: View {
    @Binding var icon: CompanionSummary.Icon
    let canEdit: Bool
    let onSelection: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Color")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                ScrollView(.horizontal) {
                    HStack(spacing: 10) {
                        ForEach(CharacterMark.palette.indices, id: \.self) { index in
                            Button {
                                icon = .init(shape: icon.shape, mouth: icon.mouth, accessory: icon.accessory, color: index)
                                onSelection()
                            } label: {
                                Circle()
                                    .fill(CharacterMark.palette[index])
                                    .frame(width: 30, height: 30)
                                    .padding(4)
                                    .overlay {
                                        Circle().stroke(
                                            icon.color == index ? CompanionIOSTheme.textPrimary : Color.clear,
                                            lineWidth: 2
                                        )
                                    }
                            }
                            .buttonStyle(.plain)
                            .disabled(!canEdit)
                            .accessibilityLabel("Color \(index + 1)")
                            .accessibilityAddTraits(icon.color == index ? .isSelected : [])
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
            .padding(16)

            CompanionSheetSeparator()

            VStack(alignment: .leading, spacing: 12) {
                Text("Shape")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(CharacterMarkShape.allCases, id: \.rawValue) { shape in
                            Button {
                                icon = .init(shape: shape.rawValue, mouth: icon.mouth, accessory: icon.accessory, color: icon.color)
                                onSelection()
                            } label: {
                                CharacterMark(
                                    name: "Shape \(shape.rawValue + 1)",
                                    shapeIndex: shape.rawValue,
                                    colorIndex: icon.color,
                                    size: 42
                                )
                                .padding(6)
                                .overlay {
                                    Circle().stroke(
                                        icon.shape == shape.rawValue ? CompanionIOSTheme.textPrimary : Color.clear,
                                        lineWidth: 2
                                    )
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(!canEdit)
                            .accessibilityAddTraits(icon.shape == shape.rawValue ? .isSelected : [])
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
            .padding(16)
        }
    }
}

private struct CompanionInstructionsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let companion: CompanionSummary
    let save: (String?) async throws -> CompanionSummary
    let onSaved: (CompanionSummary) -> Void
    @State private var persona: String
    @State private var saving = false
    @State private var error: String?

    init(
        companion: CompanionSummary,
        save: @escaping (String?) async throws -> CompanionSummary,
        onSaved: @escaping (CompanionSummary) -> Void
    ) {
        self.companion = companion
        self.save = save
        self.onSaved = onSaved
        _persona = State(initialValue: companion.persona ?? "")
    }

    var body: some View {
        CompanionSheetCanvas {
            VStack(spacing: 20) {
                CompanionSheetHeader(title: "Instructions", leadingStyle: .back) { dismiss() }
                if let error { CompanionErrorNotice(message: error) }
                TextEditor(text: $persona)
                    .font(.system(size: 17))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                    .scrollContentBackground(.hidden)
                    .padding(12)
                    .frame(minHeight: 240)
                    .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18))
                    .accessibilityIdentifier("companion.instructions.text")
                Spacer()
                Button {
                    Task { await saveInstructions() }
                } label: {
                    if saving { ProgressView().tint(.white) } else { Text("Save instructions") }
                }
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(CompanionIOSTheme.primaryCTAText)
                .frame(maxWidth: .infinity, minHeight: 50)
                .background(CompanionIOSTheme.primaryCTA, in: Capsule())
                .disabled(saving)
            }
            .padding(16)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private func saveInstructions() async {
        saving = true
        error = nil
        do {
            let value = persona.trimmingCharacters(in: .whitespacesAndNewlines)
            onSaved(try await save(value.isEmpty ? nil : value))
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Instructions could not be saved.")
        }
        saving = false
    }
}

private struct CompanionRoutineDetailSheet: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    let companionID: String
    let routine: CompanionRoutine
    let canEdit: Bool
    let services: CompanionSettingsServices?
    let onUpdated: (CompanionRoutine) -> Void

    @State private var showingEditor = false
    @State private var store: CompanionRoutineRunListStore?

    var body: some View {
        CompanionSheetCanvas {
            ScrollView {
                VStack(spacing: 22) {
                    CompanionSheetHeader(title: routine.name, leadingStyle: .back) { dismiss() }

                    CompanionSheetCard {
                        CompanionSheetValueRow(
                            title: routine.scheduleDescription,
                            detail: "\(routine.cron) · \(routine.timezone)",
                            value: routine.enabled ? "On" : "Off",
                            symbol: "calendar"
                        )
                        CompanionSheetSeparator(leading: 52)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Prompt")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(CompanionIOSTheme.textPrimary)
                            Text(routine.prompt ?? "No prompt")
                                .font(.system(size: 15))
                                .foregroundStyle(CompanionIOSTheme.textSecondary)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if canEdit {
                            CompanionSheetSeparator()
                            Button { showingEditor = true } label: {
                                CompanionSheetValueRow(title: "Edit routine", symbol: "pencil")
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    runHistory
                }
                .padding(16)
                .padding(.bottom, 28)
            }
        }
        .navigationBarBackButtonHidden(false)
        .toolbar(.hidden, for: .navigationBar)
        .task(id: routine.id) {
            if store == nil {
                store = CompanionRoutineRunListStore { cursor in
                    if let list = services?.listRoutineRuns {
                        return try await list(routine.id, cursor)
                    }
                    return try await sessionStore.listCompanionRoutineRuns(
                        companionID: companionID,
                        routineID: routine.id,
                        cursor: cursor
                    )
                }
            }
            await store?.reload()
        }
        .sheet(isPresented: $showingEditor) {
            CompanionRoutineEditorView(
                initial: routine,
                memberTimezone: sessionStore.memberTimezone ?? MemberTimezone.deviceIdentifier,
                memberTimezoneWasUnset: false,
                saveMemberTimezone: { identifier in
                    let profile = try await sessionStore.updateUserProfile(timezone: identifier)
                    return profile.timezone ?? identifier
                },
                create: { input in
                    try await sessionStore.createCompanionRoutine(companionID: companionID, input: input)
                },
                update: { id, input in
                    let updated: CompanionRoutine
                    if let update = services?.updateRoutine {
                        updated = try await update(id, input)
                    } else {
                        updated = try await sessionStore.updateCompanionRoutine(
                            companionID: companionID,
                            routineID: id,
                            input: input
                        )
                    }
                    onUpdated(updated)
                    return updated
                }
            ) {
                showingEditor = false
            }
        }
    }

    @ViewBuilder
    private var runHistory: some View {
        CompanionSheetSection("Run history") {
            CompanionSheetCard {
                if let store {
                    if store.loading && !store.loaded {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Loading runs…")
                                .foregroundStyle(CompanionIOSTheme.textSecondary)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    } else if let message = store.errorMessage, store.runs.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(message).foregroundStyle(CompanionIOSTheme.textSecondary)
                            Button("Try again") { Task { await store.reload() } }
                        }
                        .font(.system(size: 15))
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    } else if store.runs.isEmpty {
                        Text("No runs yet")
                            .font(.system(size: 15))
                            .foregroundStyle(CompanionIOSTheme.textSecondary)
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        ForEach(Array(store.runs.enumerated()), id: \.element.id) { index, run in
                            if index > 0 { CompanionSheetSeparator() }
                            NavigationLink {
                                CompanionRoutineRunSheet(
                                    companionID: companionID,
                                    run: run,
                                    services: services
                                )
                            } label: {
                                CompanionRoutineRunRow(run: run)
                            }
                            .buttonStyle(.plain)
                        }
                        if store.canLoadMore {
                            CompanionSheetSeparator()
                            Button("Load more") { Task { await store.loadMore() } }
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(CompanionIOSTheme.actionBlue)
                                .frame(maxWidth: .infinity, minHeight: 52)
                        }
                    }
                }
            }
        }
    }
}

private struct CompanionRoutineRunRow: View {
    let run: CompanionRoutineRunSummary

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: statusSymbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(statusColor)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(statusLabel)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                Text(MemberTimezone.formatInstant(run.createdAt, in: nil) ?? run.createdAt)
                    .font(.system(size: 15))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
        }
        .padding(16)
        .frame(minHeight: 64)
        .contentShape(Rectangle())
    }

    private var statusLabel: String {
        switch run.outcome {
        case .surfaced: "Shared in chat"
        case .noOutput: "Completed · No update"
        case .error: "Failed"
        case .pending: run.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized
        case .unknown: "Completed"
        }
    }

    private var statusSymbol: String {
        switch run.outcome {
        case .error: "exclamationmark.circle.fill"
        case .pending: "clock.fill"
        default: "checkmark.circle.fill"
        }
    }

    private var statusColor: Color {
        run.outcome == .error ? Color.red : (run.outcome == .pending ? Color.orange : CompanionIOSTheme.toggleGreen)
    }
}

private struct CompanionRoutineRunSheet: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    let companionID: String
    let run: CompanionRoutineRunSummary
    let services: CompanionSettingsServices?
    @State private var store: CompanionRoutineRunDetailStore?

    var body: some View {
        CompanionSheetCanvas {
            ScrollView {
                VStack(spacing: 20) {
                    CompanionSheetHeader(title: "Routine run", leadingStyle: .back) { dismiss() }
                    CompanionRoutineRunRow(run: run)

                    if let store {
                        if let message = store.errorMessage, store.entries.isEmpty {
                            CompanionErrorNotice(message: message)
                            Button("Try again") { Task { await store.reload() } }
                        }
                        ForEach(store.entries) { entry in
                            CompanionRoutineRunEntryCard(entry: entry)
                        }
                        if store.canLoadMore {
                            Button("Load earlier activity") { Task { await store.loadMore() } }
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(CompanionIOSTheme.actionBlue)
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .background(CompanionIOSTheme.card, in: Capsule())
                        } else if store.loading {
                            ProgressView().padding()
                        }
                    }
                }
                .padding(16)
                .padding(.bottom, 28)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task(id: run.runID) {
            if store == nil {
                store = CompanionRoutineRunDetailStore { cursor in
                    if let detail = services?.routineRun { return try await detail(run.runID, cursor) }
                    return try await sessionStore.readCompanionRoutineRun(
                        companionID: companionID,
                        runID: run.runID,
                        entryCursor: cursor
                    )
                }
            }
            await store?.reload()
        }
    }
}

private struct CompanionRoutineRunEntryCard: View {
    let entry: CompanionRoutineRunEntry

    var body: some View {
        CompanionSheetCard {
            VStack(alignment: .leading, spacing: 8) {
                Label(roleLabel, systemImage: roleSymbol)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                if let tool = entry.tool {
                    Text(tool.title)
                        .font(.system(size: 17, weight: .semibold))
                    if let detail = tool.detail { Text(detail) }
                } else if let decision = entry.decision {
                    Text(decision.title)
                        .font(.system(size: 17, weight: .semibold))
                    if let detail = decision.detail { Text(detail) }
                } else if !entry.content.isEmpty {
                    Text(entry.content)
                }
                if let reasoning = entry.reasoning, !reasoning.isEmpty {
                    Text(reasoning)
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                }
            }
            .font(.system(size: 15))
            .foregroundStyle(CompanionIOSTheme.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
    }

    private var roleLabel: String { entry.role.capitalized }
    private var roleSymbol: String {
        switch entry.role {
        case "user": "person"
        case "assistant": "sparkles"
        case "system": "gearshape"
        case "tool": "wrench.and.screwdriver"
        case "decision": "checkmark.shield"
        default: "circle"
        }
    }
}
