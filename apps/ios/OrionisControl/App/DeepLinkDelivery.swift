import SwiftUI

/// Delivers a pending deep-link destination to the view that owns it.
///
/// `.onChange` alone is not sufficient. On a cold start the URL arrives at
/// `onOpenURL` while auth is still `.initialising`, so `RootView` is showing a
/// loading state and the destination's owning view does not exist yet. By the
/// time it mounts, `pendingDestination` was set long ago — and `.onChange` does
/// not fire for a value that was already in place, so the destination was
/// silently dropped. That is the terminated-app notification-tap path, which is
/// exactly when a deep link matters most.
///
/// This receiver checks the current value on mount *and* observes later
/// changes, so warm and cold starts behave identically. The destination is
/// consumed synchronously before any `await`, so a mount that races a change
/// cannot deliver it twice.
private struct DeepLinkReceiver: ViewModifier {
    let router: DeepLinkRouter
    let matches: (DeepLinkRouter.Destination) -> Bool
    let action: (DeepLinkRouter.Destination) async -> Void

    func body(content: Content) -> some View {
        content
            // Cold start: the value is already present when this view appears.
            .task { await deliver() }
            // Warm: the value arrives while this view is already on screen.
            .onChange(of: router.pendingDestination) { _, _ in
                Task { await deliver() }
            }
    }

    @MainActor
    private func deliver() async {
        guard let destination = router.pendingDestination, matches(destination) else { return }
        // Consume before awaiting. Both entry points can run for one value, and
        // whichever arrives first takes ownership of it.
        _ = router.consume()
        await action(destination)
    }
}

extension View {
    /// Handles a deep-link destination this view is responsible for presenting.
    ///
    /// - Parameters:
    ///   - router: the shared router holding the pending destination.
    ///   - matches: whether this view owns the destination. A view must only
    ///     claim destinations it can actually present, or it will consume one
    ///     meant for another screen.
    ///   - action: presents the destination. Runs at most once per destination.
    func onDeepLink(
        _ router: DeepLinkRouter,
        matching matches: @escaping (DeepLinkRouter.Destination) -> Bool,
        perform action: @escaping (DeepLinkRouter.Destination) async -> Void
    ) -> some View {
        modifier(DeepLinkReceiver(router: router, matches: matches, action: action))
    }
}
