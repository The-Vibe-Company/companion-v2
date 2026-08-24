import SwiftUI

struct BootstrapView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "message.fill")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(Color.companionAccentForeground)
                .frame(width: 52, height: 52)
                .background(Color.companionAccent)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            VStack(spacing: 6) {
                Text("Companion")
                    .font(.system(size: 20, weight: .semibold))

                Text("Restoring your session…")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.companionMuted)
            }

            ProgressView()
                .controlSize(.small)
                .accessibilityLabel("Restoring session")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.companionCanvas)
    }
}

#Preview {
    BootstrapView()
}
