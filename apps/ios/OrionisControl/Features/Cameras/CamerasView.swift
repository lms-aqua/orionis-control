import SwiftUI

/// Camera list. Cameras come entirely from the gateway; nothing is hardcoded.
@MainActor
@Observable
final class CamerasViewModel {
    private(set) var cameras: [Camera] = []
    private(set) var error: APIError?
    private(set) var isLoading = false
    private(set) var lastLoadedAt: Date?
    /// Favourites and order as the account holds them, so a second device inherits
    /// them instead of starting empty. Nil until the gateway has answered.
    private(set) var accountPreferences: CameraPreferences?

    var searchText = ""
    var statusFilter: StatusFilter = .all
    var locationFilter: String?
    var showFavouritesOnly = false

    enum StatusFilter: String, CaseIterable, Identifiable {
        case all, online, offline
        var id: String { rawValue }
        var displayName: String {
            switch self {
            case .all: "All"
            case .online: "Online"
            case .offline: "Offline"
            }
        }
    }

    private let service: any CameraServicing

    init(service: any CameraServicing) {
        self.service = service
    }

    var locations: [String] {
        Array(Set(cameras.compactMap(\.location))).sorted()
    }

    /// Pure, so it is unit-tested directly.
    static func filter(
        _ cameras: [Camera],
        search: String,
        status: StatusFilter,
        location: String?,
        favouritesOnly: Bool,
        favourites: [String],
        order: [String] = []
    ) -> [Camera] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        return
            cameras
            .filter { camera in
                if favouritesOnly && !favourites.contains(camera.id) { return false }
                if let location, camera.location != location { return false }
                switch status {
                case .all: break
                case .online: if camera.health.status != .online { return false }
                case .offline: if camera.health.status == .online { return false }
                }
                guard !needle.isEmpty else { return true }
                return camera.name.lowercased().contains(needle)
                    || (camera.location ?? "").lowercased().contains(needle)
                    || (camera.group ?? "").lowercased().contains(needle)
            }
            // An explicit order is the viewer's decision, so it wins outright.
            // Without one: favourites first, then offline (they need attention),
            // then name.
            .sorted { lhs, rhs in
                if !order.isEmpty {
                    let lhsIndex = order.firstIndex(of: lhs.id)
                    let rhsIndex = order.firstIndex(of: rhs.id)
                    if let l = lhsIndex, let r = rhsIndex, l != r { return l < r }
                    // A camera the order does not mention sorts after ones it does,
                    // so a newly added camera appears rather than vanishing.
                    if lhsIndex != nil, rhsIndex == nil { return true }
                    if lhsIndex == nil, rhsIndex != nil { return false }
                }
                let lhsFav = favourites.contains(lhs.id)
                let rhsFav = favourites.contains(rhs.id)
                if lhsFav != rhsFav { return lhsFav }
                let lhsDown = lhs.health.status != .online
                let rhsDown = rhs.health.status != .online
                if lhsDown != rhsDown { return lhsDown }
                return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
            }
    }

    func visible(favourites: [String]) -> [Camera] {
        Self.filter(
            cameras,
            search: searchText,
            status: statusFilter,
            location: locationFilter,
            favouritesOnly: showFavouritesOnly,
            favourites: favourites,
            order: accountPreferences?.order ?? [])
    }

    /// Mirrors a favourite change to the account, so the other device agrees.
    ///
    /// The local toggle has already happened by the time this runs: a star should
    /// respond instantly and not wait on the network. A failure here leaves the
    /// device ahead of the account, which the next successful load reconciles.
    func syncFavourites(_ ids: [String]) async {
        accountPreferences = try? await service.setCameraPreferences(
            CameraPreferencesUpdate(favouriteIds: ids, order: nil))
    }

    func saveOrder(_ ids: [String]) async {
        accountPreferences = try? await service.setCameraPreferences(
            CameraPreferencesUpdate(favouriteIds: nil, order: ids))
    }

    func load(showSpinner: Bool = true) async {
        if showSpinner && cameras.isEmpty { isLoading = true }
        defer { isLoading = false }
        do {
            cameras = try await service.cameras()
            lastLoadedAt = Date()
            error = nil
            // Secondary: a gateway that cannot report preferences should still
            // show the cameras, falling back to whatever this device remembers.
            accountPreferences = try? await service.cameraPreferences()
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }
}

