import SwiftUI

@MainActor
@Observable
final class EventsViewModel {
    private(set) var events: [CameraEvent] = []
    private(set) var error: APIError?
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var hasMore = false
    private(set) var lastLoadedAt: Date?
    private(set) var paginationError: APIError?

    var filter = EventFilter()
    var searchText = ""

    private let service: any EventServicing
    private var loadGeneration = 0

    init(service: any EventServicing) {
        self.service = service
    }

    /// Pure filter applied on top of the server-side query, for the free-text
    /// search the gateway does not implement.
    static func search(_ events: [CameraEvent], text: String) -> [CameraEvent] {
        let needle = text.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return events }
        return events.filter { event in
            (event.cameraName ?? "").lowercased().contains(needle)
                || event.type.displayName.lowercased().contains(needle)
                || (event.note ?? "").lowercased().contains(needle)
        }
    }

    var visible: [CameraEvent] { Self.search(events, text: searchText) }

    func load(showSpinner: Bool = true) async {
        loadGeneration &+= 1
        let generation = loadGeneration
        if showSpinner && events.isEmpty { isLoading = true }
        defer {
            if generation == loadGeneration { isLoading = false }
        }
        filter.offset = 0
        let requestedFilter = filter
        do {
            let page = try await service.events(filter: requestedFilter)
            guard generation == loadGeneration else { return }
            events = page.items
            hasMore = page.page.hasMore
            lastLoadedAt = Date()
            error = nil
            paginationError = nil
        } catch let apiError as APIError {
            guard generation == loadGeneration else { return }
            error = apiError
        } catch {
            guard generation == loadGeneration else { return }
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    func loadMore() async {
        guard hasMore, !isLoadingMore else { return }
        let generation = loadGeneration
        isLoadingMore = true
        paginationError = nil
        defer {
            if generation == loadGeneration { isLoadingMore = false }
        }
        var next = filter
        next.offset = events.count
        do {
            let page = try await service.events(filter: next)
            guard generation == loadGeneration else { return }
            let existingIds = Set(events.map(\.id))
            let newItems = page.items.filter { !existingIds.contains($0.id) }
            events.append(contentsOf: newItems)
            hasMore = page.page.hasMore
        } catch let apiError as APIError {
            guard generation == loadGeneration else { return }
            paginationError = apiError
        } catch {
            guard generation == loadGeneration else { return }
            paginationError = .unexpectedStatus(0, requestId: nil)
        }
    }

    func acknowledge(_ event: CameraEvent, note: String?) async -> APIError? {
        do {
            let updated = try await service.acknowledge(eventId: event.id, note: note)
            if let index = events.firstIndex(where: { $0.id == event.id }) {
                events[index] = updated
            }
            return nil
        } catch let error as APIError {
            return error
        } catch {
            return .unexpectedStatus(0, requestId: nil)
        }
    }
}

struct EventsView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(DeepLinkRouter.self) private var router
    @State private var model: EventsViewModel?
    @State private var selected: CameraEvent?
    @State private var navigationError: APIError?

    var body: some View {
        NavigationStack {
            Group {
                if let model { content(model) } else { LoadingStateView() }
            }
            .navigationTitle("Events")
            .toolbar { toolbar }
            .sheet(item: $selected) { event in
                EventDetailSheet(event: event) { note in
                    await model?.acknowledge(event, note: note)
                }
            }
        }
        .task {
            if model == nil { model = EventsViewModel(service: environment.service) }
            await model?.load()
        }
        .onChange(of: router.pendingDestination) { _, destination in
            if case .event(let id) = destination {
                Task {
                    do {
                        let event = try await environment.service.event(id: id)
                        selected = event
                    } catch let apiError as APIError {
                        navigationError = apiError
                    } catch {
                        navigationError = .unexpectedStatus(0, requestId: nil)
                    }
                    _ = router.consume()
                }
            }
        }
        .alert(
            "Couldn't open event",
            isPresented: Binding(
                get: { navigationError != nil },
                set: { if !$0 { navigationError = nil } })
        ) {
            Button("OK", role: .cancel) { navigationError = nil }
        } message: {
            Text(navigationError?.message ?? "The event could not be loaded.")
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            if let model {
                @Bindable var model = model
                Menu {
                    Picker(
                        "Acknowledgement",
                        selection: Binding(
                            get: { model.filter.acknowledged },
                            set: {
                                model.filter.acknowledged = $0
                                Task { await model.load() }
                            })
                    ) {
                        Text("All").tag(Bool?.none)
                        Text("Unacknowledged").tag(Bool?.some(false))
                        Text("Acknowledged").tag(Bool?.some(true))
                    }

                    Menu("Event type") {
                        ForEach(CameraEventType.allCases) { type in
                            Button {
                                toggle(type, in: model)
                            } label: {
                                Label(
                                    type.displayName,
                                    systemImage: model.filter.types.contains(type)
                                        ? "checkmark" : type.symbolName)
                            }
                        }
                    }

                    if model.filter.isFiltered {
                        Divider()
                        Button("Clear filters", role: .destructive) {
                            model.filter = EventFilter()
                            Task { await model.load() }
                        }
                    }
                } label: {
                    Label(
                        "Filter",
                        systemImage: model.filter.isFiltered
                            ? "line.3.horizontal.decrease.circle.fill"
                            : "line.3.horizontal.decrease.circle")
                }
            }
        }
    }

    private func toggle(_ type: CameraEventType, in model: EventsViewModel) {
        if let index = model.filter.types.firstIndex(of: type) {
            model.filter.types.remove(at: index)
        } else {
            model.filter.types.append(type)
        }
        Task { await model.load() }
    }

    @ViewBuilder
    private func content(_ model: EventsViewModel) -> some View {
        @Bindable var model = model

        if model.isLoading {
            LoadingStateView(message: "Loading events…")
        } else if let error = model.error, model.events.isEmpty {
            if error.isNotConfigured {
                NotConfiguredView(feature: "Events", detail: error.message)
            } else {
                ErrorStateView(error: error, retry: { await model.load() })
            }
        } else if model.events.isEmpty, environment.meta?.capabilities.eventDetection == false {
            // The endpoint is healthy and will never return anything, because
            // nothing upstream detects motion or objects. Saying "no events" here
            // would describe a quiet period instead of a feature that cannot work.
            EmptyStateView(
                title: "Detection isn't set up",
                message:
                    "Your cameras are recording continuously, but none of them detect motion or objects yet — so there are no events to list. Recorded footage is still available on each camera's timeline.",
                systemImage: "sensor.tag.radiowaves.forward.slash",
                actionTitle: nil,
                action: nil
            )
        } else if model.events.isEmpty {
            EmptyStateView(
                title: model.filter.isFiltered ? "No matching events" : "No events",
                message: model.filter.isFiltered
                    ? "No events match the current filters."
                    : "Nothing has been recorded in the selected period.",
                systemImage: "bell.slash",
                actionTitle: model.filter.isFiltered ? "Clear filters" : nil,
                action: model.filter.isFiltered
                    ? {
                        model.filter = EventFilter()
                        Task { await model.load() }
                    } : nil
            )
        } else {
            List {
                ForEach(model.visible) { event in
                    Button { selected = event } label: { EventRow(event: event) }
                        .buttonStyle(.plain)
                }
                if let paginationError = model.paginationError {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("More events couldn't be loaded", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text(paginationError.message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("Try again") { Task { await model.loadMore() } }
                    }
                    .padding(.vertical, 6)
                } else if model.hasMore {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                    .task { await model.loadMore() }
                }
            }
            .listStyle(.plain)
            .searchable(text: $model.searchText, prompt: "Search events")
            .refreshable { await model.load(showSpinner: false) }
        }
    }
}

struct EventRow: View {
    let event: CameraEvent
    var compact = false

    private var severityTint: Color {
        switch event.severity {
        case .info: .secondary
        case .warning: .orange
        case .critical: .red
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: event.type.symbolName)
                .font(compact ? .body : .title3)
                .foregroundStyle(severityTint)
                .frame(width: 28)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(event.type.displayName)
                        .font(compact ? .subheadline.weight(.medium) : .body.weight(.medium))
                    if let confidence = event.confidence {
                        Text("\(Int(confidence * 100))%")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }
                Text(
                    "\(event.cameraName ?? event.cameraId) · \(event.occurredAt.formatted(date: .abbreviated, time: .shortened))"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }

            Spacer(minLength: 0)

            if event.acknowledged {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.caption)
                    .accessibilityLabel("Acknowledged")
            }
        }
        .padding(.vertical, compact ? 6 : 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(event.type.displayName) on \(event.cameraName ?? event.cameraId), \(event.severity.displayName), \(event.occurredAt.formatted(date: .abbreviated, time: .shortened))\(event.acknowledged ? ", acknowledged" : "")"
        )
    }
}

