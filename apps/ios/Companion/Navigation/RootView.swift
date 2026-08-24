import SwiftUI

struct RootView: View {
    @State private var router = AppRouter()

    var body: some View {
        NavigationStack(path: $router.path) {
            BootstrapView()
        }
        .environment(router)
        .tint(.companionAccent)
    }
}