struct CamerasView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(DeepLinkRouter.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var model: CamerasViewModel?
    @State private var snapshots: CameraSnapshotStore?
    @State private var path = NavigationPath()
    /// Cameras handed to the full-screen viewer, and where to start. Non-nil
    /// presents it.
    @State private var fullScreen: FullScreenRequest?
    @State private var reordering = false

    struct FullScreenRequest: Identifiable {
        let cameras: [Camera]
        let startIndex: Int
        var id: String { cameras.indices.contains(startIndex) ? cameras[startIndex].id : "none" }
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let model {
                    content(model)
                } else {
                    LoadingStateView()
                }
            }
            .navigationTitle("Cameras")
            .navigationDestination(for: String.self) { cameraId in
                CameraDetailView(cameraId: cameraId)
            }
            .toolbar { toolbar }
        }
        .task {
            if model == nil { model = CamerasViewModel(service: environment.service) }
            if snapshots == nil { snapshots = CameraSnapshotStore(service: environment.service) }
            await model?.load()
            // The account is authoritative once it answers, so a second device
            // inherits the stars rather than keeping its own set.
            if let remote = model?.accountPreferences?.favouriteIds {
                environment.preferences.favouriteCameraIds = remote
            }
        }
        .onChange(of: router.pendingDestination) { _, destination in
            if case .camera(let id) = destination {
                path.append(id)
                _ = router.consume()
            }
        }
        .fullScreenCover(item: $fullScreen) { request in
            CameraLiveViewer(cameras: request.cameras, startAt: request.startIndex)
        }
        .sheet(isPresented: $reordering) {
            if let model {
                CameraOrderView(model: model)
            }
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if let model {
                    @Bindable var model = model
                    Picker("Status", selection: $model.statusFilter) {
                        ForEach(CamerasViewModel.StatusFilter.allCases) { filter in
                            Text(filter.displayName).tag(filter)
                        }
                    }
                    Toggle("Favourites only", isOn: $model.showFavouritesOnly)
                    if !model.locations.isEmpty {
                        Picker("Location", selection: $model.locationFilter) {
                            Text("All locations").tag(String?.none)
                            ForEach(model.locations, id: \.self) { location in
                                Text(location).tag(String?.some(location))
                            }
                        }
                    }
                    Divider()
                    Button {
                        reordering = true
                    } label: {
                        Label("Reorder cameras", systemImage: "arrow.up.arrow.down")
                    }
                    Picker("Layout", selection: layoutBinding) {
                        Label("One up", systemImage: "square").tag(1)
                        Label("Two up", systemImage: "square.grid.2x2").tag(2)
                        Label("Compact", systemImage: "square.grid.3x3").tag(3)
                    }
                }
            } label: {
                Label("View options", systemImage: "slider.horizontal.3")
            }
        }
    }

    private var layoutBinding: Binding<Int> {
        Binding(
            get: { environment.preferences.gridColumns },
            set: { environment.preferences.gridColumns = $0 }
        )
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ model: CamerasViewModel) -> some View {
        @Bindable var model = model
        let visible = model.visible(favourites: environment.preferences.favouriteCameraIds)

        if model.isLoading && model.cameras.isEmpty {
            skeletonGrid
        } else if let error = model.error, model.cameras.isEmpty {
            if error.isNotConfigured {
                NotConfiguredView(feature: "Cameras", detail: error.message)
            } else {
                ErrorStateView(error: error, retry: { await model.load() })
            }
        } else if model.cameras.isEmpty {
            EmptyStateView(
                title: "No cameras",
                message:
                    "Your account has access to Orionis Guard, but no cameras were returned. An administrator may still be adding them.",
                systemImage: "video.slash",
                actionTitle: "Refresh",
                action: { Task { await model.load() } }
            )
        } else {
            ScrollView {
                LazyVStack(spacing: 14) {
                    systemStatusBanner(model.cameras)

                    if visible.isEmpty {
                        noMatches(model)
                    } else {
                        LazyVGrid(columns: columns, spacing: 14) {
                            ForEach(visible) { camera in
                                NavigationLink(value: camera.id) {
                                    CameraCard(
                                        camera: camera,
                                        frame: snapshots?.frame(for: camera.id),
                                        isLoadingFrame: snapshots?.isPending(camera.id) ?? false,
                                        isFavourite: environment.preferences.isFavourite(camera.id),
                                        compact: effectiveColumns >= 3
                                    )
                                }
                                .buttonStyle(.plain)
                                .contextMenu { cardMenu(camera, within: visible) }
                            }
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .background(Color(.systemGroupedBackground))
            .searchable(text: $model.searchText, prompt: "Search cameras")
            .refreshable { await model.load(showSpinner: false) }
            // Snapshots refresh only while the grid is on screen, and only for
            // the cameras actually shown.
            .task(id: visible.map(\.id)) {
                await snapshots?.run(cameraIds: visible.filter { $0.health.status.isUsable }.map(\.id))
            }
        }
    }

    @ViewBuilder
    private func cardMenu(_ camera: Camera, within visible: [Camera]) -> some View {
        // Full screen starts on this camera but carries the whole visible wall, so
        // swiping moves through what the filters are currently showing.
        if camera.health.status.isUsable {
            Button {
                fullScreen = FullScreenRequest(
                    cameras: visible,
                    startIndex: visible.firstIndex(where: { $0.id == camera.id }) ?? 0)
            } label: {
                Label("Open full screen", systemImage: "arrow.up.left.and.arrow.down.right")
            }
        }
        Button {
            environment.preferences.toggleFavourite(camera.id)
            let ids = environment.preferences.favouriteCameraIds
            Task { await model?.syncFavourites(ids) }
        } label: {
            Label(
                environment.preferences.isFavourite(camera.id)
                    ? "Remove favourite" : "Add favourite",
                systemImage: environment.preferences.isFavourite(camera.id) ? "star.slash" : "star")
        }
        Button {
            Task { await snapshots?.refresh(cameraIds: [camera.id]) }
        } label: {
            Label("Refresh image", systemImage: "arrow.clockwise")
        }
    }

    /// A single honest line about the system, shown only when something is wrong.
    @ViewBuilder
    private func systemStatusBanner(_ cameras: [Camera]) -> some View {
        let down = cameras.filter { $0.health.status == .offline }
        let degraded = cameras.filter { $0.health.status == .degraded }
        if !down.isEmpty || !degraded.isEmpty {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text(bannerTitle(down: down.count, degraded: degraded.count))
                        .font(.subheadline.weight(.medium))
                    Text("\(cameras.count - down.count) of \(cameras.count) cameras are online.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(12)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func bannerTitle(down: Int, degraded: Int) -> String {
        if down > 0 && degraded > 0 {
            return "\(down) offline, \(degraded) degraded"
        }
        if down > 0 {
            return down == 1 ? "1 camera is offline" : "\(down) cameras are offline"
        }
        return degraded == 1 ? "1 camera is degraded" : "\(degraded) cameras are degraded"
    }

    @ViewBuilder
    private func noMatches(_ model: CamerasViewModel) -> some View {
        EmptyStateView(
            title: "No matches",
            message: "No cameras match the current search and filters.",
            systemImage: "magnifyingglass",
            actionTitle: "Clear filters",
            action: {
                model.searchText = ""
                model.statusFilter = .all
                model.locationFilter = nil
                model.showFavouritesOnly = false
            }
        )
    }

    /// Loading keeps the grid's geometry, so nothing jumps when frames arrive.
    private var skeletonGrid: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 14) {
                ForEach(0..<4, id: \.self) { _ in
                    CameraCardSkeleton()
                }
            }
            .padding(14)
        }
        .background(Color(.systemGroupedBackground))
        .allowsHitTesting(false)
    }

    /// iPad and landscape get an extra column; the stored preference still decides
    /// the base density.
    private var effectiveColumns: Int {
        let base = max(1, min(3, environment.preferences.gridColumns))
        return sizeClass == .regular ? min(4, base + 1) : base
    }

    private var columns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: 14), count: effectiveColumns)
    }
}

