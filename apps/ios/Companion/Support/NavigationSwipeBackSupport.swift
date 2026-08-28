import SwiftUI
import UIKit

/// Keeps UIKit's native leading-edge pop transition available when a SwiftUI destination hides
/// the system back button in favor of a custom, accessible toolbar button.
private struct CompanionNavigationSwipeBackInstaller: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> SwipeBackInstallerViewController {
        SwipeBackInstallerViewController()
    }

    func updateUIViewController(
        _ viewController: SwipeBackInstallerViewController,
        context: Context
    ) {
        viewController.scheduleInstallation()
    }

    static func dismantleUIViewController(
        _ viewController: SwipeBackInstallerViewController,
        coordinator: ()
    ) {
        viewController.uninstall()
    }
}

private final class SwipeBackInstallerViewController: UIViewController, UIGestureRecognizerDelegate {
    private weak var installedGesture: UIGestureRecognizer?
    private weak var installedNavigationController: UINavigationController?
    private weak var previousDelegate: (any UIGestureRecognizerDelegate)?
    private var installationTask: Task<Void, Never>?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        installIfVisible()
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        scheduleInstallation()
    }

    func scheduleInstallation() {
        guard installationTask == nil else { return }
        installationTask = Task { @MainActor [weak self] in
            await Task.yield()
            guard !Task.isCancelled, let self else { return }
            installationTask = nil
            installIfVisible()
        }
    }

    func uninstall() {
        installationTask?.cancel()
        installationTask = nil
        guard let installedGesture else { return }
        if installedGesture.delegate === self {
            installedGesture.delegate = previousDelegate
            installedGesture.isEnabled = (installedNavigationController?.viewControllers.count ?? 0) > 1
        }
        self.installedGesture = nil
        installedNavigationController = nil
        previousDelegate = nil
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === installedGesture,
              let installedNavigationController else { return false }
        return installedNavigationController.viewControllers.count > 1
            && installedNavigationController.transitionCoordinator == nil
    }

    private func installIfVisible() {
        guard let navigationController,
              isContained(in: navigationController.topViewController),
              let gesture = navigationController.interactivePopGestureRecognizer else { return }

        if installedGesture !== gesture {
            uninstall()
            installedGesture = gesture
            installedNavigationController = navigationController
            previousDelegate = gesture.delegate
        }

        gesture.delegate = self
        gesture.isEnabled = navigationController.viewControllers.count > 1
    }

    private func isContained(in viewController: UIViewController?) -> Bool {
        var ancestor: UIViewController? = self
        while let current = ancestor {
            if current === viewController { return true }
            ancestor = current.parent
        }
        return false
    }
}

extension View {
    func companionNavigationSwipeBackEnabled() -> some View {
        background {
            CompanionNavigationSwipeBackInstaller()
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
    }
}
