import SwiftUI

struct BootstrapView: View {
    let error: String?
    let retry: () -> Void

    var body: some View {
        CompanionBackdrop {
            VStack(spacing: 18) {
                Image("CompanionMark")
                    .resizable()
                    .scaledToFit()
                    .padding(10)
                    .frame(width: 66, height: 66)
                    .companionGlass(radius: 20)
                    .accessibilityLabel("Companion")

                VStack(spacing: 6) {
                    Text("Companion")
                        .font(.title3.weight(.semibold))
                    Text(error ?? "Restoring your session…")
                        .font(.subheadline)
                        .foregroundStyle(Color.companionMuted)
                        .multilineTextAlignment(.center)
                }

                if error == nil {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Restoring session")
                } else {
                    Button("Try again", action: retry)
                        .buttonStyle(.glassProminent)
                }
            }
            .padding(32)
            .companionGlass(radius: 28)
            .padding(24)
        }
    }
}

#Preview {
    BootstrapView(error: nil) {}
}
