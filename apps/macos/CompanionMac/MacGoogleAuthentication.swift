@preconcurrency import AuthenticationServices
import AppKit

enum CompanionMacGoogleSignInError: Error {
    case unavailable
    case cancelled
    case callback
}
@MainActor
final class CompanionMacGoogleAuthentication: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func authenticate(at url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let authentication = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { [weak self] callbackURL, error in
                Task { @MainActor in
                    self?.session = nil
                    if let callbackURL {
                        continuation.resume(returning: callbackURL)
                    } else if let authError = error as? ASWebAuthenticationSessionError,
                              authError.code == .canceledLogin {
                        continuation.resume(throwing: CompanionMacGoogleSignInError.cancelled)
                    } else {
                        continuation.resume(throwing: CompanionMacGoogleSignInError.callback)
                    }
                }
            }
            authentication.presentationContextProvider = self
            authentication.prefersEphemeralWebBrowserSession = true
            session = authentication
            guard authentication.start() else {
                session = nil
                continuation.resume(throwing: CompanionMacGoogleSignInError.unavailable)
                return
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // The main window is the only presentation anchor we need. If a caller invokes Google
        // sign-in while the app is launching, AppKit's key window may not exist yet; the first
        // visible window is a safe fallback and avoids creating a hidden credential-bearing UI.
        if let window = NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first(where: { $0.isVisible }) {
            return window
        }
        let window = NSWindow(
            contentRect: .zero,
            styleMask: [.borderless],
            backing: .buffered,
            defer: true
        )
        window.isReleasedWhenClosed = false
        return window
    }
}
