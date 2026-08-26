import SwiftUI
import CompanionKit

@MainActor
struct CompanionConnectedResourcesServices {
    let load: () async throws -> CompanionConnectedResources
}

struct CompanionConnectedResourcesView: View {
    @Environment(SessionStore.self) private var sessionStore
    let companion: CompanionSummary
    private let services: CompanionConnectedResourcesServices?
    @State private var resources: CompanionConnectedResources?
    @State private var loading = true
    @State private var error: String?
    @State private var loadGeneration = 0

    init(
        companion: CompanionSummary,
        services: CompanionConnectedResourcesServices? = nil
    ) {
        self.companion = companion
        self.services = services
    }

    var body: some View {
        CompanionBackdrop(style: .companion(visualTheme.base)) {
            Group {
                if loading, resources == nil {
                    loadingState
                } else if let error, resources == nil {
                    errorState(error)
                } else if let resources {
                    resourceList(resources)
                }
            }
        }
        .navigationTitle("Connected resources")
        .navigationBarTitleDisplayMode(.inline)
        .tint(visualTheme.accent)
        .task(id: companion.id) { await load() }
        .accessibilityIdentifier("companion.resources")
    }

    private func resourceList(_ resources: CompanionConnectedResources) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                header
                if let error {
                    CompanionErrorNotice(message: error)
                }
                resourceSection(
                    title: "Skills",
                    symbol: "shippingbox",
                    count: companion.selectedSkillIDs.count
                ) {
                    if companion.selectedSkillIDs.isEmpty {
                        emptyRow(
                            title: "No Skills connected",
                            detail: "Attached Skills will appear here.",
                            identifier: "companion.resources.skills.empty"
                        )
                    } else {
                        ForEach(Array(resources.skills.enumerated()), id: \.element.id) { index, skill in
                            if index > 0 { resourceDivider }
                            skillRow(skill)
                        }
                        if resources.hiddenSkillCount > 0 {
                            if !resources.skills.isEmpty { resourceDivider }
                            hiddenSkillsRow(count: resources.hiddenSkillCount)
                        }
                    }
                }

                resourceSection(
                    title: "Routines",
                    symbol: "clock",
                    count: resources.routines.count
                ) {
                    if resources.routines.isEmpty {
                        emptyRow(
                            title: "No routines connected",
                            detail: "Scheduled prompts will appear here.",
                            identifier: "companion.resources.routines.empty"
                        )
                    } else {
                        ForEach(Array(resources.routines.enumerated()), id: \.element.id) { index, routine in
                            if index > 0 { resourceDivider }
                            routineRow(routine)
                        }
                    }
                }

                resourceSection(
                    title: "Triggers",
                    symbol: "bolt",
                    count: resources.triggers.count
                ) {
                    if resources.triggers.isEmpty {
                        emptyRow(
                            title: "No triggers connected",
                            detail: "Webhook prompts will appear here.",
                            identifier: "companion.resources.triggers.empty"
                        )
                    } else {
                        ForEach(Array(resources.triggers.enumerated()), id: \.element.id) { index, trigger in
                            if index > 0 { resourceDivider }
                            triggerRow(trigger)
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 30)
        }
        .refreshable { await load() }
        .scrollIndicators(.hidden)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 13) {
            CompanionAvatar(name: companion.name, icon: companion.icon, size: 48, state: .still)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(companion.name)
                    .font(.headline)
                    .foregroundStyle(Color.companionInk)
                Text("Resources available when this Companion works.")
                    .font(.subheadline)
                    .foregroundStyle(Color.companionMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func resourceSection<Content: View>(
        title: String,
        symbol: String,
        count: Int,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Label(title, systemImage: symbol)
                    .font(.headline)
                    .foregroundStyle(Color.companionInk)
                Spacer()
                Text("\(count)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(Color.companionMuted)
                    .accessibilityLabel("\(count) \(title.lowercased())")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .accessibilityAddTraits(.isHeader)

            Divider()
                .overlay(Color.companionDivider)

            content()
        }
        .companionMaterial(radius: 12)
    }

    private func skillRow(_ skill: CompanionSkillSummary) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(skill.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                if skill.displayName != skill.slug {
                    Text(skill.slug)
                        .font(.caption.monospaced())
                        .foregroundStyle(Color.companionMuted)
                        .textSelection(.enabled)
                }
                Text(skill.description.isEmpty ? "No description provided." : skill.description)
                    .font(.footnote)
                    .foregroundStyle(Color.companionMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            statusBadge(.active, activeLabel: "Enabled")
        }
        .padding(16)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(skill.displayName). \(skill.description.isEmpty ? "No description provided." : skill.description). Enabled")
        .accessibilityIdentifier("companion.resources.skill.\(skill.id)")
    }

    private func hiddenSkillsRow(count: Int) -> some View {
        Label(
            "\(count) selected \(count == 1 ? "Skill is" : "Skills are") not visible to you.",
            systemImage: "eye.slash"
        )
        .font(.footnote)
        .foregroundStyle(Color.companionMuted)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .accessibilityIdentifier("companion.resources.skills.hidden")
    }

    private func routineRow(_ routine: CompanionRoutine) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(routine.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                Text(routine.scheduleDescription)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.companionInk.opacity(0.82))
                HStack(spacing: 7) {
                    Text(routine.cron)
                        .font(.caption.monospaced())
                    Text("·")
                    Text(routine.timezone)
                        .font(.caption)
                }
                .foregroundStyle(Color.companionMuted)
                .fixedSize(horizontal: false, vertical: true)
                if let message = routine.lastErrorMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(Color.companionDanger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            statusBadge(routine.status)
        }
        .padding(16)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(routine.name). \(routine.scheduleDescription). \(routine.timezone). \(routine.status.label)"
        )
        .accessibilityIdentifier("companion.resources.routine.\(routine.id)")
    }

