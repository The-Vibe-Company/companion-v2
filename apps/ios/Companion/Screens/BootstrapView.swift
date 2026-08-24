import SwiftUI

struct BootstrapView: View {
    let error: String?
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image("CompanionMark")
                .resizable()
                .scaledToFit()
                .padding(5)
                .frame(width: 52, height: 52)
                .background(Color.companionSurface)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Color.companionBorder, lineWidth: 0.5)
                }
                .accessibilityLabel("Companion")

            VStack(spacing: 6) {
                Text("Companion")
                    .font(.system(size: 20, weight: .semibold))
                Text(error ?? "Restoring your session…")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.companionMuted)
                    .multilineTextAlignment(.center)
            }

            if error == nil {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Restoring session")
            } else {
                Button("Try again", action: retry)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.companionCanvas)
    }
}

#Preview {
    BootstrapView(error: nil) {}
}
