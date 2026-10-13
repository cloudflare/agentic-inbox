package co.inboxies.app.services

import co.inboxies.app.config.AppConfig
import co.inboxies.app.models.AccountSummary
import co.inboxies.app.models.AdminCreateMailboxResponse
import co.inboxies.app.models.AdminDomainConnectResponse
import co.inboxies.app.models.AdminDomainInfo
import co.inboxies.app.models.AdminDomainsResponse
import co.inboxies.app.models.AdminMailboxRow
import co.inboxies.app.models.AliasesResponse
import co.inboxies.app.models.CreateAliasResponse
import co.inboxies.app.models.MaskedAlias
import co.inboxies.app.models.AgentConversation
import co.inboxies.app.models.AppConfigResponse
import co.inboxies.app.models.AttachIdentityResponse
import co.inboxies.app.models.ChangePasswordResponse
import co.inboxies.app.models.CloudflareDnsRecord
import co.inboxies.app.models.DnsRecordMutationResponse
import co.inboxies.app.models.DnsRecordsListResponse
import co.inboxies.app.models.DomainAliasItem
import co.inboxies.app.models.DomainAliasesResponse
import co.inboxies.app.models.DomainAvailabilityResponse
import co.inboxies.app.models.DomainCheckoutResponse
import co.inboxies.app.models.DomainEppCodeResponse
import co.inboxies.app.models.DomainHealthResponse
import co.inboxies.app.models.DomainTransferLockResponse
import co.inboxies.app.models.ExportJob
import co.inboxies.app.models.ForgotPasswordResponse
import co.inboxies.app.models.DecommissionPreflightResponse
import co.inboxies.app.models.DecommissionResponse
import co.inboxies.app.models.FixEmailDnsResponse
import co.inboxies.app.models.OnboardingDomainResponse
import co.inboxies.app.models.OnboardingPersonalResponse
import co.inboxies.app.models.AuthResponse
import co.inboxies.app.models.DigestStatusResponse
import co.inboxies.app.models.DraftSaveResponse
import co.inboxies.app.models.Email
import co.inboxies.app.models.EmailListResponse
import co.inboxies.app.models.WorkflowPilesResponse
import co.inboxies.app.models.Folder
import co.inboxies.app.models.InboxDigest
import co.inboxies.app.models.IdentitiesResponse
import co.inboxies.app.models.IdentityLinkCodeResponse
import co.inboxies.app.models.InviteAcceptResponse
import co.inboxies.app.models.InviteCreateResponse
import co.inboxies.app.models.InvitePublic
import co.inboxies.app.models.Mailbox
import co.inboxies.app.models.MailboxSettings
import co.inboxies.app.models.MeResponse
import co.inboxies.app.models.PasswordLoginResponse
import co.inboxies.app.models.RedeemIdentityLinkResponse
import co.inboxies.app.models.RecentRecipient
import co.inboxies.app.models.RecentRecipientsResponse
import co.inboxies.app.models.SendEmailResponse
import co.inboxies.app.models.SenderPreference
import co.inboxies.app.models.SenderPreferencesResponse
import co.inboxies.app.models.UpsertSenderPreferenceResponse
import co.inboxies.app.util.ParsedSearch
import co.inboxies.app.util.SearchQueryParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

sealed class ApiException(message: String) : Exception(message) {
    class InvalidURL : ApiException("Invalid API URL")
    class Http(val code: Int, body: String) : ApiException(if (body.isNotEmpty()) body else "HTTP $code")
    class Decoding(cause: Throwable) : ApiException("Decode error: ${cause.message}")
    class NotJson(preview: String) : ApiException("API returned HTML instead of JSON. $preview")
    class CloudflareAccess : ApiException(
        "Cloudflare Access is blocking the API. Add a Bypass policy for <your-api-host>/api/* " +
            "(and /agents/* for chat) in Zero Trust.",
    )
    class Transport(cause: Throwable) : ApiException(cause.message ?: "Network error")
}

@Serializable
class EmptyResponse

/** Thin OkHttp + kotlinx.serialization client mirroring iOS APIClient. */
class ApiClient private constructor() {
    var authTokenProvider: () -> String? = { null }

    val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = false
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .followRedirects(false)
        .build()

    companion object {
        val shared: ApiClient by lazy { ApiClient() }
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }

