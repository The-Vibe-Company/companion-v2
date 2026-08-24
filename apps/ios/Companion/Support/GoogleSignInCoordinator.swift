@preconcurrency import AuthenticationServices
import UIKit

@MainActor
final class GoogleSignInCoordinator: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func authenticate(at url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { [weak self] callbackURL, error in
                Task { @MainActor in
                    self?.session = nil
                    if let callbackURL {
                        continuation.resume(returning: callbackURL)
                    } else if let authenticationError = error as? ASWebAuthenticationSessionError,
                              authenticationError.code == .canceledLogin {
                        continuation.resume(throwing: GoogleSignInError.cancelled)
                    } else {
                        continuation.resume(throwing: GoogleSignInError.callback)
                    }
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            self.session = session
            guard session.start() else {
                self.session = nil
                continuation.resume(throwing: GoogleSignInError.unavailable)
                return
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let window = scenes.flatMap(\.windows).first(where: { $0.isKeyWindow })
            ?? scenes.first?.windows.first {
            return window
        }
        guard let scene = scenes.first else {
            preconditionFailure("Google sign-in requires an active window scene")
        }
        return ASPresentationAnchor(windowScene: scene)
    }
}

enum GoogleSignInError: Error {
    case unavailable
    case cancelled
    case callback
}
