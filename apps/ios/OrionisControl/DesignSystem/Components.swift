import SwiftUI

/// Shared Command Deck components introduced by the V2 pass.
///
/// These exist so the camera wall, DNS activity feed, protection controls and
/// the fullscreen viewer can be built from the same vocabulary instead of each
/// screen inventing its own chips, pills and overlays. Tokens stay in `Theme`;
/// nothing here hard-codes a colour or a corner radius.

// MARK: - Chips & pills

/// A selectable filter chip. Used for the camera wall's status filters and the
/// DNS activity feed's All / Blocked / Allowed control.
///
/// Selection is conveyed by fill *and* weight, never by colour alone, so it
/// survives greyscale and Increase Contrast.
struct FilterChip: View {
    let title: String
    var systemImage: String?
    var count: Int?
    let isSelected: Bool
    var tint: Color = Theme.accent
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 11, weight: .semibold))
                }
                Text(title)
                    .font(.system(size: 13, weight: isSelected ? .semibold : .medium))
                if let count {
                    Text("\(count)")
                        .font(.system(size: 11, weight: .semibold).monospacedDigit())
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(
                            (isSelected ? Color.white.opacity(0.22) : Theme.soft(tint)),
                            in: Capsule())
                }
            }
            .foregroundStyle(isSelected ? Color.white : Theme.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(isSelected ? tint : Theme.inset, in: Capsule())
            .overlay(
                Capsule().strokeBorder(isSelected ? .clear : Theme.hairline, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

/// A compact, non-interactive status pill. Always symbol + text so the meaning
/// does not depend on the fill colour.
struct StatusPill: View {
    let title: String
    var systemImage: String?
    var tint: Color = Theme.good
    var filled: Bool = true

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 9.5, weight: .bold))
            }
            Text(title)
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(filled ? tint : Theme.textSecondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(filled ? Theme.soft(tint) : Theme.inset, in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Banners

/// An inline banner for a warning or failure that does not justify replacing
/// the whole screen. Distinct from `StaleDataBanner`, which is specifically
/// about age.
struct WarningBanner: View {
    let title: String
    var message: String?
    var systemImage: String = "exclamationmark.triangle.fill"
    var tint: Color = Theme.warn
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                if let message {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(tint)
            }
        }
        .padding(12)
        .background(Theme.soft(tint), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(tint.opacity(0.25), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Skeletons

/// A shimmering placeholder that preserves layout geometry while data loads.
///
/// The shimmer is suppressed under Reduce Motion, leaving a static fill — the
/// shape still holds the layout open, which is the point.
struct SkeletonBlock: View {
    var height: CGFloat = 14
    var radius: CGFloat = 6
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(Theme.inset)
            .frame(height: height)
            .overlay {
                if !reduceMotion {
                    GeometryReader { geo in
                        LinearGradient(
                            colors: [.clear, Theme.textTertiary.opacity(0.18), .clear],
                            startPoint: .leading, endPoint: .trailing)
                        .frame(width: geo.size.width * 0.55)
                        .offset(x: phase * geo.size.width)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
                }
            }
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: 1.3).repeatForever(autoreverses: false)) {
                    phase = 1.6
                }
            }
            .accessibilityHidden(true)
    }
}

// MARK: - Media controls

/// A circular control for the live viewer and fullscreen player.
///
/// Sized to the 44pt minimum touch target even though the visible glyph is
/// smaller, and legible over arbitrary video via a material backing.
struct MediaControlButton: View {
    let systemImage: String
    var label: String
    var isActive: Bool = false
    var tint: Color = .white
    var isEnabled: Bool = true
    let action: () -> Void

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(isActive ? Theme.accent : tint)
                .frame(width: 44, height: 44)
                .background {
                    if reduceTransparency {
                        Circle().fill(.black.opacity(0.65))
                    } else {
                        Circle().fill(.ultraThinMaterial)
                    }
                }
                .overlay(Circle().strokeBorder(.white.opacity(0.14), lineWidth: 1))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.4)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
    }
}

// MARK: - Destructive actions

/// The app's one full-width destructive button, used by the protection pause
/// sheet and other confirmed operations.
struct DestructiveActionButton: View {
    let title: String
    var systemImage: String?
    var isBusy: Bool = false
    var isEnabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isBusy {
                    ProgressView().tint(.white)
                } else if let systemImage {
                    Image(systemName: systemImage).font(.system(size: 15, weight: .semibold))
                }
                Text(title)
                    .font(.system(size: 16, weight: .semibold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Theme.critical, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled || isBusy)
        .opacity(isEnabled ? 1 : 0.5)
    }
}

// MARK: - Sheet scaffold

/// The shared shell for Orionis sheets: the app ground, a scrolling column, an
/// inline title and a Done button. Replaces the stock `Form` look on the detail
/// and insight sheets.
struct SheetScaffold<Content: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var content: Content
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) { content }
                    .padding(16)
            }
            .orionisScreen()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Sensory feedback

/// Meaningful-moment haptics, funnelled through one place so the app never
/// buzzes on ordinary taps. The system already honours the user's haptic
/// settings; this only limits *which* interactions qualify.
enum OrionisHaptic {
    case toggledFavourite
    case controlSucceeded
    case controlFailed
    case filterChanged

    var feedback: SensoryFeedback {
        switch self {
        case .toggledFavourite: .impact(weight: .light)
        case .controlSucceeded: .success
        case .controlFailed: .error
        case .filterChanged: .selection
        }
    }
}