struct EventDetailSheet: View {
    let event: CameraEvent
    let acknowledge: (String?) async -> APIError?

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var isSubmitting = false
    @State private var error: APIError?
    @State private var acknowledged: Bool

    init(event: CameraEvent, acknowledge: @escaping (String?) async -> APIError?) {
        self.event = event
        self.acknowledge = acknowledge
        _acknowledged = State(initialValue: event.acknowledged)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Camera", value: event.cameraName ?? event.cameraId)
                    LabeledContent("Type", value: event.type.displayName)
                    LabeledContent("Severity", value: event.severity.displayName)
                    LabeledContent(
                        "Occurred",
                        value: event.occurredAt.formatted(date: .abbreviated, time: .standard))
                    if let confidence = event.confidence {
                        LabeledContent("Confidence", value: "\(Int(confidence * 100))%")
                    }
                    if let retention = event.retentionUntil {
                        LabeledContent(
                            "Retained until",
                            value: retention.formatted(date: .abbreviated, time: .omitted))
                    }
                }

                if acknowledged {
                    Section("Acknowledgement") {
                        if let by = event.acknowledgedBy {
                            LabeledContent("By", value: by)
                        }
                        if let at = event.acknowledgedAt {
                            LabeledContent(
                                "At", value: at.formatted(date: .abbreviated, time: .shortened))
                        }
                        if let note = event.note, !note.isEmpty {
                            Text(note)
                        }
                    }
                } else if environment.auth.state.user?.can(.eventsAcknowledge) == true {
                    Section("Acknowledge") {
                        TextField("Note (optional)", text: $note, axis: .vertical)
                            .lineLimit(2...4)
                        Button {
                            Task { await submit() }
                        } label: {
                            if isSubmitting {
                                ProgressView()
                            } else {
                                Text("Acknowledge event")
                            }
                        }
                        .disabled(isSubmitting)
                    }
                } else {
                    Section {
                        Text(
                            "Your role (\(environment.auth.state.user?.role.displayName ?? "Viewer")) cannot acknowledge events."
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                }

                if let error {
                    Section { ErrorSummary(error: error) }
                }
            }
            .navigationTitle(event.type.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func submit() async {
        isSubmitting = true
        error = nil
        defer { isSubmitting = false }

        if let failure = await acknowledge(note.isEmpty ? nil : note) {
            error = failure
        } else {
            acknowledged = true
        }
    }
}
