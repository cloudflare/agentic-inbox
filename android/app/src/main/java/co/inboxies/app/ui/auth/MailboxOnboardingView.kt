package co.inboxies.app.ui.auth

import android.content.Intent
import android.net.Uri
import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Mail
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import co.inboxies.app.BuildConfig
import co.inboxies.app.LocalAppModel
import co.inboxies.app.LocalAuthStore
import co.inboxies.app.models.DomainAvailabilityResponse
import co.inboxies.app.models.DomainCheckoutResponse
import co.inboxies.app.models.InvitePublic
import co.inboxies.app.services.ApiClient
import co.inboxies.app.theme.InterFontFamily
import co.inboxies.app.theme.inboxiesColors
import co.inboxies.app.theme.liquidGlass
import co.inboxies.app.ui.settings.DomainAdminSettingsView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun InviteAcceptView(
    token: String,
    onDone: () -> Unit,
) {
    val auth = LocalAuthStore.current
    val app = LocalAppModel.current
    val colors = inboxiesColors()
    val scope = rememberCoroutineScope()
    var invite by remember { mutableStateOf<InvitePublic?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var formError by remember { mutableStateOf<String?>(null) }

    androidx.compose.runtime.LaunchedEffect(token) {
        runCatching { ApiClient.shared.getInvite(token) }
            .onSuccess { invite = it }
            .onFailure { loadError = it.message }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
    ) {
        TextButton(onClick = onDone) {
            Text("Cancel", color = colors.muted, fontFamily = InterFontFamily)
        }
        Spacer(Modifier.height(16.dp))
        Text(
            "Accept invite",
            fontFamily = InterFontFamily,
            fontWeight = FontWeight.Bold,
            fontSize = 24.sp,
            color = colors.ink,
        )
        when {
            loadError != null -> Text(loadError!!, color = colors.deepDarkRed, modifier = Modifier.padding(top = 12.dp))
            invite == null -> CircularProgressIndicator(modifier = Modifier.padding(top = 24.dp))
            else -> {
                Text(
                    "Set a password for ${invite!!.mailboxId}",
                    color = colors.muted,
                    fontFamily = InterFontFamily,
                    modifier = Modifier.padding(top = 8.dp, bottom = 16.dp),
                )
                OutlinedTextField(
                    value = displayName,
                    onValueChange = { displayName = it },
                    label = { Text("Display name (optional)") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Password") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = confirm,
                    onValueChange = { confirm = it },
                    label = { Text("Confirm password") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                formError?.let {
                    Text(it, color = colors.deepDarkRed, modifier = Modifier.padding(top = 8.dp))
                }
                Spacer(Modifier.height(16.dp))
                Button(
                    onClick = {
                        scope.launch {
                            formError = null
                            if (password != confirm) {
                                formError = "Passwords do not match"
                                return@launch
                            }
                            if (password.length < 10) {
                                formError = "Password must be at least 10 characters"
                                return@launch
                            }
                            submitting = true
                            try {
                                val result = ApiClient.shared.acceptInvite(
                                    token,
                                    password,
                                    displayName.ifBlank { null },
                                )
                                auth.applySession(result.token, result.mailboxId)
                                app.bootstrap(result.token)
                                onDone()
                            } catch (e: Exception) {
                                formError = e.message
                            } finally {
                                submitting = false
                            }
                        }
                    },
                    enabled = !submitting && password.length >= 10,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (submitting) CircularProgressIndicator()
                    else Text("Create account", fontFamily = InterFontFamily)
                }
            }
        }
    }
}

sealed interface OnboardingTrack {
    data object Select : OnboardingTrack
    data class Personal(val step: Int = 1) : OnboardingTrack
    data class Domain(val step: Int = 1) : OnboardingTrack
    data class DnsWizard(val domain: String, val nameservers: List<String>) : OnboardingTrack
}

private fun onboardingDepth(track: OnboardingTrack): Int = when (track) {
    OnboardingTrack.Select -> 0
    is OnboardingTrack.Personal -> 10 + track.step
    is OnboardingTrack.Domain -> 100 + track.step
    is OnboardingTrack.DnsWizard -> 200
}

data class OnboardingUserItem(
    val id: String = java.util.UUID.randomUUID().toString(),
    val name: String,
    val email: String,
    val username: String,
)

data class OnboardingAliasItem(
    val id: String = java.util.UUID.randomUUID().toString(),
    val alias: String,
    val target: String,
)

@Composable
fun MailboxOnboardingView(
    initialTrack: OnboardingTrack = OnboardingTrack.Select,
    onDismiss: (() -> Unit)? = null,
    showsDragHandle: Boolean = false,
    onRootChanged: (Boolean) -> Unit = {},
) {
    val app = LocalAppModel.current
    val auth = LocalAuthStore.current
    val colors = inboxiesColors()
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val view = LocalView.current
    val isAdmin by app.isAdmin.collectAsState()
    val mailDomain by app.mailDomain.collectAsState()
    val appErrorMessage by app.errorMessage.collectAsState()

    val backStack = remember(initialTrack) {
        mutableStateListOf<OnboardingTrack>().apply {
            add(OnboardingTrack.Select)
            if (initialTrack != OnboardingTrack.Select) {
                add(initialTrack)
            }
        }
    }
    val currentTrack = backStack.lastOrNull() ?: OnboardingTrack.Select

    LaunchedEffect(backStack.size) {
        onRootChanged(backStack.size == 1)
    }

    var devTapCount by remember { mutableStateOf(0) }

    // Personal track state
    var personalName by remember { mutableStateOf("") }
    var personalPassword by remember { mutableStateOf("") }
    var isPersonalPasswordVisible by remember { mutableStateOf(false) }
    var personalBackupEmail by remember { mutableStateOf("") }
    var personalUsername by remember { mutableStateOf("") }

    // Custom domain track state
    var customName by remember { mutableStateOf("") }
    var customPassword by remember { mutableStateOf("") }
    var isCustomPasswordVisible by remember { mutableStateOf(false) }
    var customBackupEmail by remember { mutableStateOf("") }
    var customDomain by remember { mutableStateOf("") }
    var customUsername by remember { mutableStateOf("") }

    // Domain purchase / connect state
    var availability by remember { mutableStateOf<DomainAvailabilityResponse?>(null) }
    var isCheckingDomain by remember { mutableStateOf(false) }
    var domainAction by remember { mutableStateOf("purchase") }
    var activeNameservers by remember { mutableStateOf(listOf("ns1.cloudflare.com", "ns2.cloudflare.com")) }
    var isWatchingDns by remember { mutableStateOf(false) }
    var isPaymentSyncing by remember { mutableStateOf(false) }

    // Team users state
    val teamUsers = remember { mutableStateListOf<OnboardingUserItem>() }
    var newUserName by remember { mutableStateOf("") }
    var newUserEmail by remember { mutableStateOf("") }
    var newUserUsername by remember { mutableStateOf("") }

    // Aliases state
    val domainAliases = remember { mutableStateListOf<OnboardingAliasItem>() }
    var newAliasUsername by remember { mutableStateOf("") }
    var newAliasTarget by remember { mutableStateOf("") }

    val token by auth.token.collectAsState()
    LaunchedEffect(token, isPaymentSyncing) {
        if (isPaymentSyncing && !token.isNullOrBlank()) {
            val domain = customDomain.trim().lowercase()
            try { ApiClient.shared.fixDomainEmailDns(domain) } catch (_: Exception) {}
            isPaymentSyncing = false
            backStack.add(OnboardingTrack.Domain(7))
        }
    }

    // The checkout return link carries no session. Wait for the webhook to
    // create the account, then sign in with the password chosen at checkout.
    LaunchedEffect(isPaymentSyncing) {
        if (!isPaymentSyncing || auth.isAuthenticated) return@LaunchedEffect
        val domain = customDomain.trim().lowercase()
        repeat(40) {
            val ready = try {
                ApiClient.shared.checkoutStatus(domain).status == "ready"
            } catch (_: Exception) {
                false
            }
            if (ready) {
                val username = customUsername.ifBlank { "admin" }.trim().lowercase()
                auth.signInWithPassword("$username@$domain", customPassword)
                return@LaunchedEffect
            }
            kotlinx.coroutines.delay(1_500)
        }
    }

    LaunchedEffect(customDomain) {
        val trimmed = customDomain.trim().lowercase().removePrefix(".").removeSuffix(".")
        if (!trimmed.contains(".") || trimmed.endsWith(".")) {
            availability = null
            isCheckingDomain = false
            return@LaunchedEffect
        }
        isCheckingDomain = true
        delay(500)
        try {
            val res = ApiClient.shared.checkDomainAvailability(trimmed)
            availability = res
            domainAction = if (res.available) "purchase" else "connect"
        } catch (e: Exception) {
            availability = null
        } finally {
            isCheckingDomain = false
        }
    }

    var isSubmitting by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var statusMessage by remember { mutableStateOf<String?>(null) }

    val canGoBack = backStack.size > 1 && !(currentTrack is OnboardingTrack.Domain && currentTrack.step >= 11)

    fun navigateBack() {
        if (canGoBack) {
            errorMessage = null
            statusMessage = null
            backStack.removeAt(backStack.lastIndex)
        } else {
            onDismiss?.invoke()
        }
    }

    BackHandler(enabled = canGoBack) {
        navigateBack()
    }
    BackHandler(enabled = !canGoBack && onDismiss != null) {
        onDismiss?.invoke()
    }

    if (isAdmin && currentTrack == OnboardingTrack.Select) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding(),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = {
                        app.reset()
                        auth.signOut()
                    },
                ) {
                    Text("Sign out", color = colors.deepDarkRed, fontFamily = InterFontFamily)
                }
                if (onDismiss != null) {
                    Box(
                        modifier = Modifier
                            .size(42.dp)
                            .liquidGlass(CircleShape)
                            .clip(CircleShape)
                            .clickable {
                                view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
                                onDismiss()
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Close,
                            contentDescription = "Close",
                            tint = colors.ink,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
            DomainAdminSettingsView()
        }
        return
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .imePadding(),
    ) {
        AnimatedContent(
            targetState = currentTrack,
            modifier = Modifier.fillMaxSize(),
            transitionSpec = {
                val forward = onboardingDepth(targetState) >= onboardingDepth(initialState)
                val navSpring = spring<IntOffset>(dampingRatio = 0.86f, stiffness = Spring.StiffnessMediumLow)
                val fadeSpring = spring<Float>(dampingRatio = 0.86f, stiffness = Spring.StiffnessMediumLow)
                (
                    slideInHorizontally(animationSpec = navSpring) { full ->
                        if (forward) full / 3 else -full / 3
                    } + fadeIn(animationSpec = fadeSpring)
                ) togetherWith (
                    slideOutHorizontally(animationSpec = navSpring) { full ->
                        if (forward) -full / 4 else full / 4
                    } + fadeOut(animationSpec = fadeSpring)
                )
            },
            label = "onboardingTrackNav",
        ) { step ->
            when (step) {
                OnboardingTrack.Select -> {
                    Column(
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        if (showsDragHandle) {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 10.dp)
                                    .height(24.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(width = 36.dp, height = 5.dp)
                                        .clip(CircleShape)
                                        .background(colors.line),
                                )
                            }
                        }

                        // Header Navigation Bar for initial screen: right side close button (if onDismiss != null), left side sign out (if auth && onDismiss == null)
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 20.dp)
                                .padding(top = 14.dp, bottom = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            if (auth.isAuthenticated && onDismiss == null) {
                                TextButton(onClick = {
                                    app.reset()
                                    auth.signOut()
                                }) {
                                    Text("Sign out", color = colors.deepDarkRed, fontFamily = InterFontFamily)
                                }
                            } else {
                                Spacer(Modifier.size(42.dp))
                            }

                            if (onDismiss != null) {
                                Box(
                                    modifier = Modifier
                                        .size(42.dp)
                                        .liquidGlass(CircleShape)
                                        .clip(CircleShape)
                                        .clickable {
                                            view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
                                            onDismiss()
                                        },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(
                                        imageVector = Icons.Outlined.Close,
                                        contentDescription = "Close",
                                        tint = colors.ink,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            } else {
                                Spacer(Modifier.size(42.dp))
                            }
                        }

                        Column(
                            modifier = Modifier
                                .fillMaxSize()
                                .verticalScroll(rememberScrollState())
                                .padding(24.dp),
                        ) {
                        val currentErr = appErrorMessage
                        if (currentErr != null) {
                            Surface(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(bottom = 20.dp),
                                shape = RoundedCornerShape(12.dp),
                                color = colors.deepDarkRed.copy(alpha = 0.08f),
                            ) {
                                Column(modifier = Modifier.padding(14.dp)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Icon(
                                            imageVector = Icons.Outlined.Warning,
                                            contentDescription = null,
                                            tint = colors.deepDarkRed,
                                            modifier = Modifier.size(16.dp),
                                        )
                                        Spacer(Modifier.width(8.dp))
                                        Text(
                                            "Could not load mailboxes: $currentErr",
                                            color = colors.deepDarkRed,
                                            fontFamily = InterFontFamily,
                                            fontSize = 13.sp,
                                            fontWeight = FontWeight.Medium,
                                        )
                                    }
                                    Spacer(Modifier.height(8.dp))
                                    Text(
                                        "Retry",
                                        color = colors.accent,
                                        fontFamily = InterFontFamily,
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        modifier = Modifier
                                            .clip(RoundedCornerShape(6.dp))
                                            .clickable {
                                                scope.launch {
                                                    app.refreshMailboxes(showLoading = true)
                                                }
                                            }
                                            .padding(vertical = 4.dp, horizontal = 2.dp),
                                    )
                                }
                            }
                        }

                        Text(
                            "Welcome to Inboxies",
                            fontFamily = InterFontFamily,
                            fontWeight = FontWeight.Bold,
                            fontSize = 28.sp,
                            color = colors.ink,
                        )
                        Text(
                            "Choose how you would like to set up your email.",
                            fontFamily = InterFontFamily,
                            fontSize = 16.sp,
                            color = colors.muted,
                            modifier = Modifier.padding(top = 8.dp, bottom = 32.dp),
                        )

                        // Track Choice: Personal Address
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(22.dp))
                                .background(colors.pillFill)
                                .clickable {
                                    errorMessage = null
                                    statusMessage = null
                                    backStack.add(OnboardingTrack.Personal(1))
                                }
                                .padding(horizontal = 18.dp, vertical = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                modifier = Modifier.size(32.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    Icons.Outlined.Mail,
                                    contentDescription = null,
                                    tint = colors.accent,
                                    modifier = Modifier.size(22.dp),
                                )
                            }

                            Spacer(Modifier.width(14.dp))

                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    "Personal Address",
                                    fontFamily = InterFontFamily,
                                    fontWeight = FontWeight.SemiBold,
                                    fontSize = 15.sp,
                                    color = colors.ink,
                                )
                                Text(
                                    "Instant @$mailDomain email. No setup required.",
                                    fontFamily = InterFontFamily,
                                    fontSize = 13.sp,
                                    color = colors.muted,
                                )
                            }

                            Icon(
                                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                                contentDescription = null,
                                tint = colors.muted.copy(alpha = 0.55f),
                                modifier = Modifier.size(16.dp),
                            )
                        }

                        Spacer(Modifier.height(14.dp))

                        // Track Choice: Custom Domain
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(22.dp))
                                .background(colors.pillFill)
                                .clickable {
                                    errorMessage = null
                                    statusMessage = null
                                    backStack.add(OnboardingTrack.Domain(1))
                                }
                                .padding(horizontal = 18.dp, vertical = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                modifier = Modifier.size(32.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    Icons.Outlined.Public,
                                    contentDescription = null,
                                    tint = colors.accent,
                                    modifier = Modifier.size(22.dp),
                                )
                            }

                            Spacer(Modifier.width(14.dp))

                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    "Custom Domain",
                                    fontFamily = InterFontFamily,
                                    fontWeight = FontWeight.SemiBold,
                                    fontSize = 15.sp,
                                    color = colors.ink,
                                )
                                Text(
                                    "Automate Cloudflare setup with your own domain.",
                                    fontFamily = InterFontFamily,
                                    fontSize = 13.sp,
                                    color = colors.muted,
                                )
                            }

                            Icon(
                                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                                contentDescription = null,
                                tint = colors.muted.copy(alpha = 0.55f),
                                modifier = Modifier.size(16.dp),
                            )
                        }
                    }
                    }
                }

                is OnboardingTrack.Personal -> {
                    val personalStep = step.step
                    Column(
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        // Subsequent step toolbar: left side back button only
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 20.dp)
                                .padding(top = 14.dp, bottom = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(42.dp)
                                    .liquidGlass(CircleShape)
                                    .clip(CircleShape)
                                    .clickable {
                                        view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
                                        navigateBack()
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                                    contentDescription = "Back",
                                    tint = colors.ink,
                                    modifier = Modifier.size(18.dp),
                                )
                            }

                            if (auth.isAuthenticated && onDismiss == null) {
                                TextButton(onClick = {
                                    app.reset()
                                    auth.signOut()
                                }) {
                                    Text("Sign out", color = colors.deepDarkRed, fontFamily = InterFontFamily)
                                }
                            } else {
                                Spacer(Modifier.size(42.dp))
                            }
                        }

                        Column(
                            modifier = Modifier
                                .fillMaxSize()
                                .verticalScroll(rememberScrollState())
                                .padding(24.dp),
                        ) {
                        errorMessage?.let { msg ->
                            Text(
                                msg,
                                color = colors.deepDarkRed,
                                fontFamily = InterFontFamily,
                                fontSize = 13.sp,
                                modifier = Modifier.padding(bottom = 12.dp),
                            )
                        }

                        statusMessage?.let { msg ->
                            Text(
                                msg,
                                color = colors.accent,
                                fontFamily = InterFontFamily,
                                fontSize = 13.sp,
                                modifier = Modifier.padding(bottom = 12.dp),
                            )
                        }

                        when (personalStep) {
                            1 -> {
                                OnboardingStepHeader(
                                    title = "What's your name?",
                                    subtitle = "Tell us what to call you. This will be shown on your outgoing emails.",
                                )
                                OutlinedTextField(
                                    value = personalName,
                                    onValueChange = { personalName = it },
                                    label = { Text("Full Name (e.g. Alex Miller)") },
                                    modifier = Modifier.fillMaxWidth(),
                                    singleLine = true,
                                )
                                Spacer(Modifier.height(24.dp))
                                Button(
                                    onClick = { backStack.add(OnboardingTrack.Personal(if (auth.isAuthenticated) 4 else 2)) },
                                    enabled = personalName.isNotBlank(),
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = colors.ink,
                                        contentColor = colors.surface,
                                    ),
                                    shape = RoundedCornerShape(12.dp),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(48.dp),
                                ) {
                                    Text("Continue", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                }
                            }

                            2 -> {
                                OnboardingStepHeader(
                                    title = "Set your password",
                                    subtitle = "Choose a secure password (minimum 10 characters).",
                                )
                                OutlinedTextField(
                                    value = personalPassword,
                                    onValueChange = { personalPassword = it },
                                    label = { Text("Password (min 10 chars)") },
                                    visualTransformation = if (isPersonalPasswordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                                    trailingIcon = {
                                        IconButton(onClick = { isPersonalPasswordVisible = !isPersonalPasswordVisible }) {
                                            Icon(
                                                imageVector = if (isPersonalPasswordVisible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                                contentDescription = if (isPersonalPasswordVisible) "Hide password" else "Show password",
                                                tint = colors.muted,
                                            )
                                        }
                                    },
                                    modifier = Modifier.fillMaxWidth(),
                                    singleLine = true,
                                )
                                Spacer(Modifier.height(24.dp))
                                Button(
                                    onClick = { backStack.add(OnboardingTrack.Personal(3)) },
                                    enabled = personalPassword.length >= 10,
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = colors.ink,
                                        contentColor = colors.surface,
                                    ),
                                    shape = RoundedCornerShape(12.dp),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(48.dp),
                                ) {
                                    Text("Continue", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                }
                            }

                            3 -> {
                                OnboardingStepHeader(
                                    title = "Account backup email",
                                    subtitle = "Provide an existing email address to recover your account.",
                                )
                                OutlinedTextField(
                                    value = personalBackupEmail,
                                    onValueChange = { personalBackupEmail = it.trim() },
                                    label = { Text("e.g. alex@example.com") },
                                    modifier = Modifier.fillMaxWidth(),
                                    singleLine = true,
                                )
                                Spacer(Modifier.height(12.dp))
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(8.dp))
                                        .background(colors.accent.copy(alpha = 0.08f))
                                        .padding(12.dp),
                                    verticalAlignment = Alignment.Top,
                                ) {
                                    Icon(
                                        Icons.Outlined.Shield,
                                        contentDescription = null,
                                        tint = colors.accent,
                                        modifier = Modifier
                                            .size(16.dp)
                                            .padding(top = 2.dp),
                                    )
                                    Spacer(Modifier.width(8.dp))
                                    Text(
                                        "We'll use the provided email for account backup when needed.",
                                        fontFamily = InterFontFamily,
                                        fontSize = 13.sp,
                                        color = colors.ink,
                                    )
                                }
                                Spacer(Modifier.height(24.dp))
                                Button(
                                    onClick = { backStack.add(OnboardingTrack.Personal(4)) },
                                    enabled = personalBackupEmail.contains("@") && personalBackupEmail.contains("."),
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = colors.ink,
                                        contentColor = colors.surface,
                                    ),
                                    shape = RoundedCornerShape(12.dp),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(48.dp),
                                ) {
                                    Text("Continue", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                }
                            }

                            else -> {
                                OnboardingStepHeader(
                                    title = "Choose your email",
                                    subtitle = "Select your username on @$mailDomain.",
                                )
                                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                    OutlinedTextField(
                                        value = personalUsername,
                                        onValueChange = { personalUsername = it.substringBefore('@') },
                                        label = { Text("Username") },
                                        modifier = Modifier.weight(1f),
                                        singleLine = true,
                                    )
                                    Text(
                                        "@$mailDomain",
                                        fontFamily = InterFontFamily,
                                        color = colors.muted,
                                        modifier = Modifier.padding(start = 8.dp, top = 8.dp),
                                    )
                                }
                                Spacer(Modifier.height(24.dp))
                                Button(
                                    onClick = {
                                        scope.launch {
                                            isSubmitting = true
                                            errorMessage = null
                                            try {
                                                if (!auth.isAuthenticated) {
                                                    val res = ApiClient.shared.signupPersonal(
                                                        username = personalUsername.trim().lowercase(),
                                                        password = personalPassword,
                                                        displayName = personalName.ifBlank { null },
                                                        backupEmail = personalBackupEmail.ifBlank { null },
                                                    )
                                                    auth.applySession(res.token, res.mailbox.email)
                                                    app.bootstrap(res.token)
                                                    onDismiss?.invoke()
                                                } else {
                                                    val fullEmail = "$personalUsername@$mailDomain"
                                                    app.createMailbox(
                                                        personalName.ifBlank { personalUsername },
                                                        fullEmail,
                                                    )
                                                    onDismiss?.invoke()
                                                }
                                            } catch (e: Exception) {
                                                errorMessage = e.message ?: "Failed to create personal address"
                                            } finally {
                                                isSubmitting = false
                                            }
                                        }
                                    },
                                    enabled = personalUsername.isNotBlank() && !isSubmitting,
                                    colors = ButtonDefaults.buttonColors(
                                        containerColor = colors.ink,
                                        contentColor = colors.surface,
                                    ),
                                    shape = RoundedCornerShape(12.dp),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(48.dp),
                                ) {
                                    if (isSubmitting) {
                                        CircularProgressIndicator(
                                            color = colors.surface,
                                            modifier = Modifier.size(20.dp),
                                            strokeWidth = 2.dp,
                                        )
                                    } else {
                                        Text(
                                            if (auth.isAuthenticated) "Create Mailbox" else "Create Account",
                                            fontFamily = InterFontFamily,
                                            fontWeight = FontWeight.Medium,
                                            fontSize = 16.sp,
                                        )
                                    }
                                }
                            }
                        }
                    }
                    }
                }

                is OnboardingTrack.Domain -> {
                    val domainStep = step.step
                    Column(
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        // Subsequent step toolbar: left side back button (if step < 11)
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 20.dp)
                                .padding(top = 14.dp, bottom = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            if (domainStep < 11) {
                                Box(
                                    modifier = Modifier
                                        .size(42.dp)
                                        .liquidGlass(CircleShape)
                                        .clip(CircleShape)
                                        .clickable {
                                            view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
                                            navigateBack()
                                        },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(
                                        imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                                        contentDescription = "Back",
                                        tint = colors.ink,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            } else {
                                Spacer(Modifier.size(42.dp))
                            }

                            if (auth.isAuthenticated && onDismiss == null) {
                                TextButton(onClick = {
                                    app.reset()
                                    auth.signOut()
                                }) {
                                    Text("Sign out", color = colors.deepDarkRed, fontFamily = InterFontFamily)
                                }
                            } else {
                                Spacer(Modifier.size(42.dp))
                            }
                        }

                        Column(
                            modifier = Modifier
                                .fillMaxSize()
                                .verticalScroll(rememberScrollState())
                                .padding(24.dp),
                        ) {
                        errorMessage?.let { msg ->
                            Text(
                                msg,
                                color = colors.deepDarkRed,
                                fontFamily = InterFontFamily,
                                fontSize = 13.sp,
                                modifier = Modifier.padding(bottom = 12.dp),
                            )
                        }

                        statusMessage?.let { msg ->
                            Text(
                                msg,
                                color = colors.accent,
                                fontFamily = InterFontFamily,
                                fontSize = 13.sp,
                                modifier = Modifier.padding(bottom = 12.dp),
                            )
                        }

                        if (isPaymentSyncing) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(vertical = 16.dp),
                            ) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    color = colors.accent,
                                    strokeWidth = 2.dp,
                                )
                                Spacer(Modifier.width(12.dp))
                                Text(
                                    "Syncing domain payment and configuring DNS...",
                                    fontFamily = InterFontFamily,
                                    fontSize = 14.sp,
                                    color = colors.ink,
                                )
                            }
                        } else {
                            when (domainStep) {
                                1 -> {
                                    OnboardingStepHeader(
                                        title = "Admin Name",
                                        subtitle = "Provide your full name for administrator communications.",
                                    )
                                    OutlinedTextField(
                                        value = customName,
                                        onValueChange = { customName = it },
                                        label = { Text("Full Name (e.g. Alex Miller)") },
                                        modifier = Modifier.fillMaxWidth(),
                                        singleLine = true,
                                    )
                                    Spacer(Modifier.height(24.dp))
                                    Button(
                                        onClick = { backStack.add(OnboardingTrack.Domain(2)) },
                                        enabled = customName.isNotBlank(),
                                        colors = ButtonDefaults.buttonColors(containerColor = colors.ink, contentColor = colors.surface),
                                        shape = RoundedCornerShape(12.dp),
                                        modifier = Modifier.fillMaxWidth().height(48.dp),
                                    ) {
                                        Text("Continue", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                    }
                                }

                                2 -> {
                                    OnboardingStepHeader(
                                        title = "Set Admin Password",
                                        subtitle = "Choose a secure password (minimum 10 characters).",
                                    )
                                    OutlinedTextField(
                                        value = customPassword,
                                        onValueChange = { customPassword = it },
                                        label = { Text("Password (min 10 chars)") },
                                        visualTransformation = if (isCustomPasswordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                                        trailingIcon = {
                                            IconButton(onClick = { isCustomPasswordVisible = !isCustomPasswordVisible }) {
                                                Icon(
                                                    imageVector = if (isCustomPasswordVisible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                                    contentDescription = if (isCustomPasswordVisible) "Hide password" else "Show password",
                                                    tint = colors.muted,
                                                )
                                            }
                                        },
                                        modifier = Modifier.fillMaxWidth(),
                                        singleLine = true,
                                    )
                                    Spacer(Modifier.height(24.dp))
                                    Button(
                                        onClick = { backStack.add(OnboardingTrack.Domain(3)) },
                                        enabled = customPassword.length >= 10,
                                        colors = ButtonDefaults.buttonColors(containerColor = colors.ink, contentColor = colors.surface),
                                        shape = RoundedCornerShape(12.dp),
                                        modifier = Modifier.fillMaxWidth().height(48.dp),
                                    ) {
                                        Text("Continue", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                    }
                                }

                                3 -> {
                                    OnboardingStepHeader(
                                        title = "Account Backup Email",
                                        subtitle = "Provide an existing email address for account recovery.",
                                    )
                                    OutlinedTextField(
                                        value = customBackupEmail,
                                        onValueChange = { customBackupEmail = it.trim() },
                                        label = { Text("e.g. alex@example.com") },
                                        modifier = Modifier.fillMaxWidth(),
                                        singleLine = true,
                                    )
                                    Spacer(Modifier.height(12.dp))
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(8.dp))
                                            .background(colors.accent.copy(alpha = 0.08f))
                                            .padding(12.dp),
                                        verticalAlignment = Alignment.Top,
                                    ) {
                                        Icon(
                                            Icons.Outlined.Shield,
                                            contentDescription = null,
                                            tint = colors.accent,
                                            modifier = Modifier.size(16.dp).padding(top = 2.dp),
                                        )
                                        Spacer(Modifier.width(8.dp))
                                        Text(
                                            "We'll use the provided email for account backup when needed.",
                                            fontFamily = InterFontFamily,
                                            fontSize = 13.sp,
                                            color = colors.ink,
                                        )
                                    }
                                    Spacer(Modifier.height(24.dp))
                                    Button(
                                        onClick = { backStack.add(OnboardingTrack.Domain(4)) },
                                        enabled = customBackupEmail.contains("@") && customBackupEmail.contains("."),
                                        colors = ButtonDefaults.buttonColors(containerColor = colors.ink, contentColor = colors.surface),
                                        shape = RoundedCornerShape(12.dp),
                                        modifier = Modifier.fillMaxWidth().height(48.dp),
                                    ) {
                                        Text("Continue", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                    }
                                }

                                4 -> {
                                    OnboardingStepHeader(
                                        title = "Custom Domain",
                                        subtitle = "Choose a domain to register or connect one you already own.",
                                    )
                                    OutlinedTextField(
                                        value = customDomain,
                                        onValueChange = { customDomain = it.trim() },
                                        label = { Text("Domain (e.g. acme.corp)") },
                                        modifier = Modifier.fillMaxWidth(),
                                        singleLine = true,
                                    )
                                    if (isCheckingDomain) {
                                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                                            CircularProgressIndicator(modifier = Modifier.size(14.dp), color = colors.accent, strokeWidth = 1.5.dp)
                                            Spacer(Modifier.width(8.dp))
                                            Text("Checking domain availability...", fontFamily = InterFontFamily, fontSize = 12.sp, color = colors.muted)
                                        }
                                    } else if (availability != null) {
                                        val avail = availability!!
                                        if (avail.alreadyInInboxies == true) {
                                            Text(
                                                "This domain is already registered on Inboxies. Please sign in or use another domain.",
                                                fontFamily = InterFontFamily,
                                                fontSize = 12.sp,
                                                color = colors.deepDarkRed,
                                                modifier = Modifier.padding(top = 6.dp),
                                            )
                                        } else if (avail.available) {
                                            Column(modifier = Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                                Row(verticalAlignment = Alignment.CenterVertically) {
                                                    Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = Color(0xFF16A34A), modifier = Modifier.size(16.dp))
                                                    Spacer(Modifier.width(6.dp))
                                                    Text(
                                                        "Available for $${String.format(java.util.Locale.US, "%.2f", avail.retailPriceUsd)}/yr",
                                                        fontFamily = InterFontFamily,
                                                        fontWeight = FontWeight.SemiBold,
                                                        fontSize = 13.sp,
                                                        color = Color(0xFF16A34A),
                                                    )
                                                }
                                                Row(
                                                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(colors.pillFill).padding(3.dp),
                                                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                                                ) {
                                                    Box(
                                                        modifier = Modifier.weight(1f).clip(RoundedCornerShape(6.dp))
                                                            .background(if (domainAction == "purchase") colors.surface else Color.Transparent)
                                                            .clickable { domainAction = "purchase" }.padding(vertical = 8.dp),
                                                        contentAlignment = Alignment.Center,
                                                    ) {
                                                        val total = availability?.pricing?.totalAnnualUsd ?: avail.retailPriceUsd
                                                        Text(
                                                            "Register ($${String.format(java.util.Locale.US, "%.0f", total)}/yr)",
                                                            fontFamily = InterFontFamily,
                                                            fontWeight = if (domainAction == "purchase") FontWeight.SemiBold else FontWeight.Normal,
                                                            fontSize = 12.sp,
                                                            color = if (domainAction == "purchase") colors.ink else colors.muted,
                                                        )
                                                    }
                                                    Box(
                                                        modifier = Modifier.weight(1f).clip(RoundedCornerShape(6.dp))
                                                            .background(if (domainAction == "connect") colors.surface else Color.Transparent)
                                                            .clickable { domainAction = "connect" }.padding(vertical = 8.dp),
                                                        contentAlignment = Alignment.Center,
                                                    ) {
                                                        Text(
                                                            "I already own it",
                                                            fontFamily = InterFontFamily,
                                                            fontWeight = if (domainAction == "connect") FontWeight.SemiBold else FontWeight.Normal,
                                                            fontSize = 12.sp,
                                                            color = if (domainAction == "connect") colors.ink else colors.muted,
                                                        )
                                                    }
                                                }
                                            }
                                        } else {
                                            Text(
                                                "Domain is registered elsewhere. You can connect it by pointing its nameservers to Cloudflare.",
                                                fontFamily = InterFontFamily,
                                                fontSize = 12.sp,
                                                color = colors.muted,
                                                modifier = Modifier.padding(top = 6.dp),
                                            )
                                        }
                                    }
                                    Spacer(Modifier.height(24.dp))
                                    Button(
                                        onClick = { backStack.add(OnboardingTrack.Domain(5)) },
                                        enabled = customDomain.isNotBlank() && !isCheckingDomain && availability?.alreadyInInboxies != true,
                                        colors = ButtonDefaults.buttonColors(containerColor = colors.ink, contentColor = colors.surface),
                                        shape = RoundedCornerShape(12.dp),
                                        modifier = Modifier.fillMaxWidth().height(48.dp),
                                    ) {
                                        Text("Continue", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                    }
                                }

                                5 -> {
                                    if (domainAction == "purchase" && (availability?.available == true)) {
                                        val total = availability?.pricing?.totalAnnualUsd ?: availability?.retailPriceUsd ?: 20.0
                                        val domainCost = availability?.pricing?.domainWholesaleUsd ?: 10.46
                                        val platformCost = availability?.pricing?.platformFeeUsd ?: (total - domainCost)
                                        OnboardingStepHeader(
                                            title = "Subscription & Fee Breakdown",
                                            subtitle = "Transparent annual subscription. Cloudflare registrar + full Inboxies platform & AI suite.",
                                        )
                                        Column(
                                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surface)
                                                .border(BorderStroke(0.5.dp, colors.line.copy(alpha = 0.65f)), RoundedCornerShape(12.dp)).padding(16.dp),
                                            verticalArrangement = Arrangement.spacedBy(10.dp),
                                        ) {
                                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                                Column(modifier = Modifier.weight(1f)) {
                                                    Text("1. Domain Registration ($customDomain)", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 14.sp, color = colors.ink)
                                                    Text("Wholesale pass-through via Cloudflare Registrar", fontFamily = InterFontFamily, fontSize = 11.sp, color = colors.muted)
                                                }
                                                Text("$${String.format(java.util.Locale.US, "%.2f", domainCost)}/yr", fontFamily = InterFontFamily, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = colors.ink)
                                            }
                                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                                Column(modifier = Modifier.weight(1f)) {
                                                    Text("2. Platform, AI & Infrastructure", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 14.sp, color = colors.ink)
                                                    Text("Workers AI agent, edge sync, R2 storage & DNS", fontFamily = InterFontFamily, fontSize = 11.sp, color = colors.muted)
                                                }
                                                Text("$${String.format(java.util.Locale.US, "%.2f", platformCost)}/yr", fontFamily = InterFontFamily, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = colors.ink)
                                            }
                                            HorizontalDivider(thickness = 0.5.dp, color = colors.line.copy(alpha = 0.65f))
                                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                                Text("ICANN & Registry Fees", fontFamily = InterFontFamily, fontSize = 13.sp, color = colors.muted)
                                                Text("Included", fontFamily = InterFontFamily, fontSize = 12.sp, color = Color(0xFF16A34A))
                                            }
                                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                                Text("WHOIS Privacy Protection", fontFamily = InterFontFamily, fontSize = 13.sp, color = colors.muted)
                                                Text("Free", fontFamily = InterFontFamily, fontSize = 12.sp, color = Color(0xFF16A34A))
                                            }
                                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                                Text("Auto MX/SPF/DKIM/DMARC", fontFamily = InterFontFamily, fontSize = 13.sp, color = colors.muted)
                                                Text("Automatic", fontFamily = InterFontFamily, fontSize = 12.sp, color = Color(0xFF16A34A))
                                            }
                                            HorizontalDivider(thickness = 0.5.dp, color = colors.line.copy(alpha = 0.65f))
                                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                                Column {
                                                    Text("Total Annual Subscription", fontFamily = InterFontFamily, fontWeight = FontWeight.Bold, fontSize = 15.sp, color = colors.ink)
                                                    Text("Billed annually • Cancel anytime", fontFamily = InterFontFamily, fontSize = 11.sp, color = colors.muted)
                                                }
                                                Text("$${String.format(java.util.Locale.US, "%.2f", total)}/yr", fontFamily = InterFontFamily, fontWeight = FontWeight.Bold, fontSize = 15.sp, color = colors.accent)
                                            }
                                        }
                                        if (isPaymentSyncing) {
                                            Row(
                                                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.pillFill).padding(16.dp),
                                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                                                verticalAlignment = Alignment.CenterVertically,
                                            ) {
                                                CircularProgressIndicator(color = colors.accent, modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                                                Text("Completing payment in browser...", fontFamily = InterFontFamily, fontSize = 14.sp, color = colors.ink)
                                            }
                                        } else {
                                            Button(
                                                onClick = {
                                                    scope.launch {
                                                        isSubmitting = true
                                                        errorMessage = null
                                                        try {
                                                            val domain = customDomain.trim().lowercase()
                                                            val username = customUsername.ifBlank { "admin" }.trim().lowercase()
                                                            val returnUrl = "inboxies://onboarding/domain-ready"
                                                            val res = ApiClient.shared.createDomainCheckout(
                                                                domain = domain,
                                                                username = username,
                                                                password = customPassword,
                                                                displayName = customName.ifBlank { null },
                                                                returnUrl = returnUrl,
                                                                client = "android",
                                                            )
                                                            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(res.checkoutUrl))
                                                            context.startActivity(intent)
                                                            isPaymentSyncing = true
                                                        } catch (e: Exception) {
                                                            errorMessage = e.message ?: "Failed to initiate payment"
                                                        } finally {
                                                            isSubmitting = false
                                                        }
                                                    }
                                                },
                                                enabled = !isSubmitting,
                                                colors = ButtonDefaults.buttonColors(containerColor = colors.ink, contentColor = colors.surface),
                                                shape = RoundedCornerShape(12.dp),
                                                modifier = Modifier.fillMaxWidth().height(48.dp),
                                            ) {
                                                if (isSubmitting) {
                                                    CircularProgressIndicator(color = colors.surface, modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                                                } else {
                                                    Text("Subscribe & Register ($${String.format(java.util.Locale.US, "%.2f", total)}/yr)", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                                }
                                            }
                                        }
                                    } else {
                                        OnboardingStepHeader(
                                            title = "Update Nameservers",
                                            subtitle = "Point your domain to Cloudflare to activate automatic routing.",
                                        )
                                        Column(
                                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surface)
                                                .border(BorderStroke(0.5.dp, colors.line.copy(alpha = 0.65f)), RoundedCornerShape(12.dp)).padding(16.dp),
                                            verticalArrangement = Arrangement.spacedBy(10.dp),
                                        ) {
                                            Text("Update Nameservers at Registrar", fontFamily = InterFontFamily, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = colors.ink)
                                            Text("Point your domain's nameservers at your registrar (GoDaddy, Namecheap, etc.) to Cloudflare:", fontFamily = InterFontFamily, fontSize = 13.sp, color = colors.muted)
                                            HorizontalDivider(thickness = 0.5.dp, color = colors.line.copy(alpha = 0.65f))
                                            activeNameservers.forEach { ns ->
                                                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                                    Text(ns, fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = colors.ink, modifier = Modifier.weight(1f))
                                                    IconButton(
                                                        onClick = {
                                                            clipboard.setText(AnnotatedString(ns))
                                                            statusMessage = "Copied $ns"
                                                        },
                                                        modifier = Modifier.size(28.dp),
                                                    ) {
                                                        Icon(Icons.Outlined.ContentCopy, contentDescription = "Copy Nameserver", tint = colors.accent, modifier = Modifier.size(16.dp))
                                                    }
                                                }
                                            }
                                        }
                                        Spacer(Modifier.height(24.dp))
                                        Button(
                                            onClick = {
                                                isWatchingDns = true
                                                scope.launch {
                                                    val domain = customDomain.trim().lowercase()
                                                    repeat(10) {
                                                        delay(5000)
                                                        try { ApiClient.shared.fixDomainEmailDns(domain) } catch (_: Exception) {}
                                                    }
                                                }
                                                backStack.add(OnboardingTrack.Domain(6))
                                            },
                                            colors = ButtonDefaults.buttonColors(containerColor = colors.ink, contentColor = colors.surface),
                                            shape = RoundedCornerShape(12.dp),
                                            modifier = Modifier.fillMaxWidth().height(48.dp),
                                        ) {
                                            Text("I've Updated My Nameservers", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                        }
                                    }
                                }

                                6 -> {
                                    OnboardingStepHeader(
                                        title = "Admin Mailbox",
                                        subtitle = "Pick your primary admin username for @$customDomain.",
                                    )
                                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                        OutlinedTextField(
                                            value = customUsername,
                                            onValueChange = { customUsername = it.substringBefore('@') },
                                            label = { Text("Username (e.g. alex)") },
                                            modifier = Modifier.weight(1f),
                                            singleLine = true,
                                        )
                                        Text("@$customDomain", fontFamily = InterFontFamily, color = colors.muted, modifier = Modifier.padding(start = 8.dp, top = 8.dp))
                                    }
                                    Spacer(Modifier.height(24.dp))
                                    Button(
                                        onClick = {
                                            scope.launch {
                                                isSubmitting = true
                                                errorMessage = null
                                                try {
                                                    val res = ApiClient.shared.signupDomain(
                                                        domain = customDomain.trim().lowercase(),
                                                        username = customUsername.trim().lowercase(),
                                                        password = customPassword,
                                                        displayName = customName.ifBlank { null },
                                                        backupEmail = customBackupEmail.ifBlank { null },
                                                    )
                                                    auth.applySession(res.token, res.mailbox.email)
                                                    app.bootstrap(res.token)
                                                    if (res.domain.nameservers.isNotEmpty()) {
                                                        activeNameservers = res.domain.nameservers
                                                    }
                                                    backStack.add(OnboardingTrack.Domain(7))
                                                } catch (e: Exception) {
                                                    errorMessage = e.message ?: "Failed to provision mailbox"
                                                } finally {
                                                    isSubmitting = false
                                                }
                                            }
                                        },
                                        enabled = customUsername.isNotBlank() && !isSubmitting,
                                        colors = ButtonDefaults.buttonColors(containerColor = colors.ink, contentColor = colors.surface),
                                        shape = RoundedCornerShape(12.dp),
                                        modifier = Modifier.fillMaxWidth().height(48.dp),
                                    ) {
                                        if (isSubmitting) {
                                            CircularProgressIndicator(color = colors.surface, modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                                        } else {
                                            Text("Continue", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                        }
                                    }
                                }

                                7 -> {
                                    OnboardingStepHeader(
                                        title = "Add Team Users",
                                        subtitle = "Create mailboxes for your team members (optional).",
                                    )
                                    OutlinedTextField(
                                        value = newUserName,
                                        onValueChange = { newUserName = it },
                                        label = { Text("Full Name") },
                                        modifier = Modifier.fillMaxWidth(),
                                        singleLine = true,
                                    )
                                    Spacer(Modifier.height(8.dp))
                                    OutlinedTextField(
                                        value = newUserEmail,
                                        onValueChange = { newUserEmail = it.trim() },
                                        label = { Text("Contact / Backup Email") },
                                        modifier = Modifier.fillMaxWidth(),
                                        singleLine = true,
                                    )
                                    Spacer(Modifier.height(8.dp))
                                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                        OutlinedTextField(
                                            value = newUserUsername,
                                            onValueChange = { newUserUsername = it.substringBefore('@').trim() },
                                            label = { Text("Username") },
                                            modifier = Modifier.weight(1f),
                                            singleLine = true,
                                        )
                                        Text("@$customDomain", fontFamily = InterFontFamily, color = colors.muted, modifier = Modifier.padding(start = 8.dp, top = 8.dp))
                                    }
                                    Spacer(Modifier.height(12.dp))
                                    Button(
                                        onClick = {
                                            if (newUserUsername.isNotBlank()) {
                                                teamUsers.add(OnboardingUserItem(name = newUserName.trim(), email = newUserEmail.trim(), username = newUserUsername.trim().lowercase()))
                                                newUserName = ""
                                                newUserEmail = ""
                                                newUserUsername = ""
                                            }
                                        },
                                        enabled = newUserUsername.isNotBlank(),
                                        colors = ButtonDefaults.buttonColors(containerColor = colors.accent.copy(alpha = 0.12f), contentColor = colors.accent),
                                        shape = RoundedCornerShape(8.dp),
                                    ) {
                                        Icon(Icons.Outlined.PersonAdd, contentDescription = null, modifier = Modifier.size(16.dp))
                                        Spacer(Modifier.width(6.dp))
                                        Text("Add User", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 14.sp)
                                    }

                                    if (teamUsers.isNotEmpty()) {
                                        Spacer(Modifier.height(16.dp))
                                        Text("Configured Users (${teamUsers.size})", fontFamily = InterFontFamily, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = colors.ink)
                                        Spacer(Modifier.height(8.dp))
                                        teamUsers.forEach { user ->
                                            Row(
                                                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                                verticalAlignment = Alignment.CenterVertically,
                                                horizontalArrangement = Arrangement.SpaceBetween,
                                            ) {
                                                Column {
                                                    Text("${user.username}@$customDomain", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 14.sp, color = colors.ink)
                                                    if (user.name.isNotBlank()) {
                                                        Text(user.name, fontFamily = InterFontFamily, fontSize = 12.sp, color = colors.muted)
                                                    }
                                                }
                                                IconButton(onClick = { teamUsers.remove(user) }) {
                                                    Icon(Icons.Outlined.Delete, contentDescription = "Delete", tint = colors.deepDarkRed, modifier = Modifier.size(16.dp))
                                                }
                                            }
                                        }
                                    }

                                    Spacer(Modifier.height(24.dp))
                                    Button(
                                        onClick = {
                                            scope.launch {
                                                if (teamUsers.isNotEmpty()) {
                                                    try {
                                                        val domain = customDomain.trim().lowercase()
                                                        val payload = teamUsers.map { mapOf("name" to it.name, "email" to it.email, "username" to it.username) }
                                                        ApiClient.shared.setupDomainUsers(domain, payload)
                                                    } catch (_: Exception) {}
                                                }
                                                backStack.add(OnboardingTrack.Domain(8))
                                            }
                                        },
                                        colors = ButtonDefaults.buttonColors(containerColor = colors.ink, contentColor = colors.surface),
                                        shape = RoundedCornerShape(12.dp),
                                        modifier = Modifier.fillMaxWidth().height(48.dp),
                                    ) {
                                        Text("Continue", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                    }
                                    Spacer(Modifier.height(8.dp))
                                    TextButton(onClick = { backStack.add(OnboardingTrack.Domain(8)) }, modifier = Modifier.fillMaxWidth()) {
                                        Text("Skip", fontFamily = InterFontFamily, fontSize = 14.sp, color = colors.muted)
                                    }
                                }

                                8 -> {
                                    OnboardingStepHeader(
                                        title = "Add Email Aliases",
                                        subtitle = "Create aliases that forward directly to your mailboxes.",
                                    )

                                    Row(
                                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    ) {
                                        listOf("support", "hello", "sales", "billing", "info").forEach { preset ->
                                            Box(
                                                modifier = Modifier.clip(RoundedCornerShape(16.dp)).background(colors.accent.copy(alpha = 0.1f))
                                                    .clickable { newAliasUsername = preset }.padding(horizontal = 12.dp, vertical = 6.dp),
                                            ) {
                                                Text("$preset@", fontFamily = InterFontFamily, fontSize = 13.sp, color = colors.accent, fontWeight = FontWeight.Medium)
                                            }
                                        }
                                    }

                                    Spacer(Modifier.height(16.dp))
                                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                        OutlinedTextField(
                                            value = newAliasUsername,
                                            onValueChange = { newAliasUsername = it.substringBefore('@').trim() },
                                            label = { Text("Alias (e.g. support)") },
                                            modifier = Modifier.weight(1f),
                                            singleLine = true,
                                        )
                                        Text("@$customDomain", fontFamily = InterFontFamily, color = colors.muted, modifier = Modifier.padding(start = 8.dp, top = 8.dp))
                                    }
                                    Spacer(Modifier.height(8.dp))
                                    OutlinedTextField(
                                        value = newAliasTarget,
                                        onValueChange = { newAliasTarget = it.trim() },
                                        label = { Text("Forwards to (defaults to your inbox)") },
                                        modifier = Modifier.fillMaxWidth(),
                                        singleLine = true,
                                    )
                                    Spacer(Modifier.height(12.dp))
                                    Button(
                                        onClick = {
                                            if (newAliasUsername.isNotBlank()) {
                                                val target = newAliasTarget.ifBlank { "$customUsername@$customDomain" }
                                                domainAliases.add(OnboardingAliasItem(alias = newAliasUsername.trim().lowercase(), target = target))
                                                newAliasUsername = ""
                                                newAliasTarget = ""
                                            }
                                        },
                                        enabled = newAliasUsername.isNotBlank(),
                                        colors = ButtonDefaults.buttonColors(containerColor = colors.accent.copy(alpha = 0.12f), contentColor = colors.accent),
                                        shape = RoundedCornerShape(8.dp),
                                    ) {
                                        Icon(Icons.AutoMirrored.Outlined.ArrowForward, contentDescription = null, modifier = Modifier.size(16.dp))
                                        Spacer(Modifier.width(6.dp))
                                        Text("Add Alias", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 14.sp)
                                    }

                                    if (domainAliases.isNotEmpty()) {
                                        Spacer(Modifier.height(16.dp))
                                        Text("Configured Aliases (${domainAliases.size})", fontFamily = InterFontFamily, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, color = colors.ink)
                                        Spacer(Modifier.height(8.dp))
                                        domainAliases.forEach { item ->
                                            Row(
                                                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                                verticalAlignment = Alignment.CenterVertically,
                                                horizontalArrangement = Arrangement.SpaceBetween,
                                            ) {
                                                Column {
                                                    Text("${item.alias}@$customDomain", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 14.sp, color = colors.ink)
                                                    Text("→ ${item.target}", fontFamily = InterFontFamily, fontSize = 12.sp, color = colors.muted)
                                                }
                                                IconButton(onClick = { domainAliases.remove(item) }) {
                                                    Icon(Icons.Outlined.Delete, contentDescription = "Delete", tint = colors.deepDarkRed, modifier = Modifier.size(16.dp))
                                                }
                                            }
                                        }
                                    }

                                    Spacer(Modifier.height(24.dp))
                                    Button(
                                        onClick = {
                                            scope.launch {
                                                if (domainAliases.isNotEmpty()) {
                                                    try {
                                                        val domain = customDomain.trim().lowercase()
                                                        val payload = domainAliases.map { mapOf("alias" to it.alias, "target" to it.target) }
                                                        ApiClient.shared.setupDomainAliases(domain, payload)
                                                    } catch (_: Exception) {}
                                                }
                                                backStack.add(OnboardingTrack.Domain(9))
                                            }
                                        },
                                        colors = ButtonDefaults.buttonColors(containerColor = colors.ink, contentColor = colors.surface),
                                        shape = RoundedCornerShape(12.dp),
                                        modifier = Modifier.fillMaxWidth().height(48.dp),
                                    ) {
                                        Text("Continue", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                    }
                                    Spacer(Modifier.height(8.dp))
                                    TextButton(onClick = { backStack.add(OnboardingTrack.Domain(9)) }, modifier = Modifier.fillMaxWidth()) {
                                        Text("Skip", fontFamily = InterFontFamily, fontSize = 14.sp, color = colors.muted)
                                    }
                                }

                                9 -> {
                                    OnboardingStepHeader(
                                        title = "Setup Status",
                                        subtitle = "Review the state of your automated Cloudflare domain setup.",
                                    )

                                    Column(
                                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surface)
                                            .border(BorderStroke(0.5.dp, colors.line.copy(alpha = 0.65f)), RoundedCornerShape(12.dp)).padding(16.dp),
                                        verticalArrangement = Arrangement.spacedBy(12.dp),
                                    ) {
                                        SetupStatusRow("Custom Domain Provisioned", customDomain)
                                        SetupStatusRow("Cloudflare Nameservers", activeNameservers.joinToString(", "))
                                        SetupStatusRow("Email Routing & Catch-All Worker", "Automatic worker routing enabled")
                                        SetupStatusRow("DNS (MX, SPF, DMARC)", "Injected and protected")
                                        SetupStatusRow("Primary Mailbox", "$customUsername@$customDomain")
                                        SetupStatusRow("Team Users", "${teamUsers.size} users added")
                                        SetupStatusRow("Email Aliases", "${domainAliases.size} aliases configured")
                                    }

                                    Spacer(Modifier.height(12.dp))
                                    Row(
                                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(colors.accent.copy(alpha = 0.08f)).padding(12.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Icon(Icons.Outlined.AutoAwesome, contentDescription = null, tint = colors.accent, modifier = Modifier.size(16.dp))
                                        Spacer(Modifier.width(8.dp))
                                        Text("Configured automatically via Cloudflare Email Routing & Workers.", fontFamily = InterFontFamily, fontSize = 12.sp, color = colors.muted)
                                    }

                                    Spacer(Modifier.height(24.dp))
                                    Button(
                                        onClick = { backStack.add(OnboardingTrack.Domain(10)) },
                                        colors = ButtonDefaults.buttonColors(containerColor = colors.ink, contentColor = colors.surface),
                                        shape = RoundedCornerShape(12.dp),
                                        modifier = Modifier.fillMaxWidth().height(48.dp),
                                    ) {
                                        Text("Review DNS Records", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                    }
                                }

                                10 -> {
                                    OnboardingStepHeader(
                                        title = "DNS Records Review",
                                        subtitle = "These records have been configured automatically for $customDomain. For users moving existing nameservers, confirm or set these at your provider:",
                                    )

                                    Column(
                                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surface)
                                            .border(BorderStroke(0.5.dp, colors.line.copy(alpha = 0.65f)), RoundedCornerShape(12.dp)).padding(16.dp),
                                        verticalArrangement = Arrangement.spacedBy(8.dp),
                                    ) {
                                        DnsRecordRow("MX", "@", "route1.mx.cloudflare.net (Pri 10)") {
                                            clipboard.setText(AnnotatedString("route1.mx.cloudflare.net"))
                                            statusMessage = "Copied MX route 1"
                                        }
                                        DnsRecordRow("MX", "@", "route2.mx.cloudflare.net (Pri 20)") {
                                            clipboard.setText(AnnotatedString("route2.mx.cloudflare.net"))
                                            statusMessage = "Copied MX route 2"
                                        }
                                        DnsRecordRow("MX", "@", "route3.mx.cloudflare.net (Pri 30)") {
                                            clipboard.setText(AnnotatedString("route3.mx.cloudflare.net"))
                                            statusMessage = "Copied MX route 3"
                                        }
                                        DnsRecordRow("TXT", "@", "v=spf1 include:_spf.mx.cloudflare.net ~all") {
                                            clipboard.setText(AnnotatedString("v=spf1 include:_spf.mx.cloudflare.net ~all"))
                                            statusMessage = "Copied SPF record"
                                        }
                                        DnsRecordRow("TXT", "_dmarc", "v=DMARC1; p=none; sp=none;") {
                                            clipboard.setText(AnnotatedString("v=DMARC1; p=none; sp=none;"))
                                            statusMessage = "Copied DMARC record"
                                        }
                                    }

                                    Spacer(Modifier.height(24.dp))
                                    Button(
                                        onClick = { backStack.add(OnboardingTrack.Domain(11)) },
                                        colors = ButtonDefaults.buttonColors(containerColor = colors.ink, contentColor = colors.surface),
                                        shape = RoundedCornerShape(12.dp),
                                        modifier = Modifier.fillMaxWidth().height(48.dp),
                                    ) {
                                        Text("Continue", fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 16.sp)
                                    }
                                    Spacer(Modifier.height(8.dp))
                                    TextButton(onClick = { backStack.add(OnboardingTrack.Domain(11)) }, modifier = Modifier.fillMaxWidth()) {
                                        Text("Skip", fontFamily = InterFontFamily, fontSize = 14.sp, color = colors.muted)
                                    }
                                }

                                else -> {
                                    Column(
                                        modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
                                        horizontalAlignment = Alignment.CenterHorizontally,
                                        verticalArrangement = Arrangement.spacedBy(16.dp),
                                    ) {
                                        Icon(
                                            Icons.Outlined.CheckCircle,
                                            contentDescription = null,
                                            tint = Color(0xFF16A34A),
                                            modifier = Modifier.size(54.dp),
                                        )
                                        Text(
                                            "Welcome to Inboxies!",
                                            fontFamily = InterFontFamily,
                                            fontWeight = FontWeight.Bold,
                                            fontSize = 28.sp,
                                            color = colors.ink,
                                        )
                                        Text(
                                            "Your domain $customDomain is configured with Cloudflare Email Routing. You can now send and receive email at:",
                                            fontFamily = InterFontFamily,
                                            fontSize = 16.sp,
                                            color = colors.muted,
                                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                                        )
                                        Box(
                                            modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(colors.accent.copy(alpha = 0.1f)).padding(horizontal = 16.dp, vertical = 8.dp),
                                        ) {
                                            Text(
                                                "$customUsername@$customDomain",
                                                fontFamily = FontFamily.Monospace,
                                                fontWeight = FontWeight.Bold,
                                                fontSize = 18.sp,
                                                color = colors.accent,
                                            )
                                        }

                                        Row(
                                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                                            horizontalArrangement = Arrangement.SpaceEvenly,
                                        ) {
                                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                                Text("${1 + teamUsers.size}", fontFamily = InterFontFamily, fontWeight = FontWeight.Bold, fontSize = 20.sp, color = colors.ink)
                                                Text("Mailboxes", fontFamily = InterFontFamily, fontSize = 12.sp, color = colors.muted)
                                            }
                                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                                Text("${domainAliases.size}", fontFamily = InterFontFamily, fontWeight = FontWeight.Bold, fontSize = 20.sp, color = colors.ink)
                                                Text("Aliases", fontFamily = InterFontFamily, fontSize = 12.sp, color = colors.muted)
                                            }
                                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                                Icon(Icons.Outlined.Shield, contentDescription = null, tint = Color(0xFF16A34A), modifier = Modifier.size(20.dp))
                                                Text("Protected", fontFamily = InterFontFamily, fontSize = 12.sp, color = colors.muted)
                                            }
                                        }

                                        Spacer(Modifier.height(16.dp))
                                        Button(
                                            onClick = {
                                                scope.launch {
                                                    app.refreshMailboxes(showLoading = true)
                                                    onDismiss?.invoke()
                                                }
                                            },
                                            colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = Color.White),
                                            shape = RoundedCornerShape(12.dp),
                                            modifier = Modifier.fillMaxWidth().height(48.dp),
                                        ) {
                                            Text("Open Inbox", fontFamily = InterFontFamily, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    }
                }

                is OnboardingTrack.DnsWizard -> {
                    Column(
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        // Subsequent step toolbar: left side back button only
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 20.dp)
                                .padding(top = 14.dp, bottom = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(42.dp)
                                    .liquidGlass(CircleShape)
                                    .clip(CircleShape)
                                    .clickable {
                                        view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
                                        navigateBack()
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Outlined.ArrowBack,
                                    contentDescription = "Back",
                                    tint = colors.ink,
                                    modifier = Modifier.size(18.dp),
                                )
                            }

                            if (auth.isAuthenticated && onDismiss == null) {
                                TextButton(onClick = {
                                    app.reset()
                                    auth.signOut()
                                }) {
                                    Text("Sign out", color = colors.deepDarkRed, fontFamily = InterFontFamily)
                                }
                            } else {
                                Spacer(Modifier.size(42.dp))
                            }
                        }

                        Column(
                            modifier = Modifier
                                .fillMaxSize()
                                .verticalScroll(rememberScrollState())
                                .padding(24.dp),
                        ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = Color(0xFF16A34A), modifier = Modifier.size(24.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("Domain Registered!", fontFamily = InterFontFamily, fontWeight = FontWeight.Bold, fontSize = 20.sp, color = Color(0xFF16A34A))
                        }
                        Text("Cloudflare Email Routing is ready for ${step.domain}.", fontFamily = InterFontFamily, fontSize = 14.sp, color = colors.muted, modifier = Modifier.padding(top = 4.dp, bottom = 20.dp))

                        Column(
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surface)
                                .border(BorderStroke(0.5.dp, colors.line.copy(alpha = 0.65f)), RoundedCornerShape(12.dp)).padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Text("Nameservers", fontFamily = InterFontFamily, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = colors.ink)
                            HorizontalDivider(thickness = 0.5.dp, color = colors.line.copy(alpha = 0.65f))
                            step.nameservers.forEach { ns ->
                                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                    Text(ns, fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = colors.ink, modifier = Modifier.weight(1f))
                                    IconButton(
                                        onClick = {
                                            clipboard.setText(AnnotatedString(ns))
                                            statusMessage = "Copied $ns"
                                        },
                                        modifier = Modifier.size(28.dp),
                                    ) {
                                        Icon(Icons.Outlined.ContentCopy, contentDescription = "Copy Nameserver", tint = colors.accent, modifier = Modifier.size(16.dp))
                                    }
                                }
                            }
                        }

                        Spacer(Modifier.height(24.dp))
                        Button(
                            onClick = {
                                scope.launch {
                                    app.refreshMailboxes(showLoading = true)
                                    onDismiss?.invoke()
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = Color.White),
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth().height(48.dp),
                        ) {
                            Text("Go to Inbox", fontFamily = InterFontFamily, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                        }
                    }
                    }
                }
            }
        }
    }
}

