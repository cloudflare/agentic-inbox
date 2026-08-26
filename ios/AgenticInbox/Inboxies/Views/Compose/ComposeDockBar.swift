import SwiftUI

/// Minimized compose dock — Notion floating chrome, Mail interaction.
struct ComposeDockBar: View {
    @Environment(AppModel.self) private var app
    let session: ComposeSession

    var body: some View {
        Button {
            withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                app.expandCompose()
            }
        } label: {
            HStack {
                Image(systemName: "pencil.and.scribble")
                    .font(.system(size: 14, weight: .semibold))
                Text(session.dockTitle)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                Spacer(minLength: 8)
            }
            .foregroundStyle(AppTheme.ink)
            .padding(.horizontal, 18)
            .frame(height: 48)
            .frame(maxWidth: .infinity)
            .background(AppTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .shadow(color: .black.opacity(0.1), radius: 12, y: 4)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
