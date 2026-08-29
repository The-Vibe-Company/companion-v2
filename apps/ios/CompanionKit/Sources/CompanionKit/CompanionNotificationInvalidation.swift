import Foundation

/// Retains push-driven transcript invalidations until the authenticated session store is ready.
///
/// APNs can deliver a response before SwiftUI has restored and bound the active session. Keeping
/// this queue independent from navigation lets the notification path invalidate the same
/// local-first cache whether the destination chat is new, reused, or already visible.
@MainActor
public final class CompanionNotificationInvalidationQueue {
    public typealias Handler = @MainActor (String) -> Void
    public typealias BackgroundRefreshHandler = @MainActor (String) async -> CompanionCacheRefreshResult

    private struct Request: Hashable {
        let scopeID: String
        let companionID: String
    }

    private var installedScopeID: String?
    private var handler: Handler?
    private var backgroundRefreshHandler: BackgroundRefreshHandler?
    private var pendingRequests: [Request] = []
    private var pendingRequestSet: Set<Request> = []
    private var pendingBackgroundRequests: [Request] = []
    private var pendingBackgroundRequestSet: Set<Request> = []

    public init() {}

    /// Installs the current session's cache-invalidation hook and replays each coalesced request.
    public func install(
        scopeID: String,
        _ handler: @escaping Handler,
        backgroundRefresh: BackgroundRefreshHandler? = nil
    ) {
        installedScopeID = scopeID
        self.handler = handler
        backgroundRefreshHandler = backgroundRefresh
        let pending = pendingRequests.filter { $0.scopeID == scopeID }
        let pendingBackground = pendingBackgroundRequests.filter { $0.scopeID == scopeID }
        pendingRequests.removeAll(keepingCapacity: true)
        pendingRequestSet.removeAll(keepingCapacity: true)
        pendingBackgroundRequests.removeAll(keepingCapacity: true)
        pendingBackgroundRequestSet.removeAll(keepingCapacity: true)
        for request in pending {
            handler(request.companionID)
        }
        if let backgroundRefresh {
            for request in pendingBackground {
                Task { @MainActor in
                    _ = await backgroundRefresh(request.companionID)
                }
            }
        } else {
            for request in pendingBackground {
                enqueueBackground(request)
            }
        }
    }

    /// Removes closures that capture a signed-out session and discards its pending work.
    public func uninstall() {
        installedScopeID = nil
        handler = nil
        backgroundRefreshHandler = nil
        pendingRequests.removeAll(keepingCapacity: true)
        pendingRequestSet.removeAll(keepingCapacity: true)
        pendingBackgroundRequests.removeAll(keepingCapacity: true)
        pendingBackgroundRequestSet.removeAll(keepingCapacity: true)
    }

    /// Invalidates immediately when session state is ready, or retains one request per Companion.
    public func invalidate(scopeID: String, companionID: String) {
        guard !scopeID.isEmpty, !companionID.isEmpty else { return }
        if installedScopeID == scopeID, let handler {
            handler(companionID)
            return
        }
        guard installedScopeID == nil else { return }
        enqueue(Request(scopeID: scopeID, companionID: companionID))
    }

    /// Runs an APNs background refresh to completion so the delegate can report a truthful result.
    public func refresh(scopeID: String, companionID: String) async -> CompanionCacheRefreshResult {
        guard !scopeID.isEmpty, !companionID.isEmpty else { return .noData }
        let request = Request(scopeID: scopeID, companionID: companionID)
        // A background push can reach UIApplicationDelegate just before SwiftUI binds the restored
        // active session. Give that launch race a short, bounded window without holding a callback
        // indefinitely when the owner is signed out.
        for attempt in 0..<20 {
            if installedScopeID == scopeID, let backgroundRefreshHandler {
                return await backgroundRefreshHandler(companionID)
            }
            if installedScopeID != nil { return .failed }
            guard attempt < 19 else { break }
            do {
                try await Task.sleep(for: .milliseconds(50))
            } catch {
                return .failed
            }
        }
        // The OS callback has a bounded lifetime, but the invalidation must survive a slower cold
        // restore. A matching session installation will replay it through the ordinary narrow seam.
        enqueueBackground(request)
        return .failed
    }

    private func enqueue(_ request: Request) {
        guard pendingRequestSet.insert(request).inserted else { return }
        pendingRequests.append(request)
    }

    private func enqueueBackground(_ request: Request) {
        guard pendingBackgroundRequestSet.insert(request).inserted else { return }
        pendingBackgroundRequests.append(request)
    }
}
