import SwiftUI
import UIKit

/// Presentation-only accessibility feedback for message actions. Clipboard contents stay in the
/// system pasteboard; SwiftUI's `sensoryFeedback` modifier owns haptics at each action's state
/// boundary.
@MainActor
enum CompanionMessageInteractionFeedback {
    static func announce(_ message: String) {
        UIAccessibility.post(notification: .announcement, argument: message)
    }
}

private enum CompanionMessageInteractionSheet: Identifiable {
    case share(String)
    case selectText(String)

    var id: String {
        switch self {
        case .share: return "share"
        case .selectText: return "select-text"
        }
    }
}

/// Adds the common long-press actions to a rendered message while leaving the message's own
/// inline text-selection behavior in place. The selectable sheet is deliberately raw text: it
/// gives a reliable native selection surface for rich Markdown without changing the transcript.
struct CompanionMessageInteractionModifier: ViewModifier {
    let rawContent: String

    @State private var presentedSheet: CompanionMessageInteractionSheet?
    @State private var copyFeedbackTrigger = 0
    @State private var shareFeedbackTrigger = 0

    func body(content: Content) -> some View {
        content
            .contentShape(.rect)
            .contextMenu {
                Button {
                    copyMessage()
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }

                Button {
                    shareFeedbackTrigger &+= 1
                    presentedSheet = .share(rawContent)
                } label: {
                    Label("Share", systemImage: "square.and.arrow.up")
                }

                Button {
                    presentedSheet = .selectText(rawContent)
                } label: {
                    Label("Select Text", systemImage: "selection.pin.in.out")
                }
            }
            .sensoryFeedback(.success, trigger: copyFeedbackTrigger)
            .sensoryFeedback(.impact(weight: .light), trigger: shareFeedbackTrigger)
            .sheet(item: $presentedSheet) { sheet in
                switch sheet {
                case .share(let content):
                    CompanionActivityView(activityItems: [content])
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                        .accessibilityIdentifier("chat.share-sheet")
                case .selectText(let content):
                    CompanionSelectableMessageView(content: content)
                }
            }
        }

    private func copyMessage() {
        UIPasteboard.general.string = rawContent
        copyFeedbackTrigger &+= 1
        CompanionMessageInteractionFeedback.announce("Message copied")
    }
}

extension View {
    /// Adds Copy, Share, and Select Text to the native long-press menu for a message.
    func companionMessageInteractionMenu(rawContent: String) -> some View {
        modifier(CompanionMessageInteractionModifier(rawContent: rawContent))
    }
}

private struct CompanionActivityView: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) { }
}

private struct CompanionSelectableMessageView: View {
    @Environment(\.dismiss) private var dismiss
    let content: String

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(content)
                    .font(.body)
                    .foregroundStyle(Color.companionInk)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
            }
            .background(Color.companionCanvas)
            .navigationTitle("Select text")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .accessibilityIdentifier("chat.select-text.surface")
        }
    }
}
