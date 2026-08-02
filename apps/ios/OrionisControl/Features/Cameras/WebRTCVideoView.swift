import SwiftUI
import WebRTC

/// Hosts the WebRTC player's Metal renderer.
///
/// The renderer is owned by `WebRTCStreamPlayer`, which attaches the remote track
/// to it the moment the track arrives. This view only places that renderer in the
/// SwiftUI hierarchy — deliberately no track logic here, so rendering never waits
/// on a view re-render (the race that caused a black first open).
struct WebRTCVideoView: UIViewRepresentable {
    let renderer: RTCMTLVideoView
    /// `false` letterboxes the whole frame; `true` fills and crops.
    var fills = false

    func makeUIView(context: Context) -> RTCMTLVideoView {
        renderer.videoContentMode = fills ? .scaleAspectFill : .scaleAspectFit
        renderer.clipsToBounds = true
        renderer.backgroundColor = .black
        return renderer
    }

    func updateUIView(_ view: RTCMTLVideoView, context: Context) {
        view.videoContentMode = fills ? .scaleAspectFill : .scaleAspectFit
    }
}
