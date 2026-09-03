import SwiftUI

/// Minimized compose dock — Mail-style full-bleed bar flush to the screen bottom.
struct ComposeDockBar: View {
    @Environment(AppModel.self) private var app
    let session: ComposeSession

    var body: some View {
        Button {
            withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                app.expandCompose()
            }
        } label: {
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                Text(session.dockTitle)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                if session.form.saveStatus == .saving {
                    ProgressView()
                        .controlSize(.mini)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .foregroundStyle(AppTheme.ink)
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity)
                .background(AppTheme.surface)
                .clipShape(
                    UnevenRoundedRectangle(
                        topLeadingRadius: 18,
                        topTrailingRadius: 18,
                        style: .continuous
                    )
                )
                .shadow(color: .black.opacity(0.12), radius: 16, y: -4)
        }
        .buttonStyle(.plain)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