    suspend inline fun <reified T> request(
        path: String,
        method: String = "GET",
        query: Map<String, String> = emptyMap(),
        body: JsonObject? = null,
        authed: Boolean = true,
    ): T = withContext(Dispatchers.IO) {
        val (data, code, contentType) = perform(path, method, query, body, authed)
        if (code == 204 && T::class == EmptyResponse::class) {
            @Suppress("UNCHECKED_CAST")
            return@withContext EmptyResponse() as T
        }
        if (!contentType.contains("json", ignoreCase = true) && data.isNotBlank()) {
            if (looksLikeCloudflareAccess(data, null)) throw ApiException.CloudflareAccess()
            throw ApiException.NotJson(data.take(160))
        }
        try {
            json.decodeFromString<T>(data.ifBlank { "{}" })
        } catch (e: Exception) {
            throw ApiException.Decoding(e)
        }
    }

    suspend fun requestBytes(
        path: String,
        method: String = "GET",
        query: Map<String, String> = emptyMap(),
        authed: Boolean = true,
    ): ByteArray = withContext(Dispatchers.IO) {
        val (data, _, _) = perform(path, method, query, null, authed, asBytes = true)
        data.toByteArray(StandardCharsets.ISO_8859_1)
    }

    fun perform(
        path: String,
        method: String,
        query: Map<String, String>,
        body: JsonObject?,
        authed: Boolean,
        asBytes: Boolean = false,
    ): Triple<String, Int, String> {
        val base = AppConfig.apiBaseURL
        val uri = try {
            URI(base)
        } catch (_: Exception) {
            throw ApiException.InvalidURL()
        }
        val cleanPath = if (path.startsWith("/")) path else "/$path"
        val basePath = uri.path?.trim('/')?.takeIf { it.isNotEmpty() }
        val fullPath = if (basePath == null) cleanPath else "/$basePath$cleanPath"
        val queryString = if (query.isEmpty()) {
            ""
        } else {
            "?" + query.entries.joinToString("&") { (k, v) ->
                "${urlEncode(k)}=${urlEncode(v)}"
            }
        }
        val port = if (uri.port != -1) ":${uri.port}" else ""
        val url = "${uri.scheme}://${uri.host}$port$fullPath$queryString"

        val builder = Request.Builder().url(url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
        if (authed) {
            authTokenProvider()?.let { builder.header("Authorization", "Bearer $it") }
        }
        val requestBody = body?.let { json.encodeToString(JsonObject.serializer(), it).toRequestBody(JSON_MEDIA) }
        builder.method(method, if (method == "GET" || method == "DELETE" && requestBody == null) null else requestBody
            ?: if (method == "POST" || method == "PUT" || method == "PATCH") "{}".toRequestBody(JSON_MEDIA) else null)

        try {
            client.newCall(builder.build()).execute().use { response ->
                val bytes = response.body?.bytes() ?: ByteArray(0)
                val text = if (asBytes) {
                    String(bytes, StandardCharsets.ISO_8859_1)
                } else {
                    String(bytes, StandardCharsets.UTF_8)
                }
                val location = response.header("Location")
                val wwwAuth = response.header("WWW-Authenticate")
                if (looksLikeCloudflareAccess(text, wwwAuth) || location?.contains("cloudflareaccess") == true) {
                    throw ApiException.CloudflareAccess()
                }
                if (!response.isSuccessful) {
                    throw ApiException.Http(response.code, httpErrorMessage(text))
                }
                return Triple(text, response.code, response.header("Content-Type").orEmpty())
            }
        } catch (e: ApiException) {
            throw e
        } catch (e: Exception) {
            throw ApiException.Transport(e)
        }
    }

    suspend fun listMailboxes(): List<Mailbox> = request("/api/v1/mailboxes")

    suspend fun getConfig(): AppConfigResponse =
        request("/api/v1/config", method = "GET", authed = false)

    suspend fun getMe(): MeResponse = request("/api/v1/me")

    suspend fun listIdentities(): IdentitiesResponse = request("/api/v1/me/identities")
    suspend fun listAccounts(): List<AccountSummary> = request("/api/v1/accounts")

    suspend fun attachAppleIdentity(identityToken: String): AttachIdentityResponse = request(
        "/api/v1/me/identities/attach",
        method = "POST",
        body = buildJsonObject {
            put("provider", "apple")
            put("identityToken", identityToken)
        },
    )

    suspend fun attachGoogleIdentity(idToken: String): AttachIdentityResponse = request(
        "/api/v1/me/identities/attach",
        method = "POST",
        body = buildJsonObject {
            put("provider", "google")
            put("idToken", idToken)
        },
    )

    suspend fun attachPasswordIdentity(
        password: String,
        loginEmail: String? = null,
    ): AttachIdentityResponse = request(
        "/api/v1/me/identities/attach",
        method = "POST",
        body = buildJsonObject {
            put("provider", "password")
            put("password", password)
            if (!loginEmail.isNullOrBlank()) put("loginEmail", loginEmail)
        },
    )

    suspend fun changePassword(
        currentPassword: String,
        newPassword: String,
    ): ChangePasswordResponse = request(
        "/api/v1/me/identities/password",
        method = "POST",
        body = buildJsonObject {
            put("currentPassword", currentPassword)
            put("newPassword", newPassword)
        },
    )

    suspend fun createIdentityLinkCode(): IdentityLinkCodeResponse = request(
        "/api/v1/me/identity-link-codes",
        method = "POST",
        body = buildJsonObject {},
    )

    suspend fun redeemIdentityLink(code: String): RedeemIdentityLinkResponse = request(
        "/api/v1/auth/redeem-identity-link",
        method = "POST",
        body = buildJsonObject { put("code", code) },
    )

    suspend fun createMailbox(name: String, email: String): Mailbox = request(
        "/api/v1/mailboxes",
        method = "POST",
        body = buildJsonObject {
            put("name", name)
            put("email", email)
        },
    )

    suspend fun getMailbox(mailboxId: String): Mailbox =
        request("/api/v1/mailboxes/${pathEncode(mailboxId)}")

    suspend fun updateMailbox(mailboxId: String, settings: MailboxSettings): Mailbox {
        val settingsElement = json.encodeToJsonElement(MailboxSettings.serializer(), settings)
        return request(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}",
            method = "PUT",
            body = buildJsonObject { put("settings", settingsElement) },
        )
    }

