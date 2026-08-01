import SwiftUI

/// Camera list. Cameras come entirely from the gateway; nothing is hardcoded.
@MainActor
@Observable
final class CamerasViewModel {
    private(set) var cameras: [Camera] = []
    private(set) var error: APIError?
    private(set) var isLoading = false
    private(set) var lastLoadedAt: Date?

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
        favourites: [String]
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
            // Favourites first, then offline (they need attention), then name.
            .sorted { lhs, rhs in
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
            favourites: favourites)
    }

    func load(showSpinner: Bool = true) async {
        if showSpinner && cameras.isEmpty { isLoading = true }
        defer { isLoading = false }
        do {
            cameras = try await service.cameras()
            lastLoadedAt = Date()
            error = nil
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
    @State private var model: CamerasViewModel?
    @State private var path = NavigationPath()

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
            await model?.load()
        }
        .onChange(of: router.pendingDestination) { _, destination in
            if case .camera(let id) = destination {
                path.append(id)
                _ = router.consume()
            }
        }
    }

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
                    Picker("Layout", selection: layoutBinding) {
                        Label("Large", systemImage: "square").tag(1)
                        Label("Grid", systemImage: "square.grid.2x2").tag(2)
                        Label("Compact", systemImage: "square.grid.3x3").tag(3)
                    }
                }
            } label: {
                Label("View options", systemImage: "line.3.horizontal.decrease.circle")
            }
        }
    }

    private var layoutBinding: Binding<Int> {
        Binding(
            get: { environment.preferences.gridColumns },
            set: { environment.preferences.gridColumns = $0 }
        )
    }

    @ViewBuilder
    private func content(_ model: CamerasViewModel) -> some View {
        @Bindable var model = model
        let visible = model.visible(favourites: environment.preferences.favouriteCameraIds)

        if model.isLoading {
            LoadingStateView(message: "Loading cameras…")
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
        } else if visible.isEmpty {
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
        } else {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(visible) { camera in
                        NavigationLink(value: camera.id) {
                            CameraTile(
                                camera: camera,
                                isFavourite: environment.preferences.isFavourite(camera.id),
                                compact: environment.preferences.gridColumns >= 3
                            )
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button {
                                environment.preferences.toggleFavourite(camera.id)
                            } label: {
                                Label(
                                    environment.preferences.isFavourite(camera.id)
                                        ? "Remove favourite" : "Add favourite",
                                    systemImage: environment.preferences.isFavourite(camera.id)
                                        ? "star.slash" : "star")
                            }
                        }
                    }
                }
                .padding(12)
            }
            .searchable(text: $model.searchText, prompt: "Search cameras")
            .refreshable { await model.load(showSpinner: false) }
        }
    }

    private var columns: [GridItem] {
        Array(
            repeating: GridItem(.flexible(), spacing: 12),
            count: max(1, min(3, environment.preferences.gridColumns)))
    }
}

struct CameraTile: View {
    let camera: Camera
    let isFavourite: Bool
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(.quaternary)
                    .aspectRatio(16 / 9, contentMode: .fit)

                // A real snapshot is loaded by CameraSnapshotView on the detail
                // screen. The tile shows an explicit placeholder rather than a
                // stale or invented frame.
                VStack(spacing: 6) {
                    Image(
                        systemName: camera.health.status == .online
                            ? "video.fill" : "video.slash.fill"
                    )
                    .font(.title2)
                    .foregroundStyle(camera.health.status == .online ? Color.secondary : Color.red)
                    if camera.health.status != .online {
                        Text(camera.health.status.rawValue.capitalized)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                if isFavourite {
                    VStack {
                        HStack {
                            Spacer()
                            Image(systemName: "star.fill")
                                .font(.caption)
                                .foregroundStyle(.yellow)
                                .padding(8)
                        }
                        Spacer()
                    }
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(camera.name)
                    .font(compact ? .caption.weight(.medium) : .subheadline.weight(.medium))
                    .lineLimit(1)
                if !compact, let location = camera.location {
                    Text(location)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                CameraStatusBadge(health: camera.health, compact: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
        }
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(camera.name)\(camera.location.map { ", \($0)" } ?? ""), \(camera.health.status.rawValue)"
        )
        .accessibilityAddTraits(.isButton)
    }
}
