import Foundation

/// The routing classification for a link in assistant-authored markdown.
public enum CompanionLinkRoute: Equatable, Sendable {
    case system
    case conductor
    case blocked
}

/// Keeps markdown link handling deterministic and fail-closed across native surfaces.
public enum CompanionLinkPolicy {
    public static let allowedSchemes: Set<String> = [
        "conductor",
        "http",
        "https",
        "mailto",
    ]

    public static let conductorScheme = "conductor"

    public static func parse(_ rawValue: String) -> URL? {
        URL(string: rawValue)
    }

    public static func route(for rawValue: String) -> CompanionLinkRoute {
        guard let url = parse(rawValue) else { return .blocked }
        return route(for: url)
    }

    public static func route(for url: URL) -> CompanionLinkRoute {
        guard let scheme = normalizedScheme(url.scheme), allowedSchemes.contains(scheme) else {
            return .blocked
        }
        return scheme == conductorScheme ? .conductor : .system
    }

    public static func isAllowed(_ url: URL) -> Bool {
        route(for: url) != .blocked
    }

    public static func isAllowedScheme(_ scheme: String?) -> Bool {
        guard let normalizedScheme = normalizedScheme(scheme) else { return false }
        return allowedSchemes.contains(normalizedScheme)
    }

    public static func isConductor(_ url: URL) -> Bool {
        route(for: url) == .conductor
    }

    public static func normalizedScheme(_ scheme: String?) -> String? {
        guard let scheme else { return nil }
        let normalized = scheme.lowercased()
        return normalized.isEmpty ? nil : normalized
    }
}