    private func triggerRow(_ trigger: CompanionTrigger) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(trigger.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                Text(trigger.providerName)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.companionInk.opacity(0.82))
                Text(trigger.registrationDescription)
                    .font(.caption)
                    .foregroundStyle(
                        trigger.registrationStatus == .failed
                            ? Color.companionDanger
                            : Color.companionMuted
                    )
                if let message = trigger.lastErrorMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(Color.companionDanger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            statusBadge(trigger.status)
        }
        .padding(16)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(trigger.name). \(trigger.providerName). \(trigger.registrationDescription). \(trigger.status.label)"
        )
        .accessibilityIdentifier("companion.resources.trigger.\(trigger.id)")
    }

    private func statusBadge(
        _ status: CompanionConnectedResourceStatus,
        activeLabel: String? = nil
    ) -> some View {
        let label = status == .active ? activeLabel ?? status.label : status.label
        return HStack(spacing: 5) {
            Circle()
                .fill(statusColor(status))
                .frame(width: 7, height: 7)
            Text(label)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(Color.companionInk.opacity(0.80))
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(statusColor(status).opacity(0.10), in: Capsule())
        .accessibilityElement(children: .combine)
    }

    private func statusColor(_ status: CompanionConnectedResourceStatus) -> Color {
        switch status {
        case .active: .companionSuccess
        case .disabled: .companionMuted
        case .error: .companionDanger
        }
    }

    private func emptyRow(title: String, detail: String, identifier: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.companionInk)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(Color.companionMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }

    private var resourceDivider: some View {
        Divider()
            .overlay(Color.companionDivider)
            .padding(.leading, 16)
    }

    private var loadingState: some View {
        ScrollView {
            VStack(spacing: 22) {
                ForEach(0..<3, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Connected resources")
                            .font(.headline)
                        Text("Resource name")
                        Text("Resource details available here")
                            .font(.footnote)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .companionMaterial(radius: 12)
                }
            }
            .padding(16)
            .redacted(reason: .placeholder)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Loading connected resources")
        }
    }

    private func errorState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Resources unavailable", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try again") { Task { await load() } }
                .buttonStyle(.glassProminent)
        }
        .padding(24)
    }

    private var visualTheme: CompanionVisualTheme {
        CompanionVisualTheme(icon: companion.icon)
    }

    private func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        if resources == nil { loading = true }
        do {
            let next: CompanionConnectedResources
            if let services {
                next = try await services.load()
            } else {
                next = try await sessionStore.connectedResources(for: companion)
            }
            guard !Task.isCancelled, generation == loadGeneration else { return }
            resources = next
            error = nil
        } catch {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            self.error = "Connected resources could not be refreshed. Check your connection and try again."
        }
        if generation == loadGeneration { loading = false }
    }
}

#if DEBUG
struct CompanionConnectedResourcesDemoView: View {
    var body: some View {
        NavigationStack {
            CompanionConnectedResourcesView(
                companion: CompanionConnectedResourcesDemoFixtures.companion,
                services: .init(load: { CompanionConnectedResourcesDemoFixtures.resources })
            )
        }
    }
}

@MainActor
enum CompanionConnectedResourcesDemoFixtures {
    static var companion: CompanionSummary {
        let selectedSkillIDs = ProcessInfo.processInfo.environment["COMPANION_RESOURCES_DEMO_EMPTY"] == "skills"
            ? "[]"
            : #"["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"]"#
        return decode(#"""
        {
          "id":"c96ab360-00f3-4497-a51a-51442db8add1",
          "name":"Luna",
          "persona":"Keep releases calm",
          "model_id":"claude-sonnet",
          "selected_skill_ids":\#(selectedSkillIDs),
          "icon":{"shape":6,"mouth":1,"accessory":6,"color":2},
          "access":"viewer",
          "hidden":false,
          "unread":false,
          "last_message":null,
          "runtime":{"state":"running","replying":false,"last_error":null}
        }
        """#)
    }

    static var resources: CompanionConnectedResources {
        let emptySection = ProcessInfo.processInfo.environment["COMPANION_RESOURCES_DEMO_EMPTY"]
        return CompanionConnectedResources(
            skills: emptySection == "skills" ? [] : [decode(#"""
            {
              "id":"11111111-1111-4111-8111-111111111111",
              "slug":"incident-summary",
              "display":{"name":"Incident Summary"},
              "description":"Summarizes incidents into concise operational updates."
            }
            """#)],
            hiddenSkillCount: emptySection == "skills" ? 0 : 1,
            routines: emptySection == "routines" ? [] : [decode(#"""
            {
              "id":"33333333-3333-4333-8333-333333333333",
              "name":"Weekday brief",
              "cron":"0 9 * * 1-5",
              "timezone":"America/New_York",
              "enabled":true,
              "next_fire_at":"2026-08-27T13:00:00.000Z",
              "last_error_message":null
            }
            """#)],
            triggers: emptySection == "triggers" ? [] : [decode(#"""
            {
              "id":"44444444-4444-4444-8444-444444444444",
              "name":"Pull request opened",
              "provider":"github",
              "registration_status":"registered",
              "enabled":true,
              "last_error_message":null
            }
            """#)]
        )
    }

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        try! JSONDecoder().decode(Value.self, from: Data(json.utf8))
    }
}
#endif
