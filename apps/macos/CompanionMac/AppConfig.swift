import Foundation

enum CompanionMacAppConfig {
    static let productionAPIURL = URL(string: "https://api.thecompanion.sh")!

    static var apiURL: URL {
#if DEBUG
        if let environmentURL = validURL(ProcessInfo.processInfo.environment["COMPANION_API_URL"]) {
            return environmentURL
        }
        if let configuredURL = validURL(Bundle.main.object(forInfoDictionaryKey: "CompanionAPIURL") as? String) {
            return configuredURL
        }
#endif
        return productionAPIURL
    }

    static var callbackScheme: String {
        Bundle.main.object(forInfoDictionaryKey: "CompanionURLScheme") as? String
            ?? "companion-mac"
    }

    private static func validURL(_ value: String?) -> URL? {
        guard let value,
              let url = URL(string: value),
              let scheme = url.scheme,
              url.host != nil,
              scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }
}
