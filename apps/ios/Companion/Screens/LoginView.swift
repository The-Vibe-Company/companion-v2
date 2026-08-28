import SwiftUI
import CompanionKit

struct LoginView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(ExternalOAuthCoordinator.self) private var externalOAuth
    @State private var email = ""
    @State private var password = ""
    @State private var passwordVisible = false
    @State private var busy = false
    @State private var googleBusy = false
    @State private var error: String?
    @FocusState private var focusedField: Field?

    private enum Field { case email, password }

    var body: some View {
        CompanionBackdrop {
            ScrollView {
                VStack(spacing: 28) {
                    Spacer(minLength: 64)
                    brand
                    form
                    if googleFlowActive {
                        googleWaitingSurface
                    }
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
        .onChange(of: externalOAuth.callbackGeneration) { _, _ in
            guard externalOAuth.activeFlow?.isGoogle == true,
                  let callbackURL = externalOAuth.takeCallback() else { return }
            Task { await completeGoogleSignIn(callbackURL) }
        }
    }

    private var brand: some View {
        VStack(spacing: 14) {
            Image("CompanionMark")
                .resizable()
                .scaledToFit()
                .padding(12)
                .frame(width: 82, height: 82)
                .companionGlass(radius: 18)
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
                    Text(googleBusy
                        ? (googleFlowActive ? "Google sign-in waiting…" : "Opening Google…")
                        : "Continue with Google")
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
        .companionGlass(radius: 18)
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
                externalOAuth.beginGoogle(
                    proxyURL: authorization.proxyURL,
                    callbackScheme: AppConfig.callbackScheme,
                    nativeState: authorization.nativeState
                )
            } catch let apiError as APIError where apiError.status == 0 {
                self.error = "The server could not be reached. Check that the Conductor stack is running."
                googleBusy = false
            } catch {
                self.error = "Google sign-in is unavailable. Try again later."
                googleBusy = false
            }
        }
    }

    private var googleFlowActive: Bool {
        externalOAuth.activeFlow?.isGoogle == true
    }

    @ViewBuilder
    private var googleWaitingSurface: some View {
        if googleFlowActive {
            VStack(alignment: .leading, spacing: 12) {
                Label("Google sign-in", systemImage: "arrow.up.right.square")
                    .font(.headline)
                    .foregroundStyle(Color.companionInk)

                switch externalOAuth.phase {
                case .waiting:
                    Text("Google is open in your default browser. Return here after you finish signing in.")
                case .timedOut:
                    Text("No callback arrived. You can reopen Google sign-in or cancel this attempt.")
                case .failed(let message):
                    Text(message)
                case .completing:
                    Text("Finishing Google sign-in…")
                case .idle:
                    EmptyView()
                }

                if externalOAuth.phase != .completing {
                    HStack(spacing: 10) {
                        Button("Reopen", systemImage: "arrow.clockwise") {
                            externalOAuth.reopen()
                        }
                        .buttonStyle(.glass)
                        .accessibilityIdentifier("login.google.reopen")

                        Button("Cancel", systemImage: "xmark") {
                            cancelGoogleSignIn()
                        }
                        .buttonStyle(.glass)
                        .accessibilityIdentifier("login.google.cancel")
                    }
                }
            }
            .font(.subheadline)
            .foregroundStyle(Color.companionMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .companionGlass(radius: 18)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("login.google.waiting")
        }
    }

    private func cancelGoogleSignIn() {
        let nativeState = externalOAuth.activeFlow?.googleNativeState
        externalOAuth.cancel()
        if let nativeState {
            Task { await sessionStore.cancelGoogleSignIn(expectedNativeState: nativeState) }
        }
        googleBusy = false
        error = nil
    }

    private func completeGoogleSignIn(_ callbackURL: URL) async {
        do {
            try await sessionStore.completeGoogleSignIn(
                callbackURL: callbackURL,
                callbackScheme: AppConfig.callbackScheme
            )
            externalOAuth.completeSuccessfully()
        } catch let apiError as APIError where apiError.status == 0 {
            externalOAuth.fail("The server could not be reached. Try Google sign-in again.")
            error = "The server could not be reached. Try Google sign-in again."
            googleBusy = false
        } catch {
            externalOAuth.fail("Google sign-in could not be completed. Try again.")
            self.error = "Google sign-in could not be completed. Try again."
            googleBusy = false
        }
    }
}

private extension View {
    func fieldStyle() -> some View {
        self
            .padding(.horizontal, 12)
            .frame(minHeight: 48)
            .companionGlass(radius: 18, interactive: true)
    }
}

#Preview {
    LoginView()
        .environment(SessionStore(apiURL: URL(string: "http://127.0.0.1:3001")!))
        .environment(ExternalOAuthCoordinator())
}
