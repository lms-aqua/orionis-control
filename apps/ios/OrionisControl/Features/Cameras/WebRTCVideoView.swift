import SwiftUI
import WebRTC

/// Renders a WebRTC video track with the Metal-backed renderer.
///
/// Mirrors `CameraVideoView` (which wraps `AVPlayerViewController`) so the two
/// transports are interchangeable in the viewer. It observes the player's
/// `remoteVideoTrack` and attaches itself the moment the track arrives, so the
/// picture appears without the view being rebuilt.
struct WebRTCVideoView: UIViewRepresentable {
    /// Passed in (not read from the player inside `updateUIView`) so the owning
    /// view body observes `remoteVideoTrack` and re-evaluates — which is what
    /// drives `updateUIView` to attach the renderer the moment the track lands.
    let track: RTCVideoTrack?
    /// `false` letterboxes the whole frame; `true` fills and crops.
    var fills = false

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView()
        view.videoContentMode = fills ? .scaleAspectFill : .scaleAspectFit
        view.clipsToBounds = true
        // The renderer draws nothing until a frame lands; keep it black meanwhile
        // so it matches the surrounding placeholder rather than flashing white.
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ view: RTCMTLVideoView, context: Context) {
        view.videoContentMode = fills ? .scaleAspectFill : .scaleAspectFit

        if context.coordinator.track !== track {
            context.coordinator.track?.remove(view)
            track?.add(view)
            context.coordinator.track = track
        }
    }

    static func dismantleUIView(_ view: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.track?.remove(view)
        coordinator.track = nil
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var track: RTCVideoTrack?
    }
}
