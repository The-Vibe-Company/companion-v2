import CompanionKit
import SwiftUI

struct CompanionMacLoginView: View {
    @Environment(SessionStore.self) private var sessionStore
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var googleBusy = false
    @State private var error: String?
    @State private var googleAuthentication = CompanionMacGoogleAuthentication()
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case email
        case password
    }

    var body: some View {
        VStack(spacing: CompanionMacMetrics.space * 7) {
            VStack(spacing: CompanionMacMetrics.space * 2) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: 48, weight: .medium))
                    .foregroundStyle(Color.companionMacAccent)
                    .accessibilityLabel("Companion")
                Text("Sign in to Companion")
                    .font(.largeTitle.weight(.semibold))
                Text("Use the same account and workspace as every Companion client.")
                    .font(.callout)
                    .foregroundStyle(Color.companionMacMuted)
            }

            VStack(spacing: CompanionMacMetrics.space * 4) {
                Button {
                    signInWithGoogle()
                } label: {
                    HStack(spacing: CompanionMacMetrics.space * 2) {
                        if googleBusy {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "g.circle")
                                .font(.title3)
                        }
                        Text(googleBusy ? "Opening Google…" : "Continue with Google")
                    }
                    .frame(maxWidth: .infinity, minHeight: 32)
                }
                .buttonStyle(.bordered)
                .disabled(busy || googleBusy)
                .accessibilityIdentifier("login.google")

                Divider()

                VStack(alignment: .leading, spacing: CompanionMacMetrics.space) {
                    Text("Email")
                        .font(.callout.weight(.medium))
                    TextField("you@company.com", text: $email)
                        .textContentType(.emailAddress)
                        .focused($focusedField, equals: .email)
                        .onSubmit { focusedField = .password }
                        .accessibilityIdentifier("login.email")
                }

                VStack(alignment: .leading, spacing: CompanionMacMetrics.space) {
                    Text("Password")
                        .font(.callout.weight(.medium))
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .focused($focusedField, equals: .password)
                        .onSubmit(submit)
                        .accessibilityIdentifier("login.password")
                }

                if let error {
                    CompanionMacErrorNotice(message: error)
                }

                Button {
                    submit()
                } label: {
                    HStack {
                        if busy { ProgressView().controlSize(.small) }
                        Text(busy ? "Signing in…" : "Sign in")
                    }
                    .frame(maxWidth: .infinity, minHeight: 32)
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || googleBusy || !canSubmit)
                .accessibilityIdentifier("login.submit")
            }
            .padding(CompanionMacMetrics.space * 6)
            .frame(width: 420)
            .background(Color.companionMacSurface)
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.companionMacDivider, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.companionMacCanvas)
    }

    private var canSubmit: Bool {
        !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty
    }

    private func submit() {
        guard !busy, !googleBusy, canSubmit else { return }
        busy = true
        error = nil
        Task {
            do {
                try await sessionStore.signIn(email: email, password: password)
            } catch let apiError as APIError where apiError.code == "EMAIL_NOT_VERIFIED" {
                error = "Your email is not verified. We sent a new verification code; finish verification in the web app, then try again."
                password = ""
            } catch let apiError as APIError {
                error = apiError.status == 0
                    ? "The server could not be reached. Check the Conductor stack or API URL."
                    : "The email or password was not accepted."
                password = ""
            } catch {
                self.error = "Sign in could not be completed."
            }
            busy = false
        }
    }

    private func signInWithGoogle() {
        guard !busy, !googleBusy else { return }
        googleBusy = true
        error = nil
        Task {
            do {
                let authorization = try await sessionStore.beginGoogleSignIn(
                    callbackScheme: CompanionMacAppConfig.callbackScheme
                )
                let callbackURL = try await googleAuthentication.authenticate(
                    at: authorization.proxyURL,
                    callbackScheme: CompanionMacAppConfig.callbackScheme
                )
                try await sessionStore.completeGoogleSignIn(
                    callbackURL: callbackURL,
                    callbackScheme: CompanionMacAppConfig.callbackScheme
                )
            } catch CompanionMacGoogleSignInError.cancelled {
                error = nil
            } catch let apiError as APIError where apiError.status == 0 {
                error = "The server could not be reached. Check the Conductor stack or API URL."
            } catch {
                error = "Google sign-in is unavailable. Try again later."
            }
            googleBusy = false
        }
    }
}
