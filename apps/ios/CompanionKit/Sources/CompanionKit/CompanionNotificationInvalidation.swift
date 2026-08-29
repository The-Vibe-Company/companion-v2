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

    private struct ActiveBackgroundRefresh {
        let id: UUID
        let task: Task<CompanionCacheRefreshResult, Never>
    }

    private var installedScopeID: String?
    private var handler: Handler?
    private var backgroundRefreshHandler: BackgroundRefreshHandler?
    private var pendingRequests: [Request] = []
    private var pendingRequestSet: Set<Request> = []
    private var pendingBackgroundRequests: [Request] = []
    private var pendingBackgroundRequestSet: Set<Request> = []
    private var activeBackgroundRefreshes: [Request: ActiveBackgroundRefresh] = [:]

    public init() {}

    /// Installs the current session's cache-invalidation hook and replays each coalesced request.
    public func install(
        scopeID: String,
        _ handler: @escaping Handler,
        backgroundRefresh: BackgroundRefreshHandler? = nil
    ) {
        cancelActiveBackgroundRefreshes()
        installedScopeID = scopeID
        self.handler = handler
        backgroundRefreshHandler = backgroundRefresh
        let pending = pendingRequests.filter { $0.scopeID == scopeID }
        let pendingBackground = pendingBackgroundRequests.filter { $0.scopeID == scopeID }
        pendingRequests.removeAll { $0.scopeID == scopeID }
        pendingBackgroundRequests.removeAll { $0.scopeID == scopeID }
        for request in pending { pendingRequestSet.remove(request) }
        for request in pendingBackground { pendingBackgroundRequestSet.remove(request) }
        for request in pending {
            handler(request.companionID)
        }
        if backgroundRefresh != nil {
            for request in pendingBackground {
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    _ = await self.runBackgroundRefresh(request)
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
        cancelActiveBackgroundRefreshes()
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
            if installedScopeID == scopeID, backgroundRefreshHandler != nil {
                return await runBackgroundRefresh(request)
            }
            if installedScopeID != nil {
                enqueueBackground(request)
                return .failed
            }
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

    private func runBackgroundRefresh(
        _ request: Request
    ) async -> CompanionCacheRefreshResult {
        if let active = activeBackgroundRefreshes[request] {
            return await active.task.value
        }
        guard installedScopeID == request.scopeID,
              let backgroundRefreshHandler else { return .failed }
        let id = UUID()
        let task = Task { @MainActor in
            await backgroundRefreshHandler(request.companionID)
        }
        activeBackgroundRefreshes[request] = ActiveBackgroundRefresh(id: id, task: task)
        let result = await task.value
        if activeBackgroundRefreshes[request]?.id == id {
            activeBackgroundRefreshes[request] = nil
        }
        return result
    }

    private func cancelActiveBackgroundRefreshes() {
        for active in activeBackgroundRefreshes.values {
            active.task.cancel()
        }
        activeBackgroundRefreshes.removeAll(keepingCapacity: true)
    }
}
