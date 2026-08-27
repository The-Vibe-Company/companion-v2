import UIKit

enum ExternalURLLauncher {
    @MainActor
    static func open(
        _ url: URL,
        onFailure: @escaping @MainActor () -> Void = {}
    ) {
        UIApplication.shared.open(url, options: [:]) { opened in
            guard !opened else { return }
            Task { @MainActor in
                onFailure()
            }
        }
    }
}
