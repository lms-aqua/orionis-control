import SwiftUI

/// Drag-to-reorder the camera grid.
///
/// The order is saved to the account rather than the device, so the arrangement
/// follows the person to another phone instead of having to be recreated there.
///
/// Deliberately built from small pieces: as one nested expression the type-checker
/// gives up on it ("unable to type-check this expression in reasonable time"), which
/// is the usual cost of a deeply nested SwiftUI body.
struct CameraOrderView: View {
    let model: CamerasViewModel

    @Environment(\.dismiss) private var dismiss
    @State private var ordered: [Camera] = []
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            list
                // Always in edit mode: this sheet exists only to reorder, so making
                // the handles appear should not be a separate step.
                .environment(\.editMode, .constant(.active))
                .navigationTitle("Reorder cameras")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbarContent }
                .task { ordered = model.visible(favourites: []) }
        }
    }

    private var list: some View {
        List {
            Section {
                ForEach(ordered) { camera in
                    row(camera)
                }
                .onMove { source, destination in
                    ordered.move(fromOffsets: source, toOffset: destination)
                }
            } footer: {
                Text(
                    "Drag to reorder. This order is saved to your account and applies on every device."
                )
            }
        }
    }

    private func row(_ camera: Camera) -> some View {
        let online = camera.health.status == .online
        return HStack(spacing: 10) {
            Image(systemName: online ? "video.fill" : "video.slash.fill")
                .foregroundStyle(online ? Color.secondary : Color.red)
            VStack(alignment: .leading, spacing: 1) {
                Text(camera.name)
                if let location = camera.location {
                    Text(location)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
            Button("Save") { save() }
                .disabled(isSaving)
        }
    }

    private func save() {
        let ids = ordered.map(\.id)
        Task {
            isSaving = true
            await model.saveOrder(ids)
            isSaving = false
            dismiss()
        }
    }
}
