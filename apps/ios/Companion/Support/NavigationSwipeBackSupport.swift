import SwiftUI
import UIKit

/// Installs the system pop gesture and a small supplemental leading-edge pan once, at the root
/// NavigationStack. The supplemental recognizer covers the area just outside UIKit's native edge
/// band, while the native recognizer remains responsible for its own transition.
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
    private static let nativeLeadingEdgeBand: CGFloat = 20
    private static let supplementalLeadingEdgeBand: CGFloat = 52
    private static let decisiveTranslation: CGFloat = 48

    private weak var installedNativeGesture: UIGestureRecognizer?
    private weak var installedNavigationController: UINavigationController?
    private weak var previousNativeDelegate: (any UIGestureRecognizerDelegate)?
    private weak var supplementalPan: UIPanGestureRecognizer?
    private weak var supplementalTouchView: UIView?
    private var installationTask: Task<Void, Never>?
    private var didTriggerSupplementalPop = false

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

        if let supplementalPan, supplementalPan.delegate === self {
            supplementalPan.delegate = nil
            supplementalPan.view?.removeGestureRecognizer(supplementalPan)
        }
        supplementalPan = nil
        supplementalTouchView = nil

        if let installedNativeGesture,
           installedNativeGesture.delegate === self {
            installedNativeGesture.delegate = previousNativeDelegate
            installedNativeGesture.isEnabled = (installedNavigationController?.viewControllers.count ?? 0) > 1
        }
        installedNativeGesture = nil
        installedNavigationController = nil
        previousNativeDelegate = nil
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let navigationController = installedNavigationController,
              navigationController.transitionCoordinator == nil else { return false }

        if gestureRecognizer === installedNativeGesture {
            guard navigationController.viewControllers.count > 1 else { return false }
            return previousNativeDelegate?.gestureRecognizerShouldBegin?(gestureRecognizer) ?? true
        }

        guard gestureRecognizer === supplementalPan,
              navigationController.viewControllers.count > 1,
              let pan = gestureRecognizer as? UIPanGestureRecognizer,
              let view = pan.view else { return false }

        // A horizontal content scroller owns its own drag. Keep the supplemental recognizer out
        // of that interaction even when it begins near the leading edge.
        if let scrollView = enclosingHorizontalScrollView(of: pan) {
            let hasHorizontalContent = scrollView.alwaysBounceHorizontal
                || scrollView.contentSize.width > scrollView.bounds.width + 1
            if hasHorizontalContent { return false }
        }

        let velocity = pan.velocity(in: view)
        let translation = pan.translation(in: view)
        guard velocity.x > 0,
              velocity.x > abs(velocity.y) * 1.2,
              translation.x > 6 else { return false }
        didTriggerSupplementalPop = false
        return true
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldReceive touch: UITouch
    ) -> Bool {
        guard gestureRecognizer === supplementalPan,
              let view = gestureRecognizer.view else { return true }
        let x = touch.location(in: view).x
        // UIKit owns the first ~20pt. This recognizer owns only the remainder through 52pt.
        guard x > Self.nativeLeadingEdgeBand,
              x <= Self.supplementalLeadingEdgeBand else { return false }
        supplementalTouchView = touch.view
        return true
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        if gestureRecognizer === supplementalPan,
           otherGestureRecognizer === installedNativeGesture {
            return true
        }
        if gestureRecognizer === installedNativeGesture,
           otherGestureRecognizer === supplementalPan {
            return true
        }
        // Do not cancel a scroll view's pan merely because a touch happened to begin near the edge.
        if gestureRecognizer === supplementalPan,
           otherGestureRecognizer.view is UIScrollView {
            return true
        }
        if gestureRecognizer === supplementalPan,
           otherGestureRecognizer is UIPanGestureRecognizer {
            return true
        }
        return false
    }

    func handleSupplementalPan(_ pan: UIPanGestureRecognizer) {
        guard pan.state == .ended, !didTriggerSupplementalPop else { return }
        let translation = pan.translation(in: pan.view)
        let velocity = pan.velocity(in: pan.view)
        guard let navigationController = installedNavigationController else { return }
        guard translation.x >= Self.decisiveTranslation,
              translation.x > abs(translation.y) * 1.15,
              velocity.x >= 0,
              !hasCompetingHorizontalDrag(excluding: pan),
              navigationController.transitionCoordinator == nil,
              navigationController.viewControllers.count > 1 else { return }
        didTriggerSupplementalPop = true
        navigationController.popViewController(animated: true)
    }

    private func installIfVisible() {
        guard let navigationController,
              let nativeGesture = navigationController.interactivePopGestureRecognizer else { return }

        if installedNavigationController !== navigationController {
            uninstall()
            installedNavigationController = navigationController
        }

        if installedNativeGesture !== nativeGesture {
            installedNativeGesture = nativeGesture
            previousNativeDelegate = nativeGesture.delegate
        }
        nativeGesture.delegate = self
        // Leave the recognizer installed at the root; the delegate's stack-count guard prevents
        // a root pop and avoids relying on a destination update to re-enable it after every push.
        nativeGesture.isEnabled = true

        if supplementalPan?.view !== navigationController.view {
            if let oldPan = supplementalPan {
                oldPan.view?.removeGestureRecognizer(oldPan)
            }
            let pan = UIPanGestureRecognizer(target: self, action: #selector(supplementalPanChanged(_:)))
            pan.delegate = self
            pan.cancelsTouchesInView = false
            pan.delaysTouchesBegan = false
            pan.delaysTouchesEnded = false
            navigationController.view.addGestureRecognizer(pan)
            supplementalPan = pan
        }
    }

    @objc private func supplementalPanChanged(_ pan: UIPanGestureRecognizer) {
        handleSupplementalPan(pan)
    }

    private func enclosingHorizontalScrollView(of pan: UIPanGestureRecognizer) -> UIScrollView? {
        var view: UIView? = supplementalTouchView ?? pan.view
        while let current = view {
            if let scroll = current as? UIScrollView { return scroll }
            view = current.superview
        }
        return nil
    }

    private func hasCompetingHorizontalDrag(excluding pan: UIPanGestureRecognizer) -> Bool {
        var view = supplementalTouchView
        while let current = view, current !== pan.view {
            for case let recognizer as UIPanGestureRecognizer in current.gestureRecognizers ?? [] {
                guard recognizer !== pan,
                      recognizer !== installedNativeGesture,
                      recognizer.state == .began || recognizer.state == .changed || recognizer.state == .ended else {
                    continue
                }
                if let scrollView = recognizer.view as? UIScrollView {
                    let scrollsHorizontally = scrollView.alwaysBounceHorizontal
                        || scrollView.contentSize.width > scrollView.bounds.width + 1
                    if !scrollsHorizontally { continue }
                }
                let velocity = recognizer.velocity(in: recognizer.view)
                if abs(velocity.x) > abs(velocity.y) { return true }
            }
            view = current.superview
        }
        return false
    }
}

extension View {
    func companionNavigationSwipeBackEnabled(_ enabled: Bool = true) -> some View {
        background {
            if enabled {
                CompanionNavigationSwipeBackInstaller()
                    .frame(width: 0, height: 0)
                    .accessibilityHidden(true)
            }
        }
    }
}
