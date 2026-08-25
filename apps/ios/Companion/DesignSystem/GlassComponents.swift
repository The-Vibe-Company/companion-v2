import SwiftUI
import CompanionKit

struct CompanionBackdrop<Content: View>: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ZStack {
            Color.companionCanvas
                .ignoresSafeArea()

            if !reduceTransparency {
                GeometryReader { geometry in
                    Circle()
                        .fill(Color.companionAccent.opacity(0.18))
                        .frame(width: geometry.size.width * 0.86)
                        .blur(radius: 68)
                        .offset(x: -geometry.size.width * 0.34, y: -geometry.size.height * 0.18)

                    Circle()
                        .fill(Color.companionAccentGold.opacity(0.20))
                        .frame(width: geometry.size.width * 0.72)
                        .blur(radius: 72)
                        .offset(x: geometry.size.width * 0.52, y: geometry.size.height * 0.18)

                    Circle()
                        .fill(Color(red: 0.34, green: 0.62, blue: 1).opacity(0.15))
                        .frame(width: geometry.size.width * 0.92)
                        .blur(radius: 84)
                        .offset(x: -geometry.size.width * 0.18, y: geometry.size.height * 0.72)
                }
                .ignoresSafeArea()
                .accessibilityHidden(true)
            }

            content
        }
    }
}

extension View {
    func companionGlass(
        radius: CGFloat,
        tint: Color? = nil,
        interactive: Bool = false
    ) -> some View {
        modifier(CompanionGlassModifier(radius: radius, tint: tint, interactive: interactive))
    }

    func companionMaterial(radius: CGFloat) -> some View {
        modifier(CompanionMaterialModifier(radius: radius))
    }
}

private struct CompanionGlassModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let radius: CGFloat
    let tint: Color?
    let interactive: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content
                .background(
                    tint?.opacity(0.16) ?? Color.white,
                    in: RoundedRectangle(cornerRadius: radius, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .stroke(Color.black.opacity(0.10), lineWidth: 0.7)
                }
        } else {
            let base = Glass.regular.tint(tint)
            content.glassEffect(
                interactive ? base.interactive() : base,
                in: .rect(cornerRadius: radius)
            )
        }
    }
}

private struct CompanionMaterialModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let radius: CGFloat

    func body(content: Content) -> some View {
        content
            .background(
                reduceTransparency ? AnyShapeStyle(Color.white) : AnyShapeStyle(.ultraThinMaterial),
                in: RoundedRectangle(cornerRadius: radius, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(reduceTransparency ? Color.black.opacity(0.10) : Color.companionBorder, lineWidth: 0.7)
            }
    }
}

struct CompanionStatusBadge: View {
    let runtime: CompanionSummary.Runtime
    var compact = false

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
            Text(label)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(Color.companionInk.opacity(0.78))
        .padding(.horizontal, compact ? 8 : 10)
        .padding(.vertical, compact ? 5 : 6)
        .background(.thinMaterial, in: Capsule())
        .overlay { Capsule().stroke(Color.companionBorder, lineWidth: 0.6) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Box, \(label.lowercased())")
    }

    var label: String {
        if runtime.replying { return "Replying" }
        switch runtime.state {
        case .running: return "Online"
        case .provisioning: return "Starting"
        case .error: return "Error"
        case .notCreated, .stopped, .stopping: return "Asleep"
        case .unknown: return "Unknown"
        }
    }

    private var statusColor: Color {
        if runtime.replying { return .companionAccent }
        switch runtime.state {
        case .running: return .companionSuccess
        case .provisioning: return .companionWarning
        case .error: return .companionDanger
        case .notCreated, .stopped, .stopping, .unknown: return .companionMuted
        }
    }
}