// MARK: - Card

/// One camera in the grid: its most recent frame, name, place and true state.
///
/// The frame is a periodic snapshot, never live video, so it is always labelled
/// with its age and a stale or offline frame is visibly marked as such.
struct CameraCard: View {
    let camera: Camera
    let frame: CameraSnapshotStore.Frame?
    let isLoadingFrame: Bool
    let isFavourite: Bool
    var compact = false

    private var isOffline: Bool { camera.health.status == .offline }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                image
                // Keeps the name legible over a bright frame without hiding the
                // picture behind a permanent panel.
                LinearGradient(
                    colors: [.black.opacity(0.0), .black.opacity(0.55)],
                    startPoint: .center,
                    endPoint: .bottom)

                VStack {
                    HStack(alignment: .top) {
                        CameraStatusPill(status: camera.health.status, compact: compact)
                        Spacer()
                        if isFavourite {
                            Image(systemName: "star.fill")
                                .font(.caption)
                                .foregroundStyle(.yellow)
                                .shadow(radius: 2)
                        }
                    }
                    Spacer()
                    HStack(alignment: .bottom) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(camera.name)
                                .font(compact ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                            if !compact, let location = camera.location {
                                Text(location)
                                    .font(.caption2)
                                    .foregroundStyle(.white.opacity(0.85))
                                    .lineLimit(1)
                            }
                        }
                        Spacer()
                        if !compact { freshnessLabel }
                    }
                }
                .padding(10)
            }
            .aspectRatio(16 / 9, contentMode: .fill)
            .clipped()
        }
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(.separator.opacity(0.5), lineWidth: 0.5)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityDescription)
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder
    private var image: some View {
        if let frame, let uiImage = UIImage(data: frame.data) {
            Image(uiImage: uiImage)
                .resizable()
                .aspectRatio(contentMode: .fill)
                // An offline camera's last frame is history, not the present.
                .grayscale(isOffline ? 1 : 0)
                .opacity(isOffline ? 0.5 : 1)
        } else if isLoadingFrame {
            ZStack {
                Rectangle().fill(.quaternary)
                ProgressView()
            }
        } else {
            ZStack {
                Rectangle().fill(.quaternary)
                Image(systemName: isOffline ? "video.slash.fill" : "video.fill")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Snapshot age. Never says "live": the grid does not stream.
    @ViewBuilder
    private var freshnessLabel: some View {
        if isOffline {
            if let lastSeen = camera.health.lastSeenAt {
                Text("Last seen \(lastSeen.formatted(date: .omitted, time: .shortened))")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.8))
            }
        } else if let frame {
            let freshness = SnapshotFreshness.of(frame.capturedAt)
            HStack(spacing: 3) {
                Image(systemName: freshness.isStale ? "clock.badge.exclamationmark" : "camera.fill")
                    .font(.system(size: 8))
                Text(freshness.label)
                    .font(.caption2)
            }
            .foregroundStyle(.white.opacity(freshness.isStale ? 0.7 : 0.9))
        }
    }

    private var accessibilityDescription: String {
        var parts = [camera.name]
        if let location = camera.location { parts.append(location) }
        parts.append(camera.health.status.accessibleDescription)
        if isOffline, let lastSeen = camera.health.lastSeenAt {
            parts.append("last seen \(lastSeen.formatted(date: .abbreviated, time: .shortened))")
        } else if let frame {
            parts.append("image from \(SnapshotFreshness.of(frame.capturedAt).label)")
        }
        return parts.joined(separator: ", ")
    }
}

