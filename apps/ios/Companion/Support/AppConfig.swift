import Foundation

enum AppConfig {
    private static let productionAPIURL = URL(string: "https://api.thecompanion.sh")!

    static var apiURL: URL {
#if DEBUG
        if let launchOverride = validURL(UserDefaults.standard.string(forKey: "COMPANION_API_URL")) {
            return launchOverride
        }
        if let schemeEnvironment = validURL(ProcessInfo.processInfo.environment["COMPANION_API_URL"]) {
            return schemeEnvironment
        }
        if let bakedValue = validURL(Bundle.main.object(forInfoDictionaryKey: "CompanionAPIURL") as? String) {
            return bakedValue
        }
#endif
        return productionAPIURL
    }

    static var callbackScheme: String {
        Bundle.main.object(forInfoDictionaryKey: "CompanionURLScheme") as? String
            ?? "dev.companion.mobile"
    }

    private static func validURL(_ value: String?) -> URL? {
        guard let value, let url = URL(string: value), let scheme = url.scheme, url.host != nil else {
            return nil
        }
        return scheme == "http" || scheme == "https" ? url : nil
    }
}
