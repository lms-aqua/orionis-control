import SwiftUI

/// The building blocks of the redesigned Settings hub and its category screens.
///
/// Settings is a list of *rows inside grouped cards* rather than a `Form`, so it
/// shares the Command Deck surfaces with the rest of the app and can carry
/// icons, values and status on the same line.

// MARK: - Containers

/// A rounded card that stacks rows edge to edge, with hairlines between them.
struct SettingsGroup<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .orionisCard()
    }
}

/// The hairline between two rows in a group. Inset to clear a row's icon.
struct SettingsDivider: View {
    var inset: CGFloat = 14

    var body: some View {
        Rectangle()
            .fill(Theme.hairline)
            .frame(height: 1)
            .padding(.leading, inset)
    }
}

/// Explanatory copy under a group — the equivalent of a `Form` section footer.
struct SettingsHint: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(Theme.textTertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
    }
}

// MARK: - Row furniture

/// A tinted rounded-square glyph, matching `CardHeader`'s treatment.
struct SettingsIcon: View {
    let systemImage: String
    var tint: Color = Theme.accent

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 30, height: 30)
            .background(
                Theme.soft(tint), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

/// A small uppercase chip, used for "Admin" and role labels.
struct SettingsChip: View {
    let text: String
    var tint: Color = Theme.warn

    var body: some View {
        Text(text.uppercased())
            .font(.caption2.weight(.bold))
            .tracking(0.5)
            .foregroundStyle(tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Theme.soft(tint), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

/// A row's title and optional supporting line.
struct SettingsRowLabel: View {
    let title: String
    var subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.leading)
            if let subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.leading)
            }
        }
    }
}

private struct SettingsRowPadding: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
    }
}

extension View {
    fileprivate func settingsRowPadding() -> some View { modifier(SettingsRowPadding()) }
}

// MARK: - Rows

/// A row that pushes another screen: icon, title, supporting line, and any of a
/// status dot, chip or value before the chevron.
struct SettingsNavRow<Destination: View>: View {
    let title: String
    var subtitle: String?
    var systemImage: String?
    var tint: Color = Theme.accent
    var value: String?
    var chip: String?
    var chipTint: Color = Theme.warn
    var statusColor: Color?
    @ViewBuilder var destination: Destination

    var body: some View {
        NavigationLink {
            destination
        } label: {
            HStack(spacing: 12) {
                if let systemImage {
                    SettingsIcon(systemImage: systemImage, tint: tint)
                }
                SettingsRowLabel(title: title, subtitle: subtitle)
                Spacer(minLength: 8)
                if let statusColor { StatusDot(color: statusColor) }
                if let chip { SettingsChip(text: chip, tint: chipTint) }
                if let value {
                    Text(value)
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
            }
            .settingsRowPadding()
            .contentShape(Rectangle())
            // Read as one item — "Security & Privacy, Face ID, auto-lock…" —
            // rather than as four separate stops for the icon, title, subtitle
            // and chevron.
            .accessibilityElement(children: .combine)
        }
        .buttonStyle(.plain)
    }
}

/// A switch row. Disabled rows stay visible and legible, with the reason
/// explained in the group's hint rather than hidden.
struct SettingsToggleRow: View {
    let title: String
    var subtitle: String?
    @Binding var isOn: Bool
    var isEnabled: Bool = true

    var body: some View {
        Toggle(isOn: $isOn) {
            SettingsRowLabel(title: title, subtitle: subtitle)
        }
        .tint(Theme.good)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.55)
        .settingsRowPadding()
    }
}

/// A row whose value is chosen from a pull-down menu.
struct SettingsMenuRow<Value: Hashable, Options: View>: View {
    let title: String
    var subtitle: String?
    @Binding var selection: Value
    @ViewBuilder var options: Options

    var body: some View {
        Picker(selection: $selection) {
            options
        } label: {
            SettingsRowLabel(title: title, subtitle: subtitle)
        }
        .pickerStyle(.menu)
        .tint(Theme.textSecondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 5)
    }
}

/// A row whose value is chosen from a segmented control beneath its label.
struct SettingsSegmentRow<Value: Hashable, Options: View>: View {
    let title: String
    var subtitle: String?
    @Binding var selection: Value
    @ViewBuilder var options: Options

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            SettingsRowLabel(title: title, subtitle: subtitle)
            Picker(title, selection: $selection) { options }
                .pickerStyle(.segmented)
                .labelsHidden()
        }
        .settingsRowPadding()
    }
}

/// A read-only fact: a label on the left, its value on the right.
struct SettingsValueRow: View {
    let title: String
    let value: String
    var monospaced: Bool = false
    var truncatesInMiddle: Bool = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.textPrimary)
            Spacer(minLength: 8)
            Text(value)
                .font(monospaced ? .system(.footnote, design: .monospaced) : .subheadline)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(truncatesInMiddle ? 1 : 3)
                .truncationMode(truncatesInMiddle ? .middle : .tail)
                .multilineTextAlignment(.trailing)
        }
        .settingsRowPadding()
        .accessibilityElement(children: .combine)
    }
}

/// An action row. `isBusy` swaps the chevron area for a spinner.
struct SettingsButtonRow: View {
    let title: String
    var subtitle: String?
    var systemImage: String?
    var tint: Color = Theme.accent
    var isBusy: Bool = false
    var isEnabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(tint)
                        .frame(width: 22)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(tint)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                Spacer(minLength: 8)
                if isBusy { ProgressView() }
            }
            .settingsRowPadding()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled || isBusy)
        .opacity(isEnabled ? 1 : 0.55)
    }
}

/// A short result line inside a group (connection test, save confirmation).
struct SettingsNoteRow: View {
    let text: String
    var systemImage: String
    var tint: Color

    var body: some View {
        Label {
            Text(text)
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
        } icon: {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
        }
        .settingsRowPadding()
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Screen scaffold

/// A blocking progress overlay that honours Reduce Transparency.
///
/// The material background is a nicety; behind Reduce Transparency it becomes a
/// solid surface instead, because a person who has asked for that has asked not
/// to read text through a blur.
struct BusyOverlay: View {
    let message: String
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        ProgressView(message)
            .padding()
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(reduceTransparency ? AnyShapeStyle(Theme.surfaceRaised) : AnyShapeStyle(.regularMaterial))
            }
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Theme.hairline, lineWidth: 1)
            )
            .accessibilityLabel(message)
    }
}

/// The shared layout for every Settings category screen: the app ground, a
/// scrolling column of labelled groups, and an inline navigation title.
struct SettingsScreen<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) { content }
                .padding(16)
        }
        .orionisScreen()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
