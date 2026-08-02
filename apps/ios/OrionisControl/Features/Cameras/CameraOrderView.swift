import SwiftUI

/// Drag-to-reorder the camera grid.
///
/// The order is saved to the account rather than the device, so the arrangement
/// follows the person to another phone instead of having to be recreated there.
struct CameraOrderView: View {
    let model: CamerasViewModel

    @Environment(\.dismiss) private var dismiss
    @State private var ordered: [Camera] = []
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(ordered) { camera in
                        HStack(spacing: 10) {
                            Image(
                                systemName: camera.health.status == .online
                                    ? "video.fill" : "video.slash.fill"
                            )
                            .foregroundStyle(camera.health.status == .online ? .secondary : .red)
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
                    .onMove { source, destination in
                        ordered.move(fromOffsets: source, toOffset: destination)
                    }
                } footer: {
                    Text("Drag to reorder. This order is saved to your account and applies on every device.")
                }
            }
            // Always in edit mode: the sheet exists only to reorder, so making the
            // handles appear should not be a separate step.
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Reorder cameras")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            isSaving = true
                            await model.saveOrder(ordered.map(\.id))
                            isSaving = false
                            dismiss()
                        }
                    }
                    .disabled(isSaving)
                }
            }
            .task {
                // Start from what the grid is showing, so the list a viewer drags
                // matches the order they were just looking at.
                ordered = model.visible(favourites: [])
            }
        }
    }
}
