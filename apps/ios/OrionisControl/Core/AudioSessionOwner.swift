import AVFoundation

/// The two calls this app makes against the audio session.
///
/// Narrow on purpose: it exists so the claim-counting below can be tested
/// without activating real audio on a CI runner, not to abstract AVFoundation.
protocol AudioSessionConfiguring: AnyObject {
    func setCategory(
        _ category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions
    ) throws
    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws
}

extension AVAudioSession: AudioSessionConfiguring {}

/// The one place in the app that touches `AVAudioSession`.
///
/// The audio session is process-wide and shared with the rest of the device.
/// Two players independently configuring it is what produced the bug this type
/// exists to prevent: the live viewer set `.playback` and left it set, the
/// recordings player then started a clip and implicitly activated that
/// category, and nothing ever deactivated it — so the app held the device's
/// audio until it was force-quit.
///
/// Two rules follow from that, and both are load-bearing:
///
///   1. **Never take the audio exclusively.** `.mixWithOthers` is not a
///      nicety here. Without it, activating an output-only category interrupts
///      every other session on the device — a call, a screen share, a
///      recording with the microphone open — and none of them come back on
///      their own. A camera monitor has no business silencing a phone call, so
///      it mixes and lets the other audio continue.
///   2. **Give it back.** Deactivation posts `.notifyOthersOnDeactivation`, so
///      anything that ducked or paused for us is told it may resume.
///
/// Claims are counted rather than boolean, because the live viewer and the
/// recordings timeline can both want audio across a navigation transition. The
/// session is activated when the first claim arrives and released when the last
/// one goes, so neither player can deactivate audio the other is still using.
@MainActor
final class AudioSessionOwner {
    static let shared = AudioSessionOwner()

    private let session: any AudioSessionConfiguring
    private var claimants: Set<ObjectIdentifier> = []
    private(set) var isActive = false

    init(session: any AudioSessionConfiguring = AVAudioSession.sharedInstance()) {
        self.session = session
    }

    /// Registers a claim and activates the session if it is not already live.
    ///
    /// Returns whether audio is actually usable, so a caller can report an
    /// honest failure instead of playing silently and looking broken.
    @discardableResult
    func claim(_ claimant: AnyObject) -> Bool {
        claimants.insert(ObjectIdentifier(claimant))
        return activateIfNeeded()
    }

    func relinquish(_ claimant: AnyObject) {
        relinquish(id: ObjectIdentifier(claimant))
    }

    /// Identifier-based release, for a `deinit` that must not escape `self`.
    func relinquish(id: ObjectIdentifier) {
        claimants.remove(id)
        guard claimants.isEmpty, isActive else { return }
        // Telling other apps is the whole point: something ducked or stopped
        // when we activated, and silence afterwards is indistinguishable from
        // a broken device.
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        isActive = false
    }

    /// iOS deactivated the session under us — a call arrived, or another app
    /// took over. The claim survives so the interrupted player can reactivate
    /// when the interruption ends; only the active flag is cleared.
    func noteSystemDeactivation() {
        isActive = false
    }

    /// Re-applies the category after the output route changes.
    ///
    /// Switching to Bluetooth, AirPlay or headphones can leave the session on a
    /// route the category no longer describes, and the session is still active,
    /// so a plain claim would return early and change nothing.
    @discardableResult
    func reassertCategory() -> Bool {
        guard !claimants.isEmpty else { return false }
        isActive = false
        return activateIfNeeded()
    }

    private func activateIfNeeded() -> Bool {
        guard !isActive else { return true }
        do {
            // Receive-only: this app plays camera audio and never records.
            // `.mixWithOthers` keeps every other session on the device alive,
            // including a microphone capture we must not disturb.
            try session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
            // `options:` is explicit because the AudioSessionConfiguring protocol
            // declares no default for it — AVAudioSession's own overload does, but
            // the call goes through the protocol so the argument must be passed.
            try session.setActive(true, options: [])
            isActive = true
            return true
        } catch {
            // Leave the claim in place: a later attempt (a route change, an
            // interruption ending) can still succeed, and dropping the claim
            // here would make the eventual release unbalanced.
            return false
        }
    }
}
