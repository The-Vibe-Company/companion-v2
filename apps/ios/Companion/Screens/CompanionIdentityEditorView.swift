import SwiftUI
import CompanionKit

struct CompanionIdentityEditorView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let companion: CompanionSummary
    let onSaved: (CompanionSummary) -> Void
    private let updateCompanion: ((String, UpdateCompanionInput) async throws -> CompanionSummary)?

    @State private var name: String
    @State private var instructions: String
    @State private var icon: CompanionSummary.Icon
    @State private var saving = false
    @State private var error: String?

    init(
        companion: CompanionSummary,
        onSaved: @escaping (CompanionSummary) -> Void,
        updateCompanion: ((String, UpdateCompanionInput) async throws -> CompanionSummary)? = nil
    ) {
        self.companion = companion
        self.onSaved = onSaved
        self.updateCompanion = updateCompanion
        _name = State(initialValue: companion.name)
        _instructions = State(initialValue: companion.persona ?? "")
        _icon = State(initialValue: companion.icon ?? .init(shape: 1, mouth: 1, accessory: 1, color: 2))
    }

    var body: some View {
        CompanionBackdrop {
            ScrollView {
                VStack(spacing: 14) {
                    if let error {
                        CompanionErrorNotice(message: error)
                    }

                    identityCard
                    iconCard
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .navigationTitle("Edit identity")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") {
                    Task { await save() }
                }
                .disabled(!canSave)
                .accessibilityIdentifier("companion.identity.save")
            }
        }
        .onChange(of: name) { enforceNameLimit() }
        .onChange(of: instructions) { enforceInstructionsLimit() }
    }

    private var identityCard: some View {
        CompanionManagementCard("Identity") {
            HStack(spacing: 16) {
                CompanionAvatar(name: displayName, icon: icon, size: 80, state: .still)
                    .accessibilityLabel("Preview for \(displayName)")

                VStack(alignment: .leading, spacing: 3) {
                    Text(displayName)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.companionInk)
                    Text("Name and instructions are applied together when you save.")
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            CompanionFieldLabel("Name")
            TextField("Companion name", text: $name)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .padding(14)
                .companionMaterial(radius: 16)
                .disabled(saving)
                .accessibilityIdentifier("companion.identity.name")

            CompanionFieldLabel(
                "Instructions",
                detail: "Applied after active work settles and before the next turn starts."
            )
            TextField("What this Companion is for", text: $instructions, axis: .vertical)
                .lineLimit(3...6)
                .padding(14)
                .companionMaterial(radius: 16)
                .disabled(saving)
                .accessibilityIdentifier("companion.identity.instructions")
        }
    }

    private var iconCard: some View {
        CompanionManagementCard("Icon") {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 12) {
                    iconPickerDetail
                    Spacer(minLength: 8)
                    randomizeButton
                }

                VStack(alignment: .leading, spacing: 10) {
                    iconPickerDetail
                    randomizeButton
                }
            }

            CharacterPicker(
                selection: $icon,
                defaultSelection: companion.icon ?? .init(shape: 1, mouth: 1, accessory: 1, color: 2),
                accessibilityIdentifierPrefix: "companion.identity.icon"
            )
            .disabled(saving)
        }
    }

    private var iconPickerDetail: some View {
        Text("Every choice in the Companion icon catalog is shown below.")
            .font(.subheadline)
            .foregroundStyle(Color.companionMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var randomizeButton: some View {
        Button("Surprise me", systemImage: "dice.fill") {
            randomizeIcon()
        }
        .buttonStyle(.glass)
        .disabled(saving)
        .accessibilityIdentifier("companion.identity.randomize-icon")
    }

    private var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? companion.name : trimmed
    }

    private var normalizedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var normalizedInstructions: String? {
        let value = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private var changed: Bool {
        normalizedName != companion.name
            || normalizedInstructions != companion.persona
            || icon != companion.icon
    }

    private var canSave: Bool {
        !saving
            && changed
            && !normalizedName.isEmpty
            && companion.runtime.providerIDs.first != nil
            && companion.modelID != nil
    }

    private func save() async {
        guard canSave,
              let providerID = companion.runtime.providerIDs.first,
              let modelID = companion.modelID else { return }

        saving = true
        error = nil
        let input = UpdateCompanionInput(
            name: normalizedName,
            persona: normalizedInstructions,
            providerID: providerID,
            modelID: modelID,
            icon: icon
        )

        do {
            let response: CompanionSummary
            if let updateCompanion {
                response = try await updateCompanion(companion.id, input)
            } else {
                response = try await sessionStore.updateCompanion(
                    companionID: companion.id,
                    input: input
                )
            }
            let updated = response.preservingListProjection(from: companion)
            onSaved(updated)
            dismiss()
        } catch {
            self.error = companionDisplayMessage(
                error,
                fallback: "The Companion identity could not be saved."
            )
        }
        saving = false
    }

    private func randomizeIcon() {
        let updated = CompanionSummary.Icon(
            shape: .random(in: 0..<8),
            mouth: .random(in: 0..<5),
            accessory: .random(in: 0..<7),
            color: .random(in: 0..<11)
        )
        if reduceMotion {
            icon = updated
        } else {
            withAnimation(.easeOut(duration: 0.18)) {
                icon = updated
            }
        }
    }

    private func enforceNameLimit() {
        if name.count > 120 { name = String(name.prefix(120)) }
    }

    private func enforceInstructionsLimit() {
        if instructions.count > 280 { instructions = String(instructions.prefix(280)) }
    }
}
