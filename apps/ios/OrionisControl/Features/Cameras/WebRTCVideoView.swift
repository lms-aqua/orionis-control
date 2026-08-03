import SwiftUI
import UIKit
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

    func makeUIView(context: Context) -> WebRTCRendererHostView {
        WebRTCRendererHostView(renderer: renderer, fills: fills)
    }

    func updateUIView(_ view: WebRTCRendererHostView, context: Context) {
        view.update(fills: fills)
    }

    static func dismantleUIView(_ view: WebRTCRendererHostView, coordinator: Void) {
        view.detachRenderer()
    }
}

/// SwiftUI owns this stable container while the stream player owns the renderer.
/// Returning the externally-owned Metal view directly made SwiftUI re-parent the
/// decoder surface during hierarchy changes, which could present as dropped or
/// uneven frames when controls appeared and disappeared.
final class WebRTCRendererHostView: UIView {
    private let renderer: RTCMTLVideoView

    init(renderer: RTCMTLVideoView, fills: Bool) {
        self.renderer = renderer
        super.init(frame: .zero)
        backgroundColor = .black
        clipsToBounds = true
        if renderer.superview !== self {
            renderer.removeFromSuperview()
            renderer.translatesAutoresizingMaskIntoConstraints = false
            addSubview(renderer)
            NSLayoutConstraint.activate([
                renderer.leadingAnchor.constraint(equalTo: leadingAnchor),
                renderer.trailingAnchor.constraint(equalTo: trailingAnchor),
                renderer.topAnchor.constraint(equalTo: topAnchor),
                renderer.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
        }
        update(fills: fills)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    func update(fills: Bool) {
        let mode: UIView.ContentMode = fills ? .scaleAspectFill : .scaleAspectFit
        // Setting content mode on every SwiftUI update can flush Metal layout
        // work even when nothing changed (for example when chrome auto-hides).
        if renderer.videoContentMode != mode { renderer.videoContentMode = mode }
    }

    func detachRenderer() {
        if renderer.superview === self { renderer.removeFromSuperview() }
    }
}
