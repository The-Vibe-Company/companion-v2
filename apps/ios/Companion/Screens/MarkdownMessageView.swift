import SwiftUI
import CompanionKit
import UIKit

struct MarkdownDocument: Equatable, Sendable {
    let blocks: [MarkdownNode]
    let containsInteractiveLink: Bool

    init(markdown source: String) {
        do {
            let parsed = try AttributedString(
                markdown: source,
                options: .init(
                    interpretedSyntax: .full,
                    failurePolicy: .returnPartiallyParsedIfPossible
                )
            )
            let tree = MarkdownTreeBuilder.document(from: parsed)
            let renderedBlocks = tree.isEmpty ? [MarkdownNode.plainText(source)] : tree
            blocks = renderedBlocks
            containsInteractiveLink = renderedBlocks.contains(where: \.containsInteractiveLink)
        } catch {
            let fallback = MarkdownNode.plainText(source)
            blocks = [fallback]
            containsInteractiveLink = fallback.containsInteractiveLink
        }
    }
}

struct MarkdownDocumentSource: Equatable, Hashable, Sendable {
    let eventID: String
    let content: String
}

struct CachedMarkdownDocument: Sendable {
    let source: String
    let document: MarkdownDocument
}

enum MarkdownDocumentRenderer {
    static func render(
        sources: [MarkdownDocumentSource],
        reusing cachedDocuments: [String: CachedMarkdownDocument]
    ) async -> [String: CachedMarkdownDocument] {
        var rendered: [String: CachedMarkdownDocument] = [:]
        var pending: [MarkdownDocumentSource] = []

        for source in sources {
            if let cached = cachedDocuments[source.eventID], cached.source == source.content {
                rendered[source.eventID] = cached
            } else {
                pending.append(source)
            }
        }

        guard !pending.isEmpty else { return rendered }

        let sourcesToRender = pending
        let newlyRendered = await withTaskGroup(
            of: [String: CachedMarkdownDocument].self,
            returning: [String: CachedMarkdownDocument].self
        ) { group in
            group.addTask { [sourcesToRender] in
                var documents: [String: CachedMarkdownDocument] = [:]
                for source in sourcesToRender {
                    guard !Task.isCancelled else { break }
                    documents[source.eventID] = CachedMarkdownDocument(
                        source: source.content,
                        document: MarkdownDocument(markdown: source.content)
                    )
                }
                return documents
            }

            return await group.next() ?? [:]
        }

        for (eventID, document) in newlyRendered {
            rendered[eventID] = document
        }
        return rendered
    }
}

struct MarkdownNode: Identifiable, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case paragraph
        case heading(level: Int)
        case orderedList
        case unorderedList
        case listItem(ordinal: Int)
        case codeBlock(language: String?)
        case blockQuote
        case thematicBreak
        case table(columns: [TableAlignment])
        case tableHeaderRow
        case tableRow(index: Int)
        case tableCell(column: Int)
    }

    enum TableAlignment: Equatable, Sendable {
        case leading
        case center
        case trailing
    }

    let id: Int
    let kind: Kind
    let content: AttributedString
    let children: [MarkdownNode]

    static func plainText(_ source: String) -> MarkdownNode {
        MarkdownNode(
            id: -1,
            kind: .paragraph,
            content: AttributedString(source),
            children: []
        )
    }

    var containsInteractiveLink: Bool {
        content.containsInteractiveLink || children.contains(where: \.containsInteractiveLink)
    }
}

private extension AttributedString {
    var containsInteractiveLink: Bool {
        runs.contains { run in
            if run.link.map(CompanionLinkPolicy.isAllowed) == true { return true }
            guard run.inlinePresentationIntent?.contains(.code) != true else { return false }
            return !CompanionMessageLinkDetector.detect(
                in: String(self[run.range].characters)
            ).isEmpty
        }
    }
}

struct MarkdownMessageView: View {
    let document: MarkdownDocument
    let foreground: Color
    let linkColor: Color
    let allowsTextSelection: Bool

    init(
        document: MarkdownDocument,
        foreground: Color = CompanionIOSTheme.textPrimary,
        linkColor: Color = CompanionIOSTheme.linkBlue,
        allowsTextSelection: Bool = true
    ) {
        self.document = document
        self.foreground = foreground
        self.linkColor = linkColor
        self.allowsTextSelection = allowsTextSelection
    }

