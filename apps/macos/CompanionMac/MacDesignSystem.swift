import AppKit
import CompanionKit
import SwiftUI

enum CompanionMacMetrics {
    static let space: CGFloat = 4
    static let sidebarWidth: CGFloat = 300
    static let inspectorWidth: CGFloat = 360
    static let transcriptMaxWidth: CGFloat = 720
}

extension Color {
    /// CompanionKit owns the approved Grok Bot palette for both native clients.
    static let companionMacCanvas = CompanionIOSTheme.canvas
    static let companionMacSurface = CompanionIOSTheme.card
    static let companionMacRaised = CompanionIOSTheme.botBubble
    static let companionMacInner = CompanionIOSTheme.innerBubble
    static let companionMacInk = CompanionIOSTheme.textPrimary
    static let companionMacMuted = CompanionIOSTheme.textSecondary
    static let companionMacDivider = CompanionIOSTheme.separator
    static let companionMacAccent = CompanionIOSTheme.actionBlue
    static let companionMacAccentForeground = CompanionIOSTheme.primaryCTAText
    static let companionMacSuccess = CompanionIOSTheme.toggleGreen
    static let companionMacWarning = CompanionIOSTheme.warning
    static let companionMacDanger = CompanionIOSTheme.danger
    static let companionMacUnknown = CompanionIOSTheme.textSecondary
}

struct CompanionMacSurface<Content: View>: View {
    let content: Content
    var padding: CGFloat = CompanionMacMetrics.space * 4

    init(
        padding: CGFloat = CompanionMacMetrics.space * 4,
        @ViewBuilder content: () -> Content
    ) {
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        content
            .padding(padding)
            .background(Color.companionMacSurface)
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.companionMacDivider, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct CompanionMacStatusBadge: View {
    let runtime: CompanionSummary.Runtime

    var body: some View {
        HStack(spacing: CompanionMacMetrics.space * 1.5) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(label)
                .font(.callout.weight(.medium))
        }
        .foregroundStyle(Color.companionMacInk)
        .padding(.horizontal, CompanionMacMetrics.space * 2)
        .padding(.vertical, CompanionMacMetrics.space)
        .background(Color.companionMacRaised, in: Capsule())
        .overlay(Capsule().stroke(Color.companionMacDivider, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Box, \(label.lowercased())")
    }

    private var label: String {
        if runtime.replying { return "Replying" }
        switch runtime.state {
        case .running: return "Online"
        case .provisioning: return "Starting"
        case .stopping: return "Stopping"
        case .error: return "Error"
        case .notCreated, .stopped: return "Asleep"
        case .unknown: return "Unknown"
        }
    }

    private var color: Color {
        switch CompanionStatusIndicatorState(runtime: runtime).tint {
        case .live: return .companionMacSuccess
        case .inactive: return .companionMacUnknown
        case .error: return .companionMacDanger
        }
    }
}

struct CompanionMacErrorNotice: View {
    let message: String

    var body: some View {
        Label {
            Text(message)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .font(.callout)
        .foregroundStyle(Color.companionMacDanger)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(CompanionMacMetrics.space * 3)
        .background(Color.companionMacDanger.opacity(0.10), in: RoundedRectangle(cornerRadius: 6))
        .overlay {
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.companionMacDanger.opacity(0.32), lineWidth: 1)
        }
        .accessibilityLabel("Error: \(message)")
    }
}

struct CompanionMacAvatar: View {
    let name: String
    let icon: CompanionSummary.Icon?
    var size: CGFloat = 44
    var thinking = false

    var body: some View {
        CharacterMark(name: name, icon: icon, size: size)
    }
}

extension View {
    func companionMacFocusRing(_ focused: Bool) -> some View {
        overlay {
            if focused {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(Color.companionMacAccent, lineWidth: 2)
                    .padding(-2)
            }
        }
    }
}

func companionMacErrorMessage(_ error: Error, fallback: String) -> String {
    if let apiError = error as? APIError, !apiError.message.isEmpty {
        return apiError.message
    }
    return fallback
}