    suspend fun deleteMailbox(mailboxId: String) {
        request<EmptyResponse>("/api/v1/mailboxes/${pathEncode(mailboxId)}", method = "DELETE")
    }

    suspend fun getInvite(token: String): InvitePublic =
        request("/api/v1/invites/${pathEncode(token)}", method = "GET", authed = false)

    suspend fun acceptInvite(
        token: String,
        password: String,
        displayName: String? = null,
    ): InviteAcceptResponse = request(
        "/api/v1/invites/${pathEncode(token)}/accept",
        method = "POST",
        body = buildJsonObject {
            put("password", password)
            if (!displayName.isNullOrBlank()) put("displayName", displayName)
        },
        authed = false,
    )

    suspend fun passwordLogin(email: String, password: String): PasswordLoginResponse = request(
        "/api/v1/auth/password",
        method = "POST",
        body = buildJsonObject {
            put("email", email)
            put("password", password)
        },
        authed = false,
    )

    suspend fun forgotPassword(email: String): ForgotPasswordResponse = request(
        "/api/v1/auth/password/forgot",
        method = "POST",
        body = buildJsonObject {
            put("email", email)
        },
        authed = false,
    )

    /** Pass [token] (email link), or [email] + [code] (6-digit code). */
    suspend fun resetPassword(token: String? = null, email: String? = null, code: String? = null, newPassword: String): PasswordLoginResponse = request(
        "/api/v1/auth/password/reset",
        method = "POST",
        body = buildJsonObject {
            if (token != null) put("token", token)
            if (email != null) put("email", email)
            if (code != null) put("code", code)
            put("newPassword", newPassword)
        },
        authed = false,
    )

    suspend fun listAdminMailboxes(): List<AdminMailboxRow> =
        request("/api/v1/admin/mailboxes")

    suspend fun assignAdminMailboxToSelf(mailboxId: String): Mailbox = request(
        "/api/v1/admin/mailboxes/${pathEncode(mailboxId)}/assign",
        method = "POST",
        body = buildJsonObject { put("assignTo", "self") },
    )

    suspend fun createAdminMailbox(
        email: String,
        name: String? = null,
        assignToSelf: Boolean = true,
        inviteEmail: String? = null,
        inviteeName: String? = null,
    ): AdminCreateMailboxResponse = request(
        "/api/v1/admin/mailboxes",
        method = "POST",
        body = buildJsonObject {
            put("email", email)
            if (!name.isNullOrBlank()) put("name", name)
            if (assignToSelf) {
                put("assignTo", "self")
            } else {
                put(
                    "assignTo",
                    buildJsonObject {
                        put("inviteEmail", inviteEmail ?: "")
                        put("role", "owner")
                        if (!inviteeName.isNullOrBlank()) put("inviteeName", inviteeName)
                    },
                )
            }
        },
    )

