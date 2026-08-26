import SwiftUI
import CompanionKit

struct MarkdownDocument: Equatable, Sendable {
    let blocks: [MarkdownNode]

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
            blocks = tree.isEmpty ? [MarkdownNode.plainText(source)] : tree
        } catch {
            blocks = [MarkdownNode.plainText(source)]
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
}

struct MarkdownMessageView: View {
    let document: MarkdownDocument
    let accent: Color

    var body: some View {
        MarkdownNodesView(nodes: document.blocks, accent: accent)
            .textSelection(.enabled)
            .tint(accent)
            .environment(
                \.openURL,
                OpenURLAction { url in
                    switch CompanionLinkPolicy.route(for: url) {
                    case .system:
                        return .systemAction
                    case .conductor:
                        // Companion has no Conductor workspace route, so let iOS hand this URL to
                        // whichever installed app has registered the explicit scheme.
                        return .systemAction
                    case .blocked:
                        return .discarded
                    }
                }
            )
    }
}

private struct MarkdownNodesView: View {
    let nodes: [MarkdownNode]
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(nodes) { node in
                MarkdownNodeView(node: node, accent: accent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MarkdownNodeView: View {
    let node: MarkdownNode
    let accent: Color

    @ViewBuilder
    var body: some View {
        switch node.kind {
        case .paragraph:
            MarkdownText(content: node.content, accent: accent)
                .font(.body)
                .lineSpacing(3)

        case .heading(let level):
            MarkdownText(content: node.content, accent: accent)
                .font(headingFont(level: level))
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("markdown.heading.\(node.id)")

        case .orderedList:
            MarkdownListView(node: node, ordered: true, accent: accent)
                .accessibilityIdentifier("markdown.list.\(node.id)")

        case .unorderedList:
            MarkdownListView(node: node, ordered: false, accent: accent)
                .accessibilityIdentifier("markdown.list.\(node.id)")

        case .listItem:
            MarkdownNodesView(nodes: node.children, accent: accent)

        case .codeBlock(let language):
            MarkdownCodeBlock(
                code: String(node.content.characters),
                language: language,
                identifier: node.id
            )

        case .blockQuote:
            HStack(alignment: .top, spacing: 10) {
                Rectangle()
                    .fill(Color.companionDivider)
                    .frame(width: 2)
                    .accessibilityHidden(true)
                MarkdownNodesView(nodes: node.children, accent: accent)
                    .foregroundStyle(Color.companionMuted)
            }
            .accessibilityIdentifier("markdown.quote.\(node.id)")

        case .thematicBreak:
            Divider()
                .overlay(Color.companionDivider)
                .accessibilityLabel("Section break")
                .accessibilityIdentifier("markdown.divider.\(node.id)")

        case .table:
            MarkdownTableView(node: node, accent: accent)
                .accessibilityIdentifier("markdown.table.\(node.id)")

        case .tableHeaderRow, .tableRow, .tableCell:
            MarkdownNodesView(nodes: node.children, accent: accent)
        }
    }

    private func headingFont(level: Int) -> Font {
        switch level {
        case 1: return .title2.weight(.semibold)
        case 2: return .title3.weight(.semibold)
        case 3: return .headline.weight(.semibold)
        case 4: return .body.weight(.semibold)
        default: return .subheadline.weight(.semibold)
        }
    }
}

private struct MarkdownText: View {
    let content: AttributedString
    let accent: Color

    var body: some View {
        text
            .foregroundStyle(Color.companionInk)
            .tint(accent)
    }

    @ViewBuilder
    private var text: some View {
        if containsConductorLink {
            MarkdownInlineFlow(content: content, accent: accent)
        } else {
            Text(content)
        }
    }

    private var containsConductorLink: Bool {
        content.runs.contains { run in
            guard let link = run.link else { return false }
            return CompanionLinkPolicy.isConductor(link)
        }
    }
}

private struct MarkdownInlineRun: Identifiable {
    let id: Int
    var content: AttributedString
    let link: URL?

    var isConductorLink: Bool {
        guard let link else { return false }
        return CompanionLinkPolicy.isConductor(link)
    }
}

private struct MarkdownInlineFlow: View {
    let runs: [MarkdownInlineRun]
    let accent: Color

    init(content: AttributedString, accent: Color) {
        self.accent = accent
        var inlineRuns: [MarkdownInlineRun] = []
        for run in content.runs {
            var fragment = AttributedString(content[run.range])
            let link = run.link
            if let link, CompanionLinkPolicy.isConductor(link) {
                // The native Link below owns the interaction and accessibility semantics.
                fragment.link = nil
            }
            if let lastIndex = inlineRuns.indices.last, inlineRuns[lastIndex].link == link {
                inlineRuns[lastIndex].content.append(fragment)
            } else {
                inlineRuns.append(
                    MarkdownInlineRun(id: inlineRuns.count, content: fragment, link: link)
                )
            }
        }
        self.runs = inlineRuns
    }

    var body: some View {
        MarkdownInlineFlowLayout {
            ForEach(runs) { run in
                if run.isConductorLink, let link = run.link {
                    Link(destination: link) {
                        Text(run.content)
                            .foregroundStyle(accent)
                            .underline()
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .tint(accent)
                } else {
                    Text(run.content)
                }
            }
        }
    }
}

private struct MarkdownInlineFlowLayout: Layout {
    private struct RawPlacement {
        let index: Int
        let size: CGSize
        let x: CGFloat
        let line: Int
    }

    private struct Placement {
        let index: Int
        let size: CGSize
        let origin: CGPoint
    }

    private struct Result {
        let placements: [Placement]
        let size: CGSize
    }

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        layout(subviews: subviews, width: proposal.width).size
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let result = layout(subviews: subviews, width: bounds.width)
        for placement in result.placements {
            subviews[placement.index].place(
                at: CGPoint(
                    x: bounds.minX + placement.origin.x,
                    y: bounds.minY + placement.origin.y
                ),
                anchor: .topLeading,
                proposal: ProposedViewSize(
                    width: placement.size.width,
                    height: placement.size.height
                )
            )
        }
    }

    private func layout(subviews: Subviews, width proposedWidth: CGFloat?) -> Result {
        guard !subviews.isEmpty else {
            return Result(placements: [], size: CGSize(width: proposedWidth ?? 0, height: 0))
        }

        let width = max(
            proposedWidth.flatMap { $0.isFinite ? $0 : nil } ?? .greatestFiniteMagnitude,
            1
        )
        var rawPlacements: [RawPlacement] = []
        var lineHeights: [CGFloat] = []
        var lineWidth: CGFloat = 0
        var lineHeight: CGFloat = 0
        var line = 0
        var maxLineWidth: CGFloat = 0

        for (index, subview) in subviews.enumerated() {
            let idealSize = subview.sizeThatFits(.unspecified)
            if lineWidth > 0, idealSize.width > width - lineWidth {
                maxLineWidth = max(maxLineWidth, lineWidth)
                lineHeights.append(lineHeight)
                line += 1
                lineWidth = 0
                lineHeight = 0
            }

            let availableWidth = max(width - lineWidth, 1)
            let measuredSize: CGSize
            if idealSize.width > availableWidth {
                measuredSize = subview.sizeThatFits(
                    ProposedViewSize(width: availableWidth, height: nil)
                )
            } else {
                measuredSize = idealSize
            }
            rawPlacements.append(
                RawPlacement(index: index, size: measuredSize, x: lineWidth, line: line)
            )
            lineWidth += measuredSize.width
            lineHeight = max(lineHeight, measuredSize.height)
        }

        maxLineWidth = max(maxLineWidth, lineWidth)
        lineHeights.append(lineHeight)

        var lineOrigins: [CGFloat] = []
        var y: CGFloat = 0
        for height in lineHeights {
            lineOrigins.append(y)
            y += height
        }

        let placements = rawPlacements.map { raw in
            Placement(
                index: raw.index,
                size: raw.size,
                origin: CGPoint(
                    x: raw.x,
                    y: lineOrigins[raw.line] + (lineHeights[raw.line] - raw.size.height) / 2
                )
            )
        }
        return Result(
            placements: placements,
            size: CGSize(
                width: proposedWidth.flatMap { $0.isFinite ? $0 : nil } ?? maxLineWidth,
                height: y
            )
        )
    }
}

private struct MarkdownListView: View {
    let node: MarkdownNode
    let ordered: Bool
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(node.children) { item in
                HStack(alignment: .top, spacing: 8) {
                    Text(marker(for: item))
                        .font(.body.monospacedDigit())
                        .foregroundStyle(Color.companionMuted)
                        .frame(minWidth: 20, alignment: .trailing)
                    MarkdownNodesView(nodes: item.children, accent: accent)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(languageLabel)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.companionMuted)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .bottom) {
                    Divider().overlay(Color.companionDivider)
                }

            ScrollView(.horizontal) {
                Text(trimmedCode)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(Color.companionInk)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(12)
            }
            .scrollIndicators(.visible)
        }
        .companionMaterial(radius: 10)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Code block, \(languageLabel)")
        .accessibilityIdentifier("markdown.code-block.\(identifier)")
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
    let accent: Color

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(rows) { row in
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
                                accent: accent
                            )
                        }
                    }
                }
            }
        }
        .scrollIndicators(.visible)
        .companionMaterial(radius: 10)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Markdown table")
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
}

