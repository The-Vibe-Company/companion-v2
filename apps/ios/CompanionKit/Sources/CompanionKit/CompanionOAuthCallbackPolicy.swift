import Foundation

/// The only callback routes that the native app may consume while an external auth flow is active.
///
/// The callback values themselves are intentionally not persisted or logged. The API client uses
/// this policy to validate the route before sending the callback back to the existing server flow.
public enum CompanionOAuthCallbackRoute: Equatable, Sendable {
    case google
    case plugin
    case blocked
}

public enum CompanionOAuthCallbackPolicy {
    /// The public web origin used by the production curated-plugin redirect URI and AASA document.
    /// Runtime plugin flows bind to the authenticated `redirect_uri` instead of this constant.
    public static let pluginCallbackHost = "thecompanion.sh"
    public static let pluginCallbackPath = "/v1/companion-plugins/oauth/callback"
    public static let googleNativeStateQueryName = "native_state"

    public static func route(
        for url: URL,
        googleCallbackScheme: String?,
        googleNativeState: String? = nil,
        pluginCallbackURL: URL? = nil,
        pluginCallbackState: String? = nil
    ) -> CompanionOAuthCallbackRoute {
        if let googleCallbackScheme,
           let googleNativeState,
           isGoogleCallback(
               url,
               callbackScheme: googleCallbackScheme,
               expectedNativeState: googleNativeState
           ) {
            return .google
        }
        if let pluginCallbackURL,
           let pluginCallbackState,
           isPluginCallback(url, expectedCallbackURL: pluginCallbackURL),
           queryValue(named: "state", from: url) == pluginCallbackState {
            return .plugin
        }
        return .blocked
    }

    /// Google uses Better Auth's existing custom-scheme callback. The host and path are kept empty
    /// so a different app's custom URL cannot be mistaken for this flow. The native state is
    /// generated per flow and is retained in memory only.
    public static func isGoogleCallback(
        _ url: URL,
        callbackScheme: String,
        expectedNativeState: String
    ) -> Bool {
        guard url.scheme?.caseInsensitiveCompare(callbackScheme) == .orderedSame,
              url.host == nil || url.host?.isEmpty == true,
              url.path.isEmpty || url.path == "/",
              url.port == nil,
              url.fragment == nil,
              !callbackScheme.isEmpty,
              !expectedNativeState.isEmpty,
              queryValue(named: googleNativeStateQueryName, from: url) == expectedNativeState else {
            return false
        }
        return true
    }

    /// Curated plugins keep the provider's signed state, authorization code, and redirect URI
    /// unchanged. The expected callback URL comes from the authenticated start response; this
    /// avoids making a production hostname an implicit trust boundary for self-hosted builds.
    public static func isPluginCallback(_ url: URL, expectedCallbackURL: URL) -> Bool {
        guard let expectedScheme = expectedCallbackURL.scheme,
              (expectedScheme.caseInsensitiveCompare("https") == .orderedSame
                  || expectedScheme.caseInsensitiveCompare("http") == .orderedSame),
              let expectedHost = expectedCallbackURL.host,
              !expectedHost.isEmpty,
              expectedCallbackURL.path == pluginCallbackPath,
              expectedCallbackURL.user == nil,
              expectedCallbackURL.password == nil,
              expectedCallbackURL.fragment == nil,
              url.scheme?.caseInsensitiveCompare(expectedScheme) == .orderedSame,
              url.host?.caseInsensitiveCompare(expectedHost) == .orderedSame,
              url.path == pluginCallbackPath,
              effectivePort(for: url) == effectivePort(for: expectedCallbackURL),
              url.user == nil,
              url.password == nil,
              url.fragment == nil else {
            return false
        }
        return true
    }

    /// Returns the opaque Better Auth callback value without retaining or interpreting the full
    /// URL. The caller must still validate the custom-scheme route and native state while a Google
    /// flow is pending.
    public static func googleCookie(
        from url: URL,
        callbackScheme: String,
        expectedNativeState: String
    ) -> String? {
        guard isGoogleCallback(
            url,
            callbackScheme: callbackScheme,
            expectedNativeState: expectedNativeState
        ) else { return nil }
        return queryValue(named: "cookie", from: url)
    }

    public static func queryValue(named name: String, from url: URL) -> String? {
        let matches = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.filter {
            $0.name == name
        } ?? []
        guard matches.count == 1 else { return nil }
        return matches[0].value
    }
    private static func effectivePort(for url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }
}