    suspend fun deleteAdminMailbox(mailboxId: String) {
        request<EmptyResponse>(
            "/api/v1/admin/mailboxes/${pathEncode(mailboxId)}",
            method = "DELETE",
        )
    }

    // MARK: - Onboarding & Custom Domains

    suspend fun signupPersonal(
        username: String,
        password: String,
        displayName: String? = null,
        backupEmail: String? = null,
    ): OnboardingPersonalResponse = request(
        "/api/v1/auth/signup-personal",
        method = "POST",
        body = buildJsonObject {
            put("username", username)
            put("password", password)
            if (!displayName.isNullOrBlank()) put("displayName", displayName)
            if (!backupEmail.isNullOrBlank()) put("backupEmail", backupEmail)
        },
        authed = false,
    )

    suspend fun signupDomain(
        domain: String,
        username: String,
        password: String,
        displayName: String? = null,
        backupEmail: String? = null,
    ): OnboardingDomainResponse = request(
        "/api/v1/auth/signup-domain",
        method = "POST",
        body = buildJsonObject {
            put("domain", domain)
            put("username", username)
            put("password", password)
            if (!displayName.isNullOrBlank()) put("displayName", displayName)
            if (!backupEmail.isNullOrBlank()) put("backupEmail", backupEmail)
        },
        authed = false,
    )

    suspend fun listDomainAliases(domain: String): List<DomainAliasItem> {
        val res = request<DomainAliasesResponse>("/api/v1/admin/domains/${pathEncode(domain)}/aliases")
        return res.aliases
    }

    suspend fun setupDomainAliases(domain: String, aliases: List<Map<String, String>>) {
        request<EmptyResponse>(
            "/api/v1/admin/domains/${pathEncode(domain)}/setup-aliases",
            method = "POST",
            body = buildJsonObject {
                put("aliases", kotlinx.serialization.json.JsonArray(aliases.map { map ->
                    buildJsonObject {
                        map.forEach { (k, v) -> put(k, v) }
                    }
                }))
            },
        )
    }

    suspend fun setupDomainUsers(domain: String, users: List<Map<String, String>>) {
        request<EmptyResponse>(
            "/api/v1/admin/domains/${pathEncode(domain)}/setup-users",
            method = "POST",
            body = buildJsonObject {
                put("users", kotlinx.serialization.json.JsonArray(users.map { map ->
                    buildJsonObject {
                        map.forEach { (k, v) -> put(k, v) }
                    }
                }))
            },
        )
    }

    // MARK: - Admin DNS Suite

    suspend fun listAdminDomains(): List<AdminDomainInfo> {
        val res = request<AdminDomainsResponse>("/api/v1/admin/domains")
        return res.domains
    }

    suspend fun connectAdminDomain(domain: String): AdminDomainConnectResponse = request(
        "/api/v1/admin/domains",
        method = "POST",
        body = buildJsonObject {
            put("domain", domain)
        },
    )

    suspend fun getDomainDnsHealth(domain: String): DomainHealthResponse =
        request("/api/v1/admin/domains/${pathEncode(domain)}/dns/health")

    suspend fun fixDomainEmailDns(domain: String): FixEmailDnsResponse = request(
        "/api/v1/admin/domains/${pathEncode(domain)}/dns/fix-email",
        method = "POST",
        body = buildJsonObject {},
    )

    suspend fun listDomainDnsRecords(
        domain: String,
        type: String? = null,
        name: String? = null,
    ): List<CloudflareDnsRecord> {
        val query = mutableMapOf<String, String>()
        if (!type.isNullOrBlank()) query["type"] = type
        if (!name.isNullOrBlank()) query["name"] = name
        val res = request<DnsRecordsListResponse>(
            "/api/v1/admin/domains/${pathEncode(domain)}/dns/records",
            query = query,
        )
        return res.records
    }

    suspend fun createDomainDnsRecord(
        domain: String,
        type: String,
        name: String,
        content: String,
        ttl: Int = 1,
        proxied: Boolean = false,
        priority: Int? = null,
        comment: String? = null,
    ): CloudflareDnsRecord {
        val body = buildJsonObject {
            put("type", type)
            put("name", name)
            put("content", content)
            put("ttl", ttl)
            put("proxied", proxied)
            priority?.let { put("priority", it) }
            if (!comment.isNullOrBlank()) put("comment", comment)
        }
        val res = request<DnsRecordMutationResponse>(
            "/api/v1/admin/domains/${pathEncode(domain)}/dns/records",
            method = "POST",
            body = body,
        )
        return res.record
    }

