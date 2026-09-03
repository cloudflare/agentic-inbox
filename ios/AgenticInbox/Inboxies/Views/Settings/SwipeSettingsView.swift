import SwiftUI
import UniformTypeIdentifiers

/// Configure multi-action swipe preferences for normal folders.
struct SwipeSettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var leftActions: [SwipeQuickAction] = []
    @State private var rightActions: [SwipeQuickAction] = []
    @State private var addingEdge: SwipeEdge?
    @State private var draggingAction: SwipeQuickAction?

    private enum SwipeEdge: Identifiable {
        case left
        case right

        var id: String {
            switch self {
            case .left: return "left"
            case .right: return "right"
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                previewCard

                actionSection(
                    title: "Right swipe",
                    actions: $rightActions,
                    edge: .right
                )

                actionSection(
                    title: "Left swipe",
                    actions: $leftActions,
                    edge: .left
                )
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .background(AppTheme.background)
        .navigationTitle("Swipe Settings")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(AppTheme.ink)
                        .frame(width: 32, height: 32)
                        .background(AppTheme.pillFill, in: Circle())
                }
                .accessibilityLabel("Back")
            }
        }
        .sheet(item: $addingEdge) { edge in
            addActionSheet(for: edge)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        .onAppear(perform: load)
    }

    private var previewCard: some View {
        VStack(spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.red)
                Text("Move to Inbox")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(AppTheme.muted)
                Spacer(minLength: 0)
            }

            previewRow(leadingAction: rightActions.first, trailingAction: nil, revealLeading: true)
            previewRow(leadingAction: nil, trailingAction: leftActions.first, revealLeading: false)
        }
        .padding(14)
        .background(AppTheme.pillFill.opacity(0.65), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func previewRow(
        leadingAction: SwipeQuickAction?,
        trailingAction: SwipeQuickAction?,
        revealLeading: Bool
    ) -> some View {
        HStack(spacing: 0) {
            if revealLeading, let leadingAction {
                previewActionChip(leadingAction)
            }

            HStack(spacing: 10) {
                Circle()
                    .fill(Color.white.opacity(0.9))
                    .frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 6) {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(Color.white.opacity(0.95))
                        .frame(height: 8)
                        .frame(maxWidth: 120)
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(Color.white.opacity(0.7))
                        .frame(height: 6)
                        .frame(maxWidth: 80)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            if !revealLeading, let trailingAction {
                previewActionChip(trailingAction)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func previewActionChip(_ action: SwipeQuickAction) -> some View {
        Image(systemName: action.systemImage)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 52, height: 52)
            .background(action.swipeTint)
    }

    @ViewBuilder
    private func actionSection(
        title: String,
        actions: Binding<[SwipeQuickAction]>,
        edge: SwipeEdge
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(AppTheme.muted)

            ForEach(actions.wrappedValue) { action in
                actionRow(
                    action: action,
                    actions: actions,
                    canRemove: actions.wrappedValue.count > 1
                )
            }

            if actions.wrappedValue.count < SwipeActionPreferences.maxActionsPerEdge {
                Button {
                    addingEdge = edge
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus")
                            .font(.system(size: 14, weight: .semibold))
                        Text("Add action")
                            .font(.system(size: 15, weight: .medium))
                    }
                    .foregroundStyle(AppTheme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 28)
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func actionRow(
        action: SwipeQuickAction,
        actions: Binding<[SwipeQuickAction]>,
        canRemove: Bool
    ) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(AppTheme.muted.opacity(0.75))
                .frame(width: 18, height: 44)
                .contentShape(Rectangle())
                .onDrag {
                    draggingAction = action
                    return NSItemProvider(object: action.rawValue as NSString)
                }

            HStack(spacing: 12) {
                Image(systemName: action.systemImage)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(AppTheme.ink)
                    .frame(width: 22)

                Text(action.title)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(AppTheme.ink)

                Spacer(minLength: 0)

                if canRemove {
                    Button {
                        actions.wrappedValue.removeAll { $0 == action }
                        persist()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(AppTheme.muted)
                            .frame(width: 24, height: 24)
                            .background(AppTheme.background, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(action.title)")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AppTheme.pillFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .opacity(draggingAction == action ? 0.55 : 1)
        .onDrop(
            of: [UTType.text],
            delegate: SwipeActionDropDelegate(
                item: action,
                actions: actions,
                draggingAction: $draggingAction,
                onReorder: persist
            )
        )
    }

    private func addActionSheet(for edge: SwipeEdge) -> some View {
        let used = edge == .left ? Set(leftActions) : Set(rightActions)
        let available = SwipeQuickAction.allCases.filter { !used.contains($0) }

        return NavigationStack {
            List {
                if available.isEmpty {
                    Text("All actions are already assigned to this swipe.")
                        .foregroundStyle(AppTheme.muted)
                } else {
                    ForEach(available) { action in
                        Button {
                            addAction(action, edge: edge)
                            addingEdge = nil
                        } label: {
                            Label(action.title, systemImage: action.systemImage)
                                .foregroundStyle(AppTheme.ink)
                        }
                    }
                }
            }
            .navigationTitle("Add action")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { addingEdge = nil }
                }
            }
        }
    }

    private func load() {
        leftActions = app.swipePreferences.leftActions
        rightActions = app.swipePreferences.rightActions
    }

    private func persist() {
        app.updateSwipePreferences { prefs in
            prefs.leftActions = leftActions
            prefs.rightActions = rightActions
        }
    }

    private func addAction(_ action: SwipeQuickAction, edge: SwipeEdge) {
        switch edge {
        case .left:
            guard leftActions.count < SwipeActionPreferences.maxActionsPerEdge,
                  !leftActions.contains(action) else { return }
            leftActions.append(action)
        case .right:
            guard rightActions.count < SwipeActionPreferences.maxActionsPerEdge,
                  !rightActions.contains(action) else { return }
            rightActions.append(action)
        }
        persist()
    }
}

private struct SwipeActionDropDelegate: DropDelegate {
    let item: SwipeQuickAction
    @Binding var actions: [SwipeQuickAction]
    @Binding var draggingAction: SwipeQuickAction?
    var onReorder: () -> Void

    func dropEntered(info: DropInfo) {
        guard let draggingAction,
              draggingAction != item,
              let from = actions.firstIndex(of: draggingAction),
              let to = actions.firstIndex(of: item) else { return }
        withAnimation(.snappy(duration: 0.2)) {
            actions.move(fromOffsets: IndexSet(integer: from), toOffset: to > from ? to + 1 : to)
        }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .move)
    }

    func performDrop(info: DropInfo) -> Bool {
        draggingAction = nil
        onReorder()
        return true
    }
}

#Preview("Swipe settings") {
    PreviewHost {
        NavigationStack {
            SwipeSettingsView()
        }
    }
}
