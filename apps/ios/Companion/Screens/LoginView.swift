import SwiftUI
import CompanionKit

struct LoginView: View {
    @Environment(SessionStore.self) private var sessionStore
    @State private var email = ""
    @State private var password = ""
    @State private var passwordVisible = false
    @State private var busy = false
    @State private var googleBusy = false
    @State private var error: String?
    @State private var googleCoordinator = GoogleSignInCoordinator()
    @FocusState private var focusedField: Field?

    private enum Field { case email, password }

    var body: some View {
        CompanionBackdrop {
            ScrollView {
                VStack(spacing: 28) {
                    Spacer(minLength: 64)
                    brand
                    form
                    Text("Use the same account and workspace as every other Companion client.")
                        .font(.footnote)
                        .foregroundStyle(Color.companionMuted)
                        .multilineTextAlignment(.center)
                    Spacer(minLength: 32)
                }
                .frame(maxWidth: 500)
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private var brand: some View {
        VStack(spacing: 14) {
            Image("CompanionMark")
                .resizable()
                .scaledToFit()
                .padding(12)
                .frame(width: 82, height: 82)
                .companionGlass(radius: 24)
                .accessibilityLabel("Companion")
            VStack(spacing: 6) {
                Text("Companion").font(.title2.weight(.semibold))
                Text("Sign in to continue your workspace conversations.")
                    .font(.subheadline)
                    .foregroundStyle(Color.companionMuted)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var form: some View {
        VStack(spacing: 16) {
            Button(action: signInWithGoogle) {
                HStack(spacing: 10) {
                    if googleBusy {
                        ProgressView().controlSize(.small)
                    } else {
                        Image("GoogleMark")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 19, height: 19)
                            .accessibilityHidden(true)
                    }
                    Text(googleBusy ? "Opening Google…" : "Continue with Google")
                        .frame(maxWidth: .infinity)
                }
                .foregroundStyle(Color.companionInk)
                .frame(minHeight: 48)
            }
            .buttonStyle(.glass)
            .disabled(busy || googleBusy)
            .accessibilityIdentifier("login.google")

            HStack(spacing: 12) {
                Rectangle().fill(Color.companionBorder).frame(height: 0.5)
                Text("or").font(.caption).foregroundStyle(Color.companionMuted)
                Rectangle().fill(Color.companionBorder).frame(height: 0.5)
            }

            VStack(alignment: .leading, spacing: 7) {
                Text("Email").font(.subheadline.weight(.medium))
                TextField("you@company.com", text: $email)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    .focused($focusedField, equals: .email)
                    .submitLabel(.next)
                    .accessibilityIdentifier("login.email")
                    .onSubmit { focusedField = .password }
                    .fieldStyle()
            }
            VStack(alignment: .leading, spacing: 7) {
                Text("Password").font(.subheadline.weight(.medium))
                HStack(spacing: 8) {
                    Group {
                        if passwordVisible {
                            TextField("Your password", text: $password)
                        } else {
                            SecureField("Your password", text: $password)
                        }
                    }
                    .textContentType(.password)
                    .focused($focusedField, equals: .password)
                    .submitLabel(.go)
                    .onSubmit(submit)
                    .accessibilityIdentifier("login.password")
                    Button {
                        passwordVisible.toggle()
                    } label: {
                        Image(systemName: passwordVisible ? "eye.slash" : "eye")
                            .foregroundStyle(Color.companionMuted)
                    }
                    .accessibilityLabel(passwordVisible ? "Hide password" : "Show password")
                }
                .fieldStyle()
            }
            if let error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(Color.companionDanger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Sign in error: \(error)")
            }
            Button(action: submit) {
                HStack {
                    if busy { ProgressView().controlSize(.small) }
                    Text(busy ? "Signing in…" : "Sign in")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .tint(Color.companionAccent)
            .controlSize(.large)
            .disabled(busy || googleBusy || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)
            .accessibilityIdentifier("login.submit")
        }
        .padding(20)
        .companionGlass(radius: 26)
    }

    private func submit() {
        guard !busy, !googleBusy, !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !password.isEmpty else { return }
        busy = true
        error = nil
        Task {
            do {
                try await sessionStore.signIn(email: email, password: password)
            } catch let apiError as APIError {
                error = apiError.status == 0
                    ? "The server could not be reached. Check that the Conductor stack is running."
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
                    callbackScheme: AppConfig.callbackScheme
                )
                let callbackURL = try await googleCoordinator.authenticate(
                    at: authorization.proxyURL,
                    callbackScheme: AppConfig.callbackScheme
                )
                try await sessionStore.completeGoogleSignIn(callbackURL: callbackURL)
            } catch GoogleSignInError.cancelled {
                self.error = nil
            } catch let apiError as APIError where apiError.status == 0 {
                self.error = "The server could not be reached. Check that the Conductor stack is running."
            } catch {
                self.error = "Google sign-in is unavailable. Try again later."
            }
            googleBusy = false
        }
    }
}

private extension View {
    func fieldStyle() -> some View {
        self
            .padding(.horizontal, 12)
            .frame(minHeight: 48)
            .companionGlass(radius: 14, interactive: true)
    }
}

#Preview {
    LoginView()
        .environment(SessionStore(apiURL: URL(string: "http://127.0.0.1:3001")!))
}