    suspend fun updateDomainDnsRecord(
        domain: String,
        recordId: String,
        type: String,
        name: String,
        content: String,
        ttl: Int = 1,
        proxied: Boolean = false,
        priority: Int? = null,
        comment: String? = null,
    ): CloudflareDnsRecord {
        val body = buildJsonObject {
            put("type", type)
            put("name", name)
            put("content", content)
            put("ttl", ttl)
            put("proxied", proxied)
            priority?.let { put("priority", it) }
            if (!comment.isNullOrBlank()) put("comment", comment)
        }
        val res = request<DnsRecordMutationResponse>(
            "/api/v1/admin/domains/${pathEncode(domain)}/dns/records/${pathEncode(recordId)}",
            method = "PUT",
            body = body,
        )
        return res.record
    }

    suspend fun deleteDomainDnsRecord(domain: String, recordId: String) {
        request<EmptyResponse>(
            "/api/v1/admin/domains/${pathEncode(domain)}/dns/records/${pathEncode(recordId)}",
            method = "DELETE",
        )
    }

    suspend fun createAdminInvite(
        mailboxId: String,
        inviteEmail: String,
        inviteeName: String? = null,
        role: String = "owner",
    ): InviteCreateResponse = request(
        "/api/v1/admin/invites",
        method = "POST",
        body = buildJsonObject {
            put("mailboxId", mailboxId)
            put("inviteEmail", inviteEmail)
            put("role", role)
            if (!inviteeName.isNullOrBlank()) put("inviteeName", inviteeName)
        },
    )

