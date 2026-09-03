import AuthenticationServices
import SwiftUI

/// First screen for a web/hybrid developer: this is your "login route".
/// Production uses Sign in with Apple (required by App Store when offering account login).
/// DEBUG also offers a local-dev login that hits `/api/v1/auth/dev`.
struct SignInView: View {
    @Environment(AuthStore.self) private var auth
    @State private var apiBase = AppConfig.apiBaseURL.absoluteString

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.96, green: 0.97, blue: 0.99),
                    Color(red: 0.92, green: 0.93, blue: 0.96),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            VStack(spacing: 28) {
                Spacer()

                VStack(spacing: 10) {
                    Image(systemName: "envelope.open.fill")
                        .font(.system(size: 44, weight: .light))
                        .foregroundStyle(AppTheme.ink)
                    Text("Agentic Inbox")
                        .font(.system(size: 34, weight: .semibold, design: .rounded))
                        .foregroundStyle(AppTheme.ink)
                    Text("Your email, with an AI agent that drafts — you send.")
                        .font(.system(size: 16))
                        .foregroundStyle(AppTheme.muted)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }

                VStack(spacing: 14) {
                    SignInWithAppleButton(.signIn) { request in
                        request.requestedScopes = [.fullName, .email]
                    } onCompletion: { result in
                        Task {
                            commitAPIBaseURL()
                            await handleApple(result)
                        }
                    }
                    .signInWithAppleButtonStyle(.black)
                    .frame(height: 52)
                    .padding(.horizontal, 32)

                    #if DEBUG
                    if AppConfig.isLocalDevelopmentAPI {
                        Button {
                            Task {
                                commitAPIBaseURL()
                                await auth.signInDev()
                            }
                        } label: {
                            Text("Continue with Dev Login")
                                .font(.system(size: 15, weight: .medium))
                                .frame(maxWidth: .infinity)
                                .frame(height: 48)
                                .background(AppTheme.pillFill)
                                .foregroundStyle(AppTheme.ink)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .padding(.horizontal, 32)
                    }
                    #endif
                }

                if auth.isBusy {
                    ProgressView()
                }

                if let error = auth.errorMessage {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(.horizontal)
                }

                Spacer()

                VStack(alignment: .leading, spacing: 6) {
                    Text("API base URL")
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                    TextField("inboxies.email", text: $apiBase)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .font(.system(size: 14, design: .monospaced))
                        .padding(12)
                        .background(AppTheme.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .onChange(of: apiBase) { _, value in
                            UserDefaults.standard.set(value, forKey: "apiBaseURL")
                        }
                        .onSubmit {
                            commitAPIBaseURL()
                        }
                    Text("Bare domains (inboxies.email) automatically use https://")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.muted)
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 24)
            }
        }
    }

    private func commitAPIBaseURL() {
        let value = apiBase.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = AppConfig.parseAPIBaseURL(value) {
            apiBase = url.absoluteString
            UserDefaults.standard.set(apiBase, forKey: "apiBaseURL")
        } else {
            UserDefaults.standard.set(value, forKey: "apiBaseURL")
        }
    }

    private func handleApple(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case .failure(let error):
            auth.errorMessage = error.localizedDescription
        case .success(let authResult):
            guard let credential = authResult.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken,
                  let token = String(data: tokenData, encoding: .utf8) else {
                auth.errorMessage = "Apple did not return an identity token"
                return
            }
            await auth.signInWithApple(identityToken: token, email: credential.email)
        }
    }
}