    var body: some View {
        Group {
            if allowsTextSelection {
                MarkdownNodesView(
                    nodes: document.blocks,
                    foreground: foreground,
                    linkColor: linkColor
                )
                    .textSelection(.enabled)
            } else {
                MarkdownNodesView(
                    nodes: document.blocks,
                    foreground: foreground,
                    linkColor: linkColor
                )
            }
        }
        .tint(linkColor)
        .environment(
                \.openURL,
                OpenURLAction { url in
                    switch CompanionLinkPolicy.route(for: url) {
                    case .system, .conductor:
                        CompanionMessageLinkActions.open(url)
                        return .handled
                    case .blocked:
                        return .discarded
                    }
                }
            )
    }
}

private struct MarkdownNodesView: View {
    let nodes: [MarkdownNode]
    let foreground: Color
    let linkColor: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(nodes) { node in
                MarkdownNodeView(
                    node: node,
                    foreground: foreground,
                    linkColor: linkColor
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MarkdownNodeView: View {
    let node: MarkdownNode
    let foreground: Color
    let linkColor: Color

    @ViewBuilder
    var body: some View {
        switch node.kind {
        case .paragraph:
            MarkdownParagraphView(
                content: node.content,
                foreground: foreground,
                linkColor: linkColor
            )

        case .heading(let level):
            MarkdownText(
                content: node.content,
                foreground: foreground,
                linkColor: linkColor,
                typography: .heading(level)
            )
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("markdown.heading.\(node.id)")

        case .orderedList:
            MarkdownListView(
                node: node,
                ordered: true,
                foreground: foreground,
                linkColor: linkColor
            )
                .accessibilityIdentifier("markdown.list.\(node.id)")

        case .unorderedList:
            MarkdownListView(
                node: node,
                ordered: false,
                foreground: foreground,
                linkColor: linkColor
            )
                .accessibilityIdentifier("markdown.list.\(node.id)")

        case .listItem:
            MarkdownNodesView(
                nodes: node.children,
                foreground: foreground,
                linkColor: linkColor
            )

        case .codeBlock(let language):
            MarkdownCodeBlock(
                code: String(node.content.characters),
                language: language,
                identifier: node.id
            )

        case .blockQuote:
            HStack(alignment: .top, spacing: 10) {
                Rectangle()
                    .fill(CompanionIOSTheme.separator)
                    .frame(width: 2)
                    .accessibilityHidden(true)
                MarkdownNodesView(
                    nodes: node.children,
                    foreground: foreground,
                    linkColor: linkColor
                )
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
            }
            .accessibilityIdentifier("markdown.quote.\(node.id)")

        case .thematicBreak:
            Divider()
                .overlay(CompanionIOSTheme.separator)
                .accessibilityLabel("Section break")
                .accessibilityIdentifier("markdown.divider.\(node.id)")

        case .table:
            MarkdownTableView(
                node: node,
                foreground: foreground,
                linkColor: linkColor
            )
                .accessibilityIdentifier("markdown.table.\(node.id)")

        case .tableHeaderRow, .tableRow, .tableCell:
            MarkdownNodesView(
                nodes: node.children,
                foreground: foreground,
                linkColor: linkColor
            )
        }
    }
}

private struct MarkdownParagraphView: View {
    let content: AttributedString
    let foreground: Color
    let linkColor: Color

    var body: some View {
        if let link = standaloneLink {
            Link(destination: link) {
                HStack(spacing: 12) {
                    Image(systemName: "link")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(linkColor)
                        .frame(width: 36, height: 36)
                        .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 12))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(linkTitle)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(CompanionIOSTheme.textPrimary)
                            .lineLimit(2)

                        Text(linkDomain(for: link))
                            .font(.subheadline)
                            .foregroundStyle(CompanionIOSTheme.textSecondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 4)

                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                }
                .padding(12)
                .background(
                    CompanionIOSTheme.innerBubble,
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
                .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open \(linkTitle), \(linkDomain(for: link))")
            .contextMenu {
                Button("Open", systemImage: "arrow.up.right.square") {
                    CompanionMessageLinkActions.open(link)
                }
                Button("Copy", systemImage: "doc.on.doc") {
                    CompanionMessageLinkActions.copy(link)
                }
            }
        } else {
            MarkdownText(
                content: content,
                foreground: foreground,
                linkColor: linkColor,
                typography: .body
            )
                .lineSpacing(3)
        }
    }

    private var standaloneLink: URL? {
        let visibleText = String(content.characters)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !visibleText.isEmpty else { return nil }

        var linkedText = ""
        var links: [URL] = []
        for run in content.runs {
            guard let link = run.link else { continue }
            linkedText += String(content[run.range].characters)
            links.append(link)
        }

        guard let firstLink = links.first,
              links.allSatisfy({ $0 == firstLink }),
              linkedText.trimmingCharacters(in: .whitespacesAndNewlines) == visibleText
        else {
            return nil
        }
        return firstLink
    }

    private var linkTitle: String {
        String(content.characters).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func linkDomain(for link: URL) -> String {
        link.host ?? link.scheme?.uppercased() ?? "Link"
    }
}

private struct MarkdownText: View {
    let content: AttributedString
    let foreground: Color
    let linkColor: Color
    var typography: MarkdownInlineTypography = .body
    var textAlignment: TextAlignment = .leading

    var body: some View {
        text
            .foregroundStyle(foreground)
            .tint(linkColor)
            .multilineTextAlignment(textAlignment)
    }

    @ViewBuilder
    private var text: some View {
        if containsLink {
            MarkdownLinkedTextView(
                content: content,
                foreground: foreground,
                linkColor: linkColor,
                typography: typography,
                textAlignment: textAlignment
            )
        } else {
            Text(content)
                .font(typography.font)
        }
    }

    private var containsLink: Bool {
        content.containsInteractiveLink
    }
}

private enum MarkdownInlineTypography {
    case body
    case heading(Int)
    case tableHeader
    case tableBody

    var font: Font {
        switch self {
        case .body: return .body
        case .heading(1): return .title2.weight(.semibold)
        case .heading(2): return .title3.weight(.semibold)
        case .heading(3): return .headline.weight(.semibold)
        case .heading(4): return .body.weight(.semibold)
        case .heading: return .subheadline.weight(.semibold)
        case .tableHeader: return .subheadline.weight(.semibold)
        case .tableBody: return .subheadline
        }
    }

    @MainActor
    var uiFont: UIFont {
        switch self {
        case .body:
            return .preferredFont(forTextStyle: .body)
        case .heading(1):
            return .preferredFont(forTextStyle: .title2).withWeight(.semibold)
        case .heading(2):
            return .preferredFont(forTextStyle: .title3).withWeight(.semibold)
        case .heading(3):
            return .preferredFont(forTextStyle: .headline).withWeight(.semibold)
        case .heading(4):
            return .preferredFont(forTextStyle: .body).withWeight(.semibold)
        case .heading:
            return .preferredFont(forTextStyle: .subheadline).withWeight(.semibold)
        case .tableHeader:
            return .preferredFont(forTextStyle: .subheadline).withWeight(.semibold)
        case .tableBody:
            return .preferredFont(forTextStyle: .subheadline)
        }
    }
}

private struct MarkdownLinkedTextView: UIViewRepresentable {
    let content: AttributedString
    let foreground: Color
    let linkColor: Color
    let typography: MarkdownInlineTypography
    let textAlignment: TextAlignment

    @Environment(\.layoutDirection) private var layoutDirection

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> LinkHitTestingTextView {
        let textView = LinkHitTestingTextView()
        textView.backgroundColor = .clear
        textView.isEditable = false
        textView.isScrollEnabled = false
        textView.isSelectable = true
        textView.adjustsFontForContentSizeCategory = true
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.delegate = context.coordinator
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textView.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return textView
    }

    func updateUIView(_ textView: LinkHitTestingTextView, context: Context) {
        textView.attributedText = attributedText
        textView.linkTextAttributes = [
            .foregroundColor: UIColor(linkColor),
        ]
        textView.tintColor = UIColor(linkColor)
        textView.textAlignment = resolvedTextAlignment
        textView.invalidateIntrinsicContentSize()
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: LinkHitTestingTextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let measured = uiView.sizeThatFits(
            CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        )
        return CGSize(width: width, height: ceil(measured.height))
    }

    private var attributedText: NSAttributedString {
        let plainText = String(content.characters)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = resolvedTextAlignment
        if case .body = typography { paragraph.lineSpacing = 3 }

        let rendered = NSMutableAttributedString(
            string: plainText,
            attributes: [
                .font: typography.uiFont,
                .foregroundColor: UIColor(foreground),
                .paragraphStyle: paragraph,
            ]
        )

        var utf16Offset = 0
        for run in content.runs {
            let fragment = String(content[run.range].characters)
            let fragmentLength = (fragment as NSString).length
            let fragmentRange = NSRange(location: utf16Offset, length: fragmentLength)
            let intent = run.inlinePresentationIntent
            let isCode = intent?.contains(.code) == true
            let isStrong = intent?.contains(.stronglyEmphasized) == true
            let isEmphasized = intent?.contains(.emphasized) == true

            rendered.addAttribute(
                .font,
                value: styledFont(
                    base: typography.uiFont,
                    code: isCode,
                    strong: isStrong,
                    emphasized: isEmphasized
                ),
                range: fragmentRange
            )
            if isCode {
                rendered.addAttribute(
                    .backgroundColor,
                    value: UIColor.secondarySystemFill,
                    range: fragmentRange
                )
            }
            if intent?.contains(.strikethrough) == true {
                rendered.addAttribute(
                    .strikethroughStyle,
                    value: NSUnderlineStyle.single.rawValue,
                    range: fragmentRange
                )
            }

            if let link = run.link, CompanionLinkPolicy.isAllowed(link) {
                rendered.addAttribute(.link, value: link, range: fragmentRange)
            } else if !isCode {
                for detected in CompanionMessageLinkDetector.detect(in: fragment) {
                    let range = NSRange(
                        location: utf16Offset + detected.utf16Location,
                        length: detected.utf16Length
                    )
                    rendered.addAttribute(.link, value: detected.url, range: range)
                }
            }
            utf16Offset += fragmentLength
        }

        return rendered
    }

    private var resolvedTextAlignment: NSTextAlignment {
        switch textAlignment {
        case .leading: return layoutDirection == .rightToLeft ? .right : .left
        case .center: return .center
        case .trailing: return layoutDirection == .rightToLeft ? .left : .right
        }
    }

    private func styledFont(
        base: UIFont,
        code: Bool,
        strong: Bool,
        emphasized: Bool
    ) -> UIFont {
        var font = code
            ? UIFont.monospacedSystemFont(
                ofSize: base.pointSize,
                weight: strong ? .semibold : .regular
            )
            : base.withWeight(strong ? .semibold : nil)
        if emphasized,
           let descriptor = font.fontDescriptor.withSymbolicTraits(
               font.fontDescriptor.symbolicTraits.union(.traitItalic)
           ) {
            font = UIFont(descriptor: descriptor, size: font.pointSize)
        }
        return font
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        func textView(
            _ textView: UITextView,
            shouldInteractWith url: URL,
            in characterRange: NSRange,
            interaction: UITextItemInteraction
        ) -> Bool {
            switch interaction {
            case .invokeDefaultAction:
                CompanionMessageLinkActions.open(url)
                return false
            case .presentActions, .preview:
                return true
            @unknown default:
                return false
            }
        }
    }
}

private final class LinkHitTestingTextView: UITextView {
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard super.point(inside: point, with: event),
              attributedText.length > 0,
              let closestTextPosition = closestPosition(to: point)
        else { return false }

        var characterIndex = offset(from: beginningOfDocument, to: closestTextPosition)
        if characterIndex == attributedText.length { characterIndex -= 1 }
        guard characterIndex >= 0, characterIndex < attributedText.length else { return false }

        var linkRange = NSRange(location: 0, length: 0)
        guard attributedText.attribute(
            .link,
            at: characterIndex,
            effectiveRange: &linkRange
        ) != nil,
        let start = self.position(from: beginningOfDocument, offset: linkRange.location),
        let end = self.position(from: start, offset: linkRange.length),
        let resolvedRange = self.textRange(from: start, to: end)
        else { return false }

        return selectionRects(for: resolvedRange).contains { selectionRect in
            selectionRect.rect.insetBy(dx: -4, dy: -4).contains(point)
        }
    }
}

private enum CompanionMessageLinkActions {
    @MainActor
    static func open(_ url: URL) {
        guard CompanionLinkPolicy.isAllowed(url) else { return }
        ExternalURLLauncher.open(url)
    }

    @MainActor
    static func copy(_ url: URL) {
        UIPasteboard.general.url = url
        CompanionMessageInteractionFeedback.announce("Link copied")
    }
}

private extension UIFont {
    func withWeight(_ weight: UIFont.Weight?) -> UIFont {
        guard let weight else { return self }
        let attributes: [UIFontDescriptor.AttributeName: Any] = [
            .traits: [UIFontDescriptor.TraitKey.weight: weight.rawValue],
        ]
        let descriptor = fontDescriptor.addingAttributes(attributes)
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}

private struct MarkdownListView: View {
    let node: MarkdownNode
    let ordered: Bool
    let foreground: Color
    let linkColor: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(node.children) { item in
                HStack(alignment: .top, spacing: 8) {
                    Text(marker(for: item))
                        .font(.body.monospacedDigit())
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                        .frame(minWidth: 20, alignment: .trailing)
                    MarkdownNodesView(
                        nodes: item.children,
                        foreground: foreground,
                        linkColor: linkColor
                    )
                }
                .accessibilityElement(children: .contain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func marker(for item: MarkdownNode) -> String {
        guard ordered, case .listItem(let ordinal) = item.kind else { return "•" }
        return "\(ordinal)."
    }
}

private struct MarkdownCodeBlock: View {
    let code: String
    let language: String?
    let identifier: Int

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var copyGeneration = 0
    @State private var copyFeedbackTrigger = 0
    @State private var isCopied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(languageLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)

                Spacer(minLength: 8)

                Button(action: copyCode) {
                    Label(
                        isCopied ? "Copied" : "Copy",
                        systemImage: isCopied ? "checkmark" : "doc.on.doc"
                    )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(
                            isCopied
                                ? CompanionIOSTheme.toggleGreen
                                : CompanionIOSTheme.textSecondary
                        )
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isCopied ? "Code copied" : "Copy code")
                .accessibilityValue(isCopied ? "Copied" : "Ready")
                .accessibilityIdentifier("markdown.code-copy.\(identifier)")
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
            .overlay(alignment: .bottom) {
                Divider().overlay(CompanionIOSTheme.separator)
            }

            ScrollView(.horizontal) {
                Text(trimmedCode)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(12)
            }
            .scrollIndicators(.visible)
        }
        .companionMaterial(radius: 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Code block, \(languageLabel)")
        .accessibilityIdentifier("markdown.code-block.\(identifier)")
        .sensoryFeedback(.success, trigger: copyFeedbackTrigger)
        .task(id: copyGeneration) {
            guard copyGeneration > 0 else { return }
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            if reduceMotion {
                isCopied = false
            } else {
                withAnimation(.easeOut(duration: 0.2)) {
                    isCopied = false
                }
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: isCopied)
    }

    private func copyCode() {
        // Keep the parser's raw code, including any meaningful trailing newline, in the pasteboard.
        UIPasteboard.general.string = code
        copyFeedbackTrigger &+= 1
        CompanionMessageInteractionFeedback.announce("Code copied")
        copyGeneration &+= 1
        if reduceMotion {
            isCopied = true
        } else {
            withAnimation(.easeOut(duration: 0.2)) {
                isCopied = true
            }
        }
    }

    private var languageLabel: String {
        guard let language, !language.isEmpty else { return "Code" }
        return language.lowercased()
    }

    private var trimmedCode: String {
        code.hasSuffix("\n") ? String(code.dropLast()) : code
    }
}

private struct MarkdownTableView: View {
    let node: MarkdownNode
    let foreground: Color
    let linkColor: Color

    var body: some View {
        ViewThatFits(in: .horizontal) {
            tableGrid
                .fixedSize(horizontal: true, vertical: false)

            VStack(alignment: .trailing, spacing: 0) {
                ScrollView(.horizontal) {
                    tableGrid
                        .fixedSize(horizontal: true, vertical: false)
                }
                .scrollIndicators(.visible)
                .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 4) {
                    Image(systemName: "arrow.left.and.right")
                    Text("Swipe to see all columns")
                }
                .font(.caption2.weight(.medium))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .background(CompanionIOSTheme.card)
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(CompanionIOSTheme.separator)
                        .frame(height: 0.5)
                }
                .accessibilityHidden(true)
            }
            .accessibilityHint("Swipe horizontally to read every column.")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
        .companionMaterial(radius: 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "Table, \(columns.count) columns, \(dataRowCount) rows"
        )
    }

    private var tableGrid: some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { rowIndex, row in
                GridRow {
                    ForEach(Array(columns.indices), id: \.self) { column in
                        let cell = row.children.first { child in
                            if case .tableCell(let index) = child.kind {
                                return index == column
                            }
                            return false
                        }
                        MarkdownTableCell(
                            content: cell?.content ?? AttributedString(),
                            header: headerText(column: column),
                            alignment: columns[column],
                            isHeader: isHeader(row),
                            rowIndex: rowIndex,
                            isLastRow: rowIndex == rows.count - 1,
                            isLastColumn: column == columns.count - 1,
                            foreground: foreground,
                            linkColor: linkColor
                        )
                        .accessibilityIdentifier(
                            "markdown.table.cell.\(rowIndex).\(column)"
                        )
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(rowAccessibilityLabel(row, index: rowIndex))
            }
        }
    }

    private var columns: [MarkdownNode.TableAlignment] {
        if case .table(let columns) = node.kind, !columns.isEmpty { return columns }
        let count = rows.map(\.children.count).max() ?? 1
        return Array(repeating: .leading, count: max(1, count))
    }

    private var rows: [MarkdownNode] {
        node.children.filter { child in
            switch child.kind {
            case .tableHeaderRow, .tableRow: return true
            default: return false
            }
        }
    }

    private func isHeader(_ row: MarkdownNode) -> Bool {
        if case .tableHeaderRow = row.kind { return true }
        return false
    }

    private func headerText(column: Int) -> String? {
        guard let header = rows.first(where: isHeader),
              let cell = header.children.first(where: { child in
                  if case .tableCell(let index) = child.kind { return index == column }
                  return false
              }) else { return nil }
        let value = String(cell.content.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private var dataRowCount: Int {
        rows.filter { !isHeader($0) }.count
    }

    private func rowAccessibilityLabel(_ row: MarkdownNode, index: Int) -> String {
        isHeader(row) ? "Column headers" : "Row \(index)"
    }
}

private struct MarkdownTableCell: View {
    let content: AttributedString
    let header: String?
    let alignment: MarkdownNode.TableAlignment
    let isHeader: Bool
    let rowIndex: Int
    let isLastRow: Bool
    let isLastColumn: Bool
    let foreground: Color
    let linkColor: Color

    @ScaledMetric(relativeTo: .body) private var minimumWidth: CGFloat = 104
    @ScaledMetric(relativeTo: .body) private var idealWidth: CGFloat = 144
    @ScaledMetric(relativeTo: .body) private var maximumWidth: CGFloat = 240
    @ScaledMetric(relativeTo: .body) private var horizontalPadding: CGFloat = 10
    @ScaledMetric(relativeTo: .body) private var verticalPadding: CGFloat = 8

    var body: some View {
        MarkdownText(
            content: content,
            foreground: foreground,
            linkColor: linkColor,
            typography: isHeader ? .tableHeader : .tableBody,
            textAlignment: textAlignment
        )
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .frame(
                minWidth: minimumWidth,
                idealWidth: idealWidth,
                maxWidth: maximumWidth,
                alignment: frameAlignment
            )
            .clipped()
            .background(cellBackground)
            .overlay(alignment: .bottom) {
                if !isLastRow {
                    Rectangle()
                        .fill(CompanionIOSTheme.separator)
                        .frame(height: 0.5)
                }
            }
            .overlay(alignment: .trailing) {
                if !isLastColumn {
                    Rectangle()
                        .fill(CompanionIOSTheme.separator)
                        .frame(width: 0.5)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(isHeader ? .isHeader : [])
            .accessibilityLabel(accessibilityLabel)
            .accessibilityValue("\(alignmentLabel) aligned")
    }

    private var frameAlignment: Alignment {
        switch alignment {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private var textAlignment: TextAlignment {
        switch alignment {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private var cellBackground: Color {
        if isHeader { return CompanionIOSTheme.card }
        return rowIndex.isMultiple(of: 2) ? Color.clear : CompanionIOSTheme.card.opacity(0.62)
    }

    private var alignmentLabel: String {
        switch alignment {
        case .leading: return "Left"
        case .center: return "Center"
        case .trailing: return "Right"
        }
    }

    private var accessibilityLabel: String {
        let value = String(content.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        let spokenValue = value.isEmpty ? "No value" : value
        guard !isHeader, let header else { return spokenValue }
        return "\(header), \(spokenValue)"
    }
}

private enum MarkdownTreeBuilder {
    static func document(from parsed: AttributedString) -> [MarkdownNode] {
        let root = NodeBuilder(id: Int.min, kind: .paragraph)
        var syntheticID = -1
        var unscopedNode: NodeBuilder?

        for run in parsed.runs {
            let fragment = sanitizedFragment(parsed[run.range], attributes: run)
            guard let intent = run.presentationIntent else {
                if unscopedNode == nil {
                    unscopedNode = root.child(id: syntheticID, kind: .paragraph)
                    syntheticID -= 1
                }
                unscopedNode?.content.append(fragment)
                continue
            }

            unscopedNode = nil
            var parent = root
            for component in intent.components.reversed() {
                parent = parent.child(id: component.identity, kind: kind(component.kind))
            }
            parent.content.append(fragment)
        }

        return root.children.map(\.node)
    }

    private static func sanitizedFragment(
        _ source: AttributedSubstring,
        attributes: AttributedString.Runs.Run
    ) -> AttributedString {
        if attributes.imageURL != nil {
            let alt = String(source.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            var placeholder = AttributedString(alt.isEmpty ? "[image]" : "[image: \(alt)]")
            placeholder.inlinePresentationIntent = .emphasized
            placeholder.foregroundColor = CompanionIOSTheme.textSecondary
            return placeholder
        }

        var fragment = AttributedString(source)
        if let link = attributes.link, CompanionLinkPolicy.route(for: link) == .blocked {
            fragment.link = nil
        }
        if attributes.inlinePresentationIntent?.contains(.code) == true {
            fragment.font = .body.monospaced()
            fragment.backgroundColor = CompanionIOSTheme.card
        }
        return fragment
    }

    private static func kind(_ kind: PresentationIntent.Kind) -> MarkdownNode.Kind {
        switch kind {
        case .paragraph: return .paragraph
        case .header(let level): return .heading(level: level)
        case .orderedList: return .orderedList
        case .unorderedList: return .unorderedList
        case .listItem(let ordinal): return .listItem(ordinal: ordinal)
        case .codeBlock(let language): return .codeBlock(language: language)
        case .blockQuote: return .blockQuote
        case .thematicBreak: return .thematicBreak
        case .table(let columns):
            return .table(columns: columns.map { column in
                switch column.alignment {
                case .left: return .leading
                case .center: return .center
                case .right: return .trailing
                @unknown default: return .leading
                }
            })
        case .tableHeaderRow: return .tableHeaderRow
        case .tableRow(let index): return .tableRow(index: index)
        case .tableCell(let column): return .tableCell(column: column)
        @unknown default: return .paragraph
        }
    }

    private final class NodeBuilder {
        let id: Int
        let kind: MarkdownNode.Kind
        var content = AttributedString()
        var children: [NodeBuilder] = []
        private var childIndexes: [Int: Int] = [:]

        init(id: Int, kind: MarkdownNode.Kind) {
            self.id = id
            self.kind = kind
        }

        func child(id: Int, kind: MarkdownNode.Kind) -> NodeBuilder {
            if let index = childIndexes[id] { return children[index] }
            let child = NodeBuilder(id: id, kind: kind)
            childIndexes[id] = children.count
            children.append(child)
            return child
        }

        var node: MarkdownNode {
            MarkdownNode(
                id: id,
                kind: kind,
                content: content,
                children: children.map(\.node)
            )
        }
    }
}
