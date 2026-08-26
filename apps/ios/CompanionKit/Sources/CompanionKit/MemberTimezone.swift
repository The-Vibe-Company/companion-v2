import Foundation

/// Shared timezone behavior for profile settings and user-local Companion surfaces.
///
/// The API stores IANA identifiers. The device timezone is only a default when a member has not
/// chosen one yet; callers should persist that default before creating a new routine.
public enum MemberTimezone {
    public static let fallbackIdentifier = "UTC"

    /// The system's current IANA identifier, with a stable fallback for unusual environments.
    public static var deviceIdentifier: String {
        let identifier = TimeZone.current.identifier
        return identifier == fallbackIdentifier || TimeZone.knownTimeZoneIdentifiers.contains(identifier)
            ? identifier
            : fallbackIdentifier
    }

    public static func timeZone(for identifier: String?) -> TimeZone {
        guard let identifier,
              !identifier.isEmpty,
              let timeZone = TimeZone(identifier: identifier) else {
            return TimeZone.current
        }
        return timeZone
    }

    public static func isKnownIdentifier(_ identifier: String) -> Bool {
        identifier == fallbackIdentifier || TimeZone.knownTimeZoneIdentifiers.contains(identifier)
    }

    /// Formats an ISO-8601 instant in a member's timezone. Invalid or missing server instants are
    /// intentionally omitted instead of showing a misleading local date.
    public static func formatInstant(
        _ instant: String?,
        in identifier: String?,
        locale: Locale = .current
    ) -> String? {
        guard let date = parseInstant(instant) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone(for: identifier)
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    public static func parseInstant(_ instant: String?) -> Date? {
        guard let instant, !instant.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: instant) { return date }

        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: instant)
    }

    /// The system-provided display name is useful in a picker, while the identifier remains the
    /// primary value so DST and server scheduling behavior stays unambiguous.
    public static func displayName(for identifier: String, locale: Locale = .current) -> String {
        TimeZone(identifier: identifier)?.localizedName(for: .standard, locale: locale)
            ?? identifier
    }

    public static func pickerIdentifiers() -> [String] {
        TimeZone.knownTimeZoneIdentifiers.sorted {
            $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
        }
    }
}
