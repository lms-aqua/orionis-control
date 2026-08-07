import SwiftUI

/// The Orionis "Command Deck" design system.
///
/// One place for colour, depth, and the surfaces every screen is built from.
/// Every token adapts to light and dark; dark is the app's primary look. Colours
/// are defined in code (not the asset catalogue) so the whole palette lives in
/// one readable file.
enum Theme {
    // Grounds & surfaces — layered, low-chroma, biased toward the blue accent.
    static let ground = Color(lightHex: 0xEFF2F8, darkHex: 0x0B0E14)
    static let surface = Color(lightHex: 0xFFFFFF, darkHex: 0x141922)
    static let surfaceRaised = Color(lightHex: 0xFFFFFF, darkHex: 0x1A2029)
    static let inset = Color(lightHex: 0xE9EDF4, darkHex: 0x10151D)

    // Lines & edges.
    static let hairline = Color(lightHex: 0x0B0E14, darkHex: 0xFFFFFF, lightAlpha: 0.09, darkAlpha: 0.08)
    static let edgeLight = Color(lightHex: 0xFFFFFF, darkHex: 0xFFFFFF, lightAlpha: 0.0, darkAlpha: 0.06)

    // Text.
    static let textPrimary = Color(lightHex: 0x0E1420, darkHex: 0xEAF0FA)
    static let textSecondary = Color(lightHex: 0x5A6678, darkHex: 0x8A97AC)
    static let textTertiary = Color(lightHex: 0x93A0B4, darkHex: 0x5A6678)

    // Accent — one hue, spent sparingly.
    static let accent = Color(lightHex: 0x2E62E0, darkHex: 0x4C82FF)

    // Semantic state — separate from the accent, never used decoratively.
    static let good = Color(lightHex: 0x12A87B, darkHex: 0x33D69F)
    static let warn = Color(lightHex: 0xC07A00, darkHex: 0xF5A524)
    static let critical = Color(lightHex: 0xDD343A, darkHex: 0xF2555A)

    /// A translucent wash of any state colour, for chip and icon-tile fills.
    static func soft(_ color: Color) -> Color { color.opacity(0.15) }

    // Geometry.
    static let cardRadius: CGFloat = 18
    static let tileRadius: CGFloat = 13
}

// MARK: - Adaptive colour construction

extension Color {
    /// A colour that resolves to one of two hex values per interface style.
    init(lightHex: UInt, darkHex: UInt, lightAlpha: Double = 1, darkAlpha: Double = 1) {
        self = Color(uiColor: UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor(hex: darkHex, alpha: darkAlpha)
                : UIColor(hex: lightHex, alpha: lightAlpha)
        })
    }
}

extension UIColor {
    convenience init(hex: UInt, alpha: Double = 1) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            alpha: alpha)
    }
}

// MARK: - Surfaces

/// The app's ground: a near-black (dark) / cool-white (light) field with a faint
/// accent atmosphere in the corners. Placed behind screen content.
struct AppBackground: View {
    var body: some View {
        ZStack {
            Theme.ground
            RadialGradient(
                gradient: Gradient(colors: [Theme.accent.opacity(0.10), .clear]),
                center: .topLeading, startRadius: 0, endRadius: 460)
            RadialGradient(
                gradient: Gradient(colors: [Color(lightHex: 0x8A6CFF, darkHex: 0x6A4CFF).opacity(0.07), .clear]),
                center: .topTrailing, startRadius: 0, endRadius: 420)
        }
        .ignoresSafeArea()
    }
}

/// The card treatment used across the app: a raised surface, a hairline edge, a
/// whisper of top edge-light, and soft ambient depth.
struct OrionisCard: ViewModifier {
    var radius: CGFloat = Theme.cardRadius
    var fill: Color = Theme.surface

    func body(content: Content) -> some View {
        content
            .background(fill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Theme.hairline, lineWidth: 1)
            )
            .overlay(alignment: .top) {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [Theme.edgeLight, .clear],
                            startPoint: .top, endPoint: .center),
                        lineWidth: 1)
            }
            .shadow(color: .black.opacity(0.16), radius: 14, x: 0, y: 8)
    }
}

extension View {
    /// Wraps padded content in the standard Orionis card surface.
    func orionisCard(radius: CGFloat = Theme.cardRadius, fill: Color = Theme.surface) -> some View {
        modifier(OrionisCard(radius: radius, fill: fill))
    }

    /// Places the app ground behind a screen and hides the default scroll fill.
    func orionisScreen() -> some View {
        self
            .scrollContentBackground(.hidden)
            .background { AppBackground() }
    }
}

// MARK: - Navigation scaffold

/// Wraps content in a `NavigationStack` only when it is acting as the root of a
/// tab.
///
/// Screens such as Settings and Events are now reachable two ways: directly as a
/// primary destination, and pushed from the More hub. Pushing a view that owns a
/// `NavigationStack` onto an existing one nests them, which strands the back
/// button and duplicates the toolbar. Callers that already provide a stack pass
/// `isEnabled: false`.
struct OptionalNavigationStack<Content: View>: View {
    let isEnabled: Bool
    @ViewBuilder var content: Content

    var body: some View {
        if isEnabled {
            NavigationStack { content }
        } else {
            content
        }
    }
}

// MARK: - Building blocks

/// A card header: a tinted rounded-square glyph, a title, and an optional
/// trailing tag (e.g. "today", a count).
struct CardHeader: View {
    let title: String
    let systemImage: String
    var tint: Color = Theme.accent
    var tag: String?

    var body: some View {
        HStack(spacing: 11) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .background(Theme.soft(tint), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            Text(title)
                .font(.callout.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Spacer(minLength: 8)
            if let tag {
                Text(tag)
                    .font(.caption)
                    .foregroundStyle(Theme.textTertiary)
            }
        }
    }
}

/// A small filled dot for status, paired everywhere with a text label so colour
/// is never the only signal.
struct StatusDot: View {
    var color: Color
    var pulsing: Bool = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 9, height: 9)
            .overlay(
                Circle()
                    .stroke(color.opacity(0.5), lineWidth: on ? 7 : 0)
                    .opacity(on ? 0 : 1)
            )
            // The dot always sits beside text that states the same status, so
            // hiding it from VoiceOver removes a decorative element rather than
            // information.
            .accessibilityHidden(true)
            .onAppear {
                // A never-ending pulse is exactly what Reduce Motion is for; the
                // colour and the accompanying label still carry the status.
                guard pulsing, !reduceMotion else { return }
                withAnimation(.easeOut(duration: 2).repeatForever(autoreverses: false)) { on = true }
            }
    }
}

/// An uppercase, letter-spaced section label with an optional trailing control.
struct SectionLabel<Trailing: View>: View {
    let title: String
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .tracking(1.2)
                .foregroundStyle(Theme.textSecondary)
            Spacer(minLength: 8)
            trailing
        }
        .padding(.horizontal, 2)
    }
}

extension SectionLabel where Trailing == EmptyView {
    init(_ title: String) {
        self.init(title: title) { EmptyView() }
    }
}
