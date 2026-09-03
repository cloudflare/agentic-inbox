import SwiftUI

struct RootView: View {
    @Environment(AuthStore.self) private var auth
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            if auth.isAuthenticated {
                HomeShellView()
                    .task(id: auth.token) {
                        await app.bootstrap(authToken: auth.token)
                    }
            } else {
                SignInView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: auth.isAuthenticated)
    }
}
