package co.inboxies.app

import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.core.view.WindowCompat
import co.inboxies.app.services.AppModel
import co.inboxies.app.services.PushNotificationManager
import co.inboxies.app.services.AuthStore
import co.inboxies.app.theme.InboxiesTheme
import co.inboxies.app.theme.ThemeMode
import co.inboxies.app.ui.RootView
import co.inboxies.app.ui.preview.PreviewHarness
import co.inboxies.app.ui.preview.PreviewMode
import co.inboxies.app.ui.preview.PreviewRoot

val LocalAuthStore = staticCompositionLocalOf<AuthStore> { error("AuthStore missing") }
val LocalAppModel = staticCompositionLocalOf<AppModel> { error("AppModel missing") }

class MainActivity : ComponentActivity() {
    private lateinit var appModel: AppModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
        val auth = (application as InboxiesApplication).authStore
        appModel = AppModel()
        val model = appModel
        val previewMode = PreviewMode.fromIntent(intent)
        if (previewMode != null) {
            PreviewHarness.seed(previewMode, auth, model)
        } else {
            auth.resyncFromStorage()
            // Any app can start this exported activity, so only debug builds may
            // repoint the API (and with it, where the bearer token is sent).
            val extraApiBase = if (BuildConfig.DEBUG) intent.getStringExtra("apiBase") else null
            if (!extraApiBase.isNullOrBlank()) {
                co.inboxies.app.config.AppConfig.parseAPIBaseURL(extraApiBase)?.let { parsed ->
                    co.inboxies.app.config.AppConfig.apiBaseURL = parsed
                }
            }
            handlePushIntent(intent)
            handleInviteIntent(intent)
            handleOnboardingIntent(intent)
        }
        setContent {
            var themeMode by remember {
                mutableStateOf(
                    ThemeMode.fromStorage(
                        getSharedPreferences("inboxies_prefs", MODE_PRIVATE)
                            .getString("app_theme", null),
                    ),
                )
            }
            InboxiesTheme(themeMode = themeMode) {
                CompositionLocalProvider(
                    LocalAuthStore provides auth,
                    LocalAppModel provides model,
                ) {
                    if (previewMode != null) {
                        PreviewRoot(
                            mode = previewMode,
                            auth = auth,
                            appModel = model,
                            themeMode = themeMode,
                            onThemeModeChange = { mode ->
                                themeMode = mode
                                getSharedPreferences("inboxies_prefs", MODE_PRIVATE)
                                    .edit()
                                    .putString("app_theme", mode.name)
                                    .apply()
                            },
                        )
                    } else {
                        RootView(
                            auth = auth,
                            appModel = model,
                            themeMode = themeMode,
                            onThemeModeChange = { mode ->
                                themeMode = mode
                                getSharedPreferences("inboxies_prefs", MODE_PRIVATE)
                                    .edit()
                                    .putString("app_theme", mode.name)
                                    .apply()
                            },
                        )
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (PreviewMode.fromIntent(intent) != null) return
        handlePushIntent(intent)
        handleInviteIntent(intent)
        handleOnboardingIntent(intent)
    }

    private fun handleOnboardingIntent(intent: Intent?) {
        if (intent == null) return
        val data = intent.data ?: return
        val isOnboarding = (data.scheme == "inboxies" && (data.host == "onboarding" || data.host == "domain-ready"))
            || (data.host == "inboxies.email" && data.path?.startsWith("/onboarding") == true)
        if (isOnboarding) {
            // Never take a session from a link: anyone can send one. Onboarding
            // signs in with the password chosen at checkout instead.
            if (::appModel.isInitialized) {
                lifecycleScope.launch {
                    appModel.refreshMailboxes(showLoading = true)
                }
            }
            intent.data = null
        }
    }

    private fun handleInviteIntent(intent: Intent?) {
        if (intent == null) return
        val data = intent.data ?: return
        val token = when {
            data.scheme == "inboxies" && data.host == "invite" ->
                data.pathSegments.firstOrNull()
            data.host == "inboxies.email" && data.path?.startsWith("/invite/") == true ->
                data.path!!.removePrefix("/invite/").trim('/')
            else -> null
        }?.takeIf { it.isNotBlank() } ?: return
        if (::appModel.isInitialized) {
            appModel.setPendingInviteToken(token)
        }
        intent.data = null
    }

    private fun handlePushIntent(intent: Intent?) {
        if (intent == null) return
        val mailboxId = intent.getStringExtra("mailboxId")
        val emailId = intent.getStringExtra("emailId")
        val folderId = intent.getStringExtra("folderId")
        if (mailboxId.isNullOrBlank() || emailId.isNullOrBlank()) return
        PushNotificationManager.shared.setPendingDeepLink(mailboxId, emailId, folderId)
        // Prevent re-processing on recreation.
        intent.removeExtra("mailboxId")
        intent.removeExtra("emailId")
        intent.removeExtra("folderId")
    }
}