// MARK: - Reusable UI Components

@Composable
private fun OnboardingStepHeader(
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
) {
    val colors = inboxiesColors()
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = title,
            fontFamily = InterFontFamily,
            fontWeight = FontWeight.Bold,
            fontSize = 26.sp,
            color = colors.ink,
        )
        Text(
            text = subtitle,
            fontFamily = InterFontFamily,
            fontSize = 16.sp,
            color = colors.muted,
            modifier = Modifier.padding(top = 6.dp, bottom = 28.dp),
        )
    }
}

@Composable
private fun SetupStatusRow(
    title: String,
    detail: String,
) {
    val colors = inboxiesColors()
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = Color(0xFF16A34A), modifier = Modifier.size(16.dp).padding(top = 2.dp))
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(title, fontFamily = InterFontFamily, fontWeight = FontWeight.Medium, fontSize = 14.sp, color = colors.ink)
            Text(detail, fontFamily = InterFontFamily, fontSize = 12.sp, color = colors.muted)
        }
    }
}

@Composable
private fun DnsRecordRow(
    type: String,
    host: String,
    value: String,
    onCopy: () -> Unit,
) {
    val colors = inboxiesColors()
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(colors.accent.copy(alpha = 0.12f)).padding(horizontal = 6.dp, vertical = 2.dp),
            ) {
                Text(type, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 11.sp, color = colors.accent)
            }
            Spacer(Modifier.width(8.dp))
            Text(host, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium, fontSize = 12.sp, color = colors.ink, modifier = Modifier.weight(1f))
            IconButton(onClick = onCopy, modifier = Modifier.size(28.dp)) {
                Icon(Icons.Outlined.ContentCopy, contentDescription = "Copy record", tint = colors.accent, modifier = Modifier.size(14.dp))
            }
        }
        Text(value, fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = colors.muted, modifier = Modifier.padding(start = 2.dp, top = 2.dp))
    }
}
