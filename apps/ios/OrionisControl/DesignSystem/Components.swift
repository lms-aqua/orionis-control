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
/// Liquid Glass carries this: a control floating over live video is exactly
/// what the material is for, and it adapts to the footage underneath as the
/// scene changes. `glassEffect` honours Reduce Transparency and Increase
/// Contrast itself, so no manual fallback is needed here.
struct MediaControlButton: View {
    let systemImage: String
    var label: String
    var isActive: Bool = false
    var tint: Color = .white
    var isEnabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(isActive ? Theme.accent : tint)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        // `.interactive()` gives the glass its press response; the active
        // control is tinted so selection survives at a glance.
        .glassEffect(
            isActive ? .regular.tint(Theme.accent.opacity(0.28)).interactive()
                : .regular.interactive(),
            in: Circle())
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

// MARK: - Operational status

/// The single "is anything wrong?" statement at the top of an operations
/// screen. Used by System and by the Network protection state.
///
/// Deliberately not a card: it is the screen's headline, so it reads as
/// typography on the ground rather than as one more rounded box among several.
struct OperationalStatusHero: View {
    let title: String
    let message: String
    var systemImage: String
    var tint: Color
    var caption: String?
    /// Optional trailing action, e.g. Pause / Resume protection.
    var actionTitle: String?
    var actionIsDestructive: Bool = false
    var actionIsBusy: Bool = false
    var action: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .top, spacing: 13) {
                Image(systemName: systemImage)
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 46, height: 46)
                    .background(
                        Theme.soft(tint),
                        in: RoundedRectangle(cornerRadius: 13, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.system(size: 21, weight: .bold))
                        .foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(message)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let caption {
                        Text(caption)
                            .font(.system(size: 12).monospacedDigit())
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                Spacer(minLength: 0)
            }

            if let actionTitle, let action {
                Button(action: action) {
                    HStack(spacing: 7) {
                        if actionIsBusy { ProgressView().controlSize(.small) }
                        Text(actionTitle)
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundStyle(actionIsDestructive ? Theme.critical : Theme.accent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(
                        Theme.soft(actionIsDestructive ? Theme.critical : Theme.accent),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(actionIsBusy)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// A row of headline figures separated by hairlines rather than boxed into
/// individual cards.
///
/// Three related numbers describing one subject are one surface, not three
/// floating tiles — typography carries the hierarchy. Wraps to a second line at
/// large Dynamic Type sizes instead of truncating.
struct MetricStrip: View {
    struct Metric: Identifiable {
        let id = UUID()
        let value: String
        let label: String
        var caption: String?
        var tint: Color?
    }

    let metrics: [Metric]
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let columns = dynamicTypeSize >= .accessibility1 ? 1 : min(3, max(1, metrics.count))
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), alignment: .topLeading), count: columns),
            spacing: 16
        ) {
            ForEach(metrics) { metric in
                VStack(alignment: .leading, spacing: 3) {
                    Text(metric.value)
                        .font(.system(size: 25, weight: .bold).monospacedDigit())
                        .foregroundStyle(metric.tint ?? Theme.textPrimary)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                    Text(metric.label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                    if let caption = metric.caption {
                        Text(caption)
                            .font(.system(size: 11).monospacedDigit())
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    "\(metric.label): \(metric.value)\(metric.caption.map { ", \($0)" } ?? "")")
            }
        }
    }
}

// MARK: - Detail surfaces

/// The hero at the top of a detail sheet: the subject, its outcome, and one or
/// two lines of context. The subject is the only loud element.
struct SheetHero: View {
    let title: String
    var subtitle: String?
    var caption: String?
    var badge: String?
    var badgeTint: Color = Theme.accent
    var monospacedTitle: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title)
                .font(
                    monospacedTitle
                        ? .system(size: 21, weight: .semibold, design: .monospaced)
                        : .system(size: 22, weight: .bold)
                )
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            if let badge {
                StatusPill(title: badge, tint: badgeTint)
            }

            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textSecondary)
            }
            if let caption {
                Text(caption)
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }
}

/// A labelled group of detail rows on one Orionis surface. The V2 replacement
/// for `Form` + `Section` on sheets.
struct DetailGroup<Content: View>: View {
    let title: String?
    @ViewBuilder var content: Content

    init(_ title: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title { SectionLabel(title) }
            VStack(spacing: 0) { content }
                .orionisCard()
        }
    }
}

/// A label and its value. Values worth copying are selectable, and technical
/// values render monospaced so an address or a rule stays readable.
struct DetailValueRow: View {
    let label: String
    let value: String
    var monospaced: Bool = false
    var tint: Color?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .font(.system(size: 14))
                .foregroundStyle(Theme.textSecondary)
            Spacer(minLength: 10)
            Text(value)
                .font(
                    monospaced
                        ? .system(size: 13, design: .monospaced)
                        : .system(size: 14, weight: .medium)
                )
                .foregroundStyle(tint ?? Theme.textPrimary)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }
}

/// A ranked row with a proportional bar — top domains, top clients.
///
/// The bar is scaled against the largest value in the list, so it compares
/// items against each other rather than implying an absolute ceiling.
struct RankedActivityRow: View {
    let name: String
    let count: Int
    let fraction: Double
    var tint: Color = Theme.accent
    var action: (() -> Void)?

    var body: some View {
        let row = VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Text(name)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Text(count.formatted())
                    .font(.system(size: 14, weight: .semibold).monospacedDigit())
                    .foregroundStyle(Theme.textSecondary)
            }
            GeometryReader { geo in
                Capsule()
                    .fill(tint.opacity(0.55))
                    .frame(width: max(2, geo.size.width * min(1, max(0, fraction))))
            }
            .frame(height: 3)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name), \(count)")

        if let action {
            Button(action: action) { row }
                .buttonStyle(.plain)
                .accessibilityHint("Filters DNS activity to this")
        } else {
            row
        }
    }
}

/// A single stacked bar showing an outcome mix. Chosen over a pie or donut
/// because the numbers stay the primary information and a bar reads correctly
/// at any Dynamic Type size.
struct OutcomeMixBar: View {
    struct Segment: Identifiable {
        let id = UUID()
        let label: String
        let count: Int
        let tint: Color
    }

    let segments: [Segment]

    private var total: Int { max(1, segments.reduce(0) { $0 + $1.count }) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            GeometryReader { geo in
                HStack(spacing: 2) {
                    ForEach(segments.filter { $0.count > 0 }) { segment in
                        Capsule()
                            .fill(segment.tint)
                            .frame(
                                width: max(
                                    3,
                                    geo.size.width * (Double(segment.count) / Double(total))
                                        - 2))
                    }
                }
            }
            .frame(height: 9)

            // The legend carries the numbers, so the bar never has to be
            // measured by eye and colour is never the only signal.
            HStack(spacing: 14) {
                ForEach(segments.filter { $0.count > 0 }) { segment in
                    HStack(spacing: 5) {
                        Circle().fill(segment.tint).frame(width: 7, height: 7)
                        Text(segment.label)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textSecondary)
                        Text(segment.count.formatted())
                            .font(.system(size: 12, weight: .semibold).monospacedDigit())
                            .foregroundStyle(Theme.textPrimary)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            segments.filter { $0.count > 0 }
                .map { "\($0.label) \($0.count)" }
                .joined(separator: ", "))
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
