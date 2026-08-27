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
    private var presentationWindow: NSWindow?

    func authenticate(at url: URL, callbackScheme: String) async throws -> URL {
        guard let window = NSApp.keyWindow
                ?? NSApp.mainWindow
                ?? NSApp.windows.first(where: { $0.isVisible }) else {
            throw CompanionMacGoogleSignInError.unavailable
        }
        presentationWindow = window
        return try await withCheckedThrowingContinuation { continuation in
            let authentication = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { [weak self] callbackURL, error in
                Task { @MainActor in
                    self?.session = nil
                    self?.presentationWindow = nil
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
                presentationWindow = nil
                continuation.resume(throwing: CompanionMacGoogleSignInError.unavailable)
                return
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // `authenticate` retains a real visible AppKit window before starting the session.
        // AuthenticationServices requests this anchor synchronously while that session is alive.
        presentationWindow!
    }
}