    suspend fun createMailboxInvite(
        mailboxId: String,
        inviteEmail: String,
        role: String = "member",
    ): InviteCreateResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/invites",
        method = "POST",
        body = buildJsonObject {
            put("inviteEmail", inviteEmail)
            put("role", role)
        },
    )

    suspend fun listFolders(mailboxId: String): List<Folder> =
        request("/api/v1/mailboxes/${pathEncode(mailboxId)}/folders")

    suspend fun getInboxDigest(mailboxId: String): InboxDigest =
        request("/api/v1/mailboxes/${pathEncode(mailboxId)}/inbox-digest")

    suspend fun inboxDigest(mailboxId: String): InboxDigest = getInboxDigest(mailboxId)

    fun okHttpClient(): OkHttpClient = client

    suspend fun completeDigestTodo(mailboxId: String, todoId: String): DigestStatusResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/inbox-digest/todos/${pathEncode(todoId)}/complete",
        method = "POST",
    )

    suspend fun markDigestTopicRead(mailboxId: String, topicId: String, emailIds: List<String>): DigestStatusResponse =
        request(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}/inbox-digest/topics/${pathEncode(topicId)}/mark-read",
            method = "POST",
            body = buildJsonObject {
                put("emailIds", kotlinx.serialization.json.JsonArray(emailIds.map { JsonPrimitive(it) }))
            },
        )

    suspend fun listEmails(
        mailboxId: String,
        folder: String,
        page: Int = 1,
        threaded: Boolean = true,
    ): EmailListResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/emails",
        query = mapOf(
            "folder" to folder,
            "threaded" to threaded.toString(),
            "page" to page.toString(),
            "limit" to "25",
        ),
    )

    suspend fun getEmail(mailboxId: String, id: String): Email =
        request("/api/v1/mailboxes/${pathEncode(mailboxId)}/emails/${pathEncode(id)}")

    suspend fun getThread(mailboxId: String, threadId: String): List<Email> =
        request("/api/v1/mailboxes/${pathEncode(mailboxId)}/threads/${pathEncode(threadId)}")

    suspend fun updateEmail(
        mailboxId: String,
        id: String,
        read: Boolean? = null,
        starred: Boolean? = null,
        replyLater: Boolean? = null,
    ): Email = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/emails/${pathEncode(id)}",
        method = "PUT",
        body = buildJsonObject {
            if (read != null) put("read", read)
            if (starred != null) put("starred", starred)
            if (replyLater != null) put("reply_later", replyLater)
        },
    )

    suspend fun listReplyLaterEmails(
        mailboxId: String,
        page: Int = 1,
    ): EmailListResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/emails",
        query = mapOf(
            "reply_later" to "true",
            "page" to page.toString(),
            "limit" to "25",
        ),
    )

    suspend fun listWorkflowPiles(mailboxId: String): WorkflowPilesResponse =
        request("/api/v1/mailboxes/${pathEncode(mailboxId)}/workflow-piles")

    suspend fun markRead(mailboxId: String, id: String): Email =
        updateEmail(mailboxId, id, read = true)

    suspend fun markThreadRead(mailboxId: String, threadId: String) {
        request<EmptyResponse>(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}/threads/${pathEncode(threadId)}/read",
            method = "POST",
        )
    }

    suspend fun moveEmail(
        mailboxId: String,
        id: String,
        folderId: String,
        setSenderPreference: Boolean = false,
    ) {
        request<EmptyResponse>(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}/emails/${pathEncode(id)}/move",
            method = "POST",
            body = buildJsonObject {
                put("folderId", folderId)
                if (setSenderPreference) put("setSenderPreference", true)
            },
        )
    }

    suspend fun listSenderPreferences(
        mailboxId: String,
        q: String = "",
        folder: String? = null,
    ): List<SenderPreference> {
        val response: SenderPreferencesResponse = request(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}/sender-preferences",
            query = buildMap {
                put("limit", "200")
                if (q.isNotBlank()) put("q", q)
                if (!folder.isNullOrBlank()) put("folder", folder)
            },
        )
        return response.preferences
    }

    suspend fun upsertSenderPreference(
        mailboxId: String,
        address: String,
        folderId: String,
        displayName: String? = null,
        refile: Boolean = true,
    ): UpsertSenderPreferenceResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/sender-preferences/${pathEncode(address)}",
        method = "PUT",
        body = buildJsonObject {
            put("folderId", folderId)
            put("refile", refile)
            if (displayName != null) put("displayName", displayName)
        },
    )

    suspend fun deleteSenderPreference(mailboxId: String, address: String) {
        request<EmptyResponse>(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}/sender-preferences/${pathEncode(address)}",
            method = "DELETE",
        )
    }

    suspend fun approveSender(
        mailboxId: String,
        sender: String,
        destinationFolderId: String,
        emailId: String? = null,
        displayName: String? = null,
    ) {
        request<EmptyResponse>(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}/sender-triage/approve",
            method = "POST",
            body = buildJsonObject {
                put("sender", sender)
                put("destinationFolderId", destinationFolderId)
                if (emailId != null) put("emailId", emailId)
                if (displayName != null) put("displayName", displayName)
            },
        )
    }

    suspend fun rejectSender(
        mailboxId: String,
        sender: String,
        emailId: String? = null,
        displayName: String? = null,
    ) {
        request<EmptyResponse>(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}/sender-triage/reject",
            method = "POST",
            body = buildJsonObject {
                put("sender", sender)
                if (emailId != null) put("emailId", emailId)
                if (displayName != null) put("displayName", displayName)
            },
        )
    }

    suspend fun deleteEmail(mailboxId: String, id: String) {
        request<EmptyResponse>(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}/emails/${pathEncode(id)}",
            method = "DELETE",
        )
    }

    suspend fun searchEmails(mailboxId: String, query: String, page: Int = 1): EmailListResponse =
        searchEmails(mailboxId, SearchQueryParser.parse(query), page)

    suspend fun searchEmails(
        mailboxId: String,
        parsed: ParsedSearch,
        page: Int = 1,
    ): EmailListResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/search",
        query = parsed.toApiQuery() + mapOf(
            "page" to page.toString(),
            "limit" to "25",
        ),
    )

    suspend fun listRecipients(mailboxId: String, q: String = "", limit: Int = 20): List<RecentRecipient> {
        val response: RecentRecipientsResponse = request(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}/recipients",
            query = buildMap {
                if (q.isNotEmpty()) put("q", q)
                put("limit", limit.toString())
            },
        )
        return response.recipients
    }

    suspend fun search(mailboxId: String, query: String): List<Email> =
        searchEmails(mailboxId, query).emails

    suspend fun sendEmail(mailboxId: String, payload: JsonObject): SendEmailResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/emails",
        method = "POST",
        body = payload,
    )

    suspend fun sendEmail(
        mailboxId: String,
        to: String,
        subject: String,
        body: String,
        cc: String? = null,
        bcc: String? = null,
    ): SendEmailResponse = sendEmail(
        mailboxId,
        buildJsonObject {
            put("to", to)
            put("subject", subject)
            put("body", body)
            put("html", true)
            if (!cc.isNullOrBlank()) put("cc", cc)
            if (!bcc.isNullOrBlank()) put("bcc", bcc)
        },
    )

    suspend fun replyToEmail(mailboxId: String, emailId: String, payload: JsonObject): SendEmailResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/emails/${pathEncode(emailId)}/reply",
        method = "POST",
        body = payload,
    )

    suspend fun replyEmail(
        mailboxId: String,
        emailId: String,
        body: String,
        replyAll: Boolean = false,
    ): SendEmailResponse = replyToEmail(
        mailboxId,
        emailId,
        buildJsonObject {
            put("body", body)
            put("html", true)
            put("replyAll", replyAll)
        },
    )

    suspend fun forwardEmail(mailboxId: String, emailId: String, payload: JsonObject): SendEmailResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/emails/${pathEncode(emailId)}/forward",
        method = "POST",
        body = payload,
    )

    suspend fun forwardEmail(
        mailboxId: String,
        emailId: String,
        to: String,
        body: String,
    ): SendEmailResponse = forwardEmail(
        mailboxId,
        emailId,
        buildJsonObject {
            put("to", to)
            put("body", body)
            put("html", true)
        },
    )

    suspend fun saveDraft(mailboxId: String, draft: JsonObject): DraftSaveResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/drafts",
        method = "POST",
        body = draft,
    )

    suspend fun saveDraft(
        mailboxId: String,
        to: String,
        subject: String,
        body: String,
        draftId: String? = null,
        inReplyTo: String? = null,
        cc: String? = null,
        bcc: String? = null,
    ): DraftSaveResponse = saveDraft(
        mailboxId,
        buildJsonObject {
            put("to", to)
            put("subject", subject)
            put("body", body)
            put("html", true)
            if (!draftId.isNullOrBlank()) put("id", draftId)
            if (!inReplyTo.isNullOrBlank()) put("inReplyTo", inReplyTo)
            if (!cc.isNullOrBlank()) put("cc", cc)
            if (!bcc.isNullOrBlank()) put("bcc", bcc)
        },
    )

    suspend fun getAttachment(mailboxId: String, emailId: String, attachmentId: String): ByteArray =
        requestBytes(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}/emails/${pathEncode(emailId)}/attachments/${pathEncode(attachmentId)}",
        )

    suspend fun listConversations(mailboxId: String): List<AgentConversation> =
        request("/api/v1/mailboxes/${pathEncode(mailboxId)}/agent/conversations")

    suspend fun createConversation(
        mailboxId: String,
        id: String? = null,
        title: String? = null,
        lastMessagePreview: String? = null,
    ): AgentConversation = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/agent/conversations",
        method = "POST",
        body = buildJsonObject {
            if (id != null) put("id", id)
            if (title != null) put("title", title)
            if (lastMessagePreview != null) put("lastMessagePreview", lastMessagePreview)
        },
    )

    suspend fun updateConversation(
        mailboxId: String,
        id: String,
        title: String? = null,
        lastMessagePreview: String? = null,
    ): AgentConversation = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/agent/conversations/${pathEncode(id)}",
        method = "PATCH",
        body = buildJsonObject {
            if (title != null) put("title", title)
            if (lastMessagePreview != null) put("lastMessagePreview", lastMessagePreview)
        },
    )

    suspend fun deleteConversation(mailboxId: String, id: String) {
        request<EmptyResponse>(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}/agent/conversations/${pathEncode(id)}",
            method = "DELETE",
        )
    }

    suspend fun registerDeviceToken(mailboxId: String, token: String) {
        request<EmptyResponse>(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}/device-token",
            method = "POST",
            body = buildJsonObject {
                put("token", token)
                put("platform", "android")
            },
        )
    }

    suspend fun unregisterDeviceToken(mailboxId: String, token: String) {
        request<EmptyResponse>(
            "/api/v1/mailboxes/${pathEncode(mailboxId)}/device-token/${pathEncode(token)}",
            method = "DELETE",
        )
    }

    suspend fun authGoogle(idToken: String): AuthResponse = request(
        "/api/v1/auth/google",
        method = "POST",
        body = buildJsonObject { put("idToken", idToken) },
        authed = false,
    )

    suspend fun authDev(email: String): AuthResponse = request(
        "/api/v1/auth/dev",
        method = "POST",
        body = buildJsonObject { put("email", email) },
        authed = false,
    )

    // MARK: - Registrar & Billing

    suspend fun checkDomainAvailability(domain: String): DomainAvailabilityResponse =
        request("/api/v1/auth/domains/check", query = mapOf("domain" to domain), authed = false)

    suspend fun createDomainCheckout(
        domain: String,
        username: String? = null,
        password: String? = null,
        displayName: String? = null,
        returnUrl: String? = null,
        client: String? = "android",
    ): DomainCheckoutResponse = request(
        "/api/v1/billing/create-domain-checkout",
        method = "POST",
        body = buildJsonObject {
            put("domain", domain)
            if (username != null) put("username", username)
            if (password != null) put("password", password)
            if (displayName != null) put("displayName", displayName)
            if (returnUrl != null) put("returnUrl", returnUrl)
            if (client != null) put("client", client)
        },
        authed = false,
    )

    suspend fun checkoutStatus(domain: String, sessionId: String? = null): CheckoutStatusResponse = request(
        "/api/v1/billing/checkout-status",
        query = buildMap {
            put("domain", domain)
            if (!sessionId.isNullOrBlank()) put("session_id", sessionId)
        },
        authed = false,
    )

    // MARK: - Email Export Engine

    suspend fun exportDomain(domain: String): ExportJob = request(
        "/api/v1/admin/domains/${pathEncode(domain)}/export",
        method = "POST",
    )

    suspend fun getExportJob(exportId: String): ExportJob = request(
        "/api/v1/exports/${pathEncode(exportId)}",
    )

    fun exportDownloadUrl(exportId: String): String =
        "${co.inboxies.app.config.AppConfig.apiBaseURL}/api/v1/exports/${pathEncode(exportId)}/download"

    // MARK: - DNS Offboarding & Decommission

    suspend fun getDecommissionPreflight(domain: String): DecommissionPreflightResponse = request(
        "/api/v1/admin/domains/${pathEncode(domain)}/decommission-preflight",
        method = "POST",
    )

    suspend fun decommissionDomain(
        domain: String,
        confirmDomain: String,
        skipExportAcknowledged: Boolean = false,
    ): DecommissionResponse = request(
        "/api/v1/admin/domains/${pathEncode(domain)}/decommission",
        method = "POST",
        body = buildJsonObject {
            put("confirmDomain", confirmDomain)
            put("skipExportAcknowledged", skipExportAcknowledged)
        },
    )

    suspend fun getDomainEppCode(domain: String): DomainEppCodeResponse = request(
        "/api/v1/admin/domains/${pathEncode(domain)}/epp-code",
    )

    suspend fun setDomainTransferLock(domain: String, locked: Boolean): DomainTransferLockResponse = request(
        "/api/v1/admin/domains/${pathEncode(domain)}/transfer-lock",
        method = "POST",
        body = buildJsonObject {
            put("locked", locked)
        },
    )

    // MARK: - Masked Email Aliases

    suspend fun listAliases(mailboxId: String): AliasesResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/aliases",
    )

    suspend fun createAlias(
        mailboxId: String,
        label: String? = null,
        notes: String? = null,
        expiresInSeconds: Int? = null,
        pausedAction: String = "drop",
    ): CreateAliasResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/aliases",
        method = "POST",
        body = buildJsonObject {
            label?.let { put("label", it) }
            notes?.let { put("notes", it) }
            expiresInSeconds?.let { put("expires_in_seconds", it) }
            put("paused_action", pausedAction)
        },
    )

    suspend fun updateAlias(
        mailboxId: String,
        aliasId: String,
        label: String? = null,
        notes: String? = null,
        isActive: Boolean? = null,
        pausedAction: String? = null,
    ): CreateAliasResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/aliases/${pathEncode(aliasId)}",
        method = "PATCH",
        body = buildJsonObject {
            label?.let { put("label", it) }
            notes?.let { put("notes", it) }
            isActive?.let { put("is_active", it) }
            pausedAction?.let { put("paused_action", it) }
        },
    )

    suspend fun deleteAlias(mailboxId: String, aliasId: String): EmptyResponse = request(
        "/api/v1/mailboxes/${pathEncode(mailboxId)}/aliases/${pathEncode(aliasId)}",
        method = "DELETE",
    )

    private fun pathEncode(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20")

    private fun urlEncode(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name())

    private fun httpErrorMessage(data: String): String = try {
        val obj = json.parseToJsonElement(data).jsonObjectOrNull()
        obj?.get("error")?.let { (it as? JsonPrimitive)?.content } ?: data
    } catch (_: Exception) {
        data
    }

    fun looksLikeCloudflareAccess(body: String, wwwAuth: String?): Boolean {
        if (wwwAuth?.contains("cloudflare-access", ignoreCase = true) == true) return true
        val preview = body.take(400).lowercase()
        return preview.contains("cloudflareaccess.com") || preview.contains("cloudflare access")
    }

    private fun JsonElement.jsonObjectOrNull(): JsonObject? = this as? JsonObject
}
