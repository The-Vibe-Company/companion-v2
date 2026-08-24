import Observation
import SwiftUI

@MainActor
@Observable
final class AppRouter {
    var path = NavigationPath()
}
