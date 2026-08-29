import Foundation

public struct CompanionDetectedLink: Equatable, Sendable {
    public let url: URL
    public let utf16Location: Int
    public let utf16Length: Int

    public init(url: URL, utf16Location: Int, utf16Length: Int) {
        self.url = url
        self.utf16Location = utf16Location
        self.utf16Length = utf16Length
    }

    public var nsRange: NSRange {
        NSRange(location: utf16Location, length: utf16Length)
    }
}

/// Finds bare, tappable URLs after Markdown parsing has removed source-only punctuation.
/// The caller remains responsible for excluding code and already-linked attributed runs.
public enum CompanionMessageLinkDetector {
    public static func detect(in text: String) -> [CompanionDetectedLink] {
        guard !text.isEmpty,
              let detector = try? NSDataDetector(
                  types: NSTextCheckingResult.CheckingType.link.rawValue
              )
        else { return [] }

        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return detector.matches(in: text, options: [], range: range).compactMap { result in
            guard let url = result.url, CompanionLinkPolicy.isAllowed(url) else { return nil }
            return CompanionDetectedLink(
                url: url,
                utf16Location: result.range.location,
                utf16Length: result.range.length
            )
        }
    }
}