private struct MarkdownTableCell: View {
    let content: AttributedString
    let header: String?
    let alignment: MarkdownNode.TableAlignment
    let isHeader: Bool
    let accent: Color

    var body: some View {
        MarkdownText(content: content, accent: accent)
            .font(isHeader ? .subheadline.weight(.semibold) : .subheadline)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(minWidth: 96, maxWidth: 240, alignment: frameAlignment)
            .background(isHeader ? Color.companionSurfaceRaised : Color.clear)
            .overlay {
                Rectangle().stroke(Color.companionDivider, lineWidth: 0.5)
            }
            .accessibilityAddTraits(isHeader ? .isHeader : [])
            .accessibilityLabel(accessibilityLabel)
    }

    private var frameAlignment: Alignment {
        switch alignment {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private var accessibilityLabel: String {
        let value = String(content.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isHeader, let header else { return value }
        return "\(header): \(value)"
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
            placeholder.foregroundColor = Color.companionMuted
            return placeholder
        }

        var fragment = AttributedString(source)
        if let link = attributes.link, CompanionLinkPolicy.route(for: link) == .blocked {
            fragment.link = nil
        }
        if attributes.inlinePresentationIntent?.contains(.code) == true {
            fragment.font = .body.monospaced()
            fragment.backgroundColor = Color.companionSurfaceRaised
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