/// Status as a word plus a colour, never a colour alone.
struct CameraStatusPill: View {
    let status: CameraStatus
    var compact = false

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(tint)
                .frame(width: 6, height: 6)
            if !compact {
                Text(label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white)
            }
        }
        .padding(.horizontal, compact ? 5 : 7)
        .padding(.vertical, compact ? 5 : 3)
        .background(.black.opacity(0.5), in: Capsule())
    }

    private var label: String {
        switch status {
        case .online: "Online"
        case .offline: "Offline"
        case .degraded: "Degraded"
        case .unknown: "Unknown"
        }
    }

    private var tint: Color {
        switch status {
        case .online: .green
        case .offline: .red
        case .degraded: .orange
        case .unknown: .gray
        }
    }
}

struct CameraCardSkeleton: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(.quaternary)
            .aspectRatio(16 / 9, contentMode: .fit)
            .overlay(alignment: .bottomLeading) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(.tertiary)
                    .frame(width: 90, height: 10)
                    .padding(12)
            }
            .redacted(reason: .placeholder)
    }
}

extension CameraStatus {
    /// Spoken form for VoiceOver, which should not read a raw enum name.
    var accessibleDescription: String {
        switch self {
        case .online: "online"
        case .offline: "offline"
        case .degraded: "degraded"
        case .unknown: "status unknown"
        }
    }
}
