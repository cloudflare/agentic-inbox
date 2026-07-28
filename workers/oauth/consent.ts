// OAuth 2.1 authorization bridge for the MCP connector.
//
// The MCP endpoint is fronted by @cloudflare/workers-oauth-provider, which serves
// all the OAuth machinery (RFC 9728 / RFC 8414 metadata, RFC 7591 dynamic client
// registration, /token, PKCE, the 401 WWW-Authenticate challenge). The ONE thing
// the library leaves to us is the user-facing /authorize endpoint — this file.
//
// It reuses the app's existing email+password session (locked-decisions D-20..25):
// /authorize checks the session cookie; if absent it bounces to /login and back;
// if present it shows a consent screen and mints the grant via completeAuthorization,
// carrying the same { userId, role, mailbox } props the MCP tools already read.
//
// Because the session cookie is SameSite=Strict, Claude's first cross-site hit to
// /authorize never carries it, so the user always logs in here during connect — an
// intentional, secure re-consent (and the reason a CSRF token is also unnecessary,
// though the signed transaction below provides tamper protection regardless).

import type { Context } from "hono";
import type {
	AuthRequest,
	ResolveExternalTokenInput,
	ResolveExternalTokenResult,
} from "@cloudflare/workers-oauth-provider";
import {
	verifySession,
	sessionMatchesUserVersion,
	readCookie,
	hashToken,
	signAuthTxn,
	verifyAuthTxn,
	SESSION_COOKIE_NAME,
	type SessionClaims,
} from "../lib/auth";
import { getUserById, getUserByMcpTokenHash } from "../lib/users";
import {
	DEFAULT_MCP_SCOPES,
	legacyMcpScopes,
} from "../lib/mcp-authorization";
import { escapeHtml } from "../lib/email-helpers";
import { pageShell, brandLogo, resolveBrand, type BrandConfig } from "../routes/brand";
import type { Env } from "../types";

type Ctx = Context<{ Bindings: Env; Variables: { session?: SessionClaims } }>;

/** Scopes advertised in OAuth metadata and enforced by every MCP tool. */
export { MCP_SCOPES } from "../lib/mcp-authorization";

// ── /authorize (GET): authenticate the user, then show consent ──────

export async function authorizeGet(c: Ctx) {
	const brand = resolveBrand(c.env.BRAND);
	// parseAuthRequest validates the client against KV and throws for unknown /
	// stale client_ids — surface that as a clean error rather than a 500.
	let oauthReq: AuthRequest;
	try {
		oauthReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	} catch {
		return c.html(
			renderError(brand, "This authorization request is invalid or has expired. Please reconnect from the app."),
			400,
		);
	}
	if (!oauthReq.clientId) {
		return c.html(renderError(brand, "This authorization request is missing a client."), 400);
	}

	const session = await sessionFrom(c);
	if (!session) {
		// Round-trip the FULL authorize URL through login so PKCE / state / resource
		// survive (dropping any of them breaks the flow).
		const url = new URL(c.req.url);
		const returnTo = url.pathname + url.search;
		return c.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`, 302);
	}

	const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
	const txn = await signAuthTxn(oauthReq, c.env.JWT_SECRET);
	return c.html(
		renderConsent(brand, {
			appName: client?.clientName?.trim() || "An application",
			session,
			txn,
			scopes: oauthReq.scope.length
				? oauthReq.scope
				: [...DEFAULT_MCP_SCOPES],
		}),
	);
}

// ── /authorize (POST): record the approve/deny decision ─────────────

export async function authorizePost(c: Ctx) {
	const brand = resolveBrand(c.env.BRAND);
	const form = await c.req.parseBody();
	const txn = String(form.txn || "");
	const decision = String(form.decision || "");

	const oauthReq = await verifyAuthTxn<AuthRequest>(txn, c.env.JWT_SECRET);
	if (!oauthReq?.clientId || !oauthReq.redirectUri) {
		return c.html(
			renderError(brand, "Your authorization session expired. Please reconnect from the app."),
			400,
		);
	}

	const session = await sessionFrom(c);
	if (!session) {
		// Session lapsed between rendering and approving — re-login, then resume.
		return c.redirect(
			`/login?returnTo=${encodeURIComponent(authorizeUrlFrom(oauthReq))}`,
			302,
		);
	}

	if (decision !== "approve") {
		// User declined: return an OAuth error to the client per RFC 6749 §4.1.2.1.
		const back = new URL(oauthReq.redirectUri);
		back.searchParams.set("error", "access_denied");
		if (oauthReq.state) back.searchParams.set("state", oauthReq.state);
		return c.redirect(back.toString(), 302);
	}

	const user = await getUserById(c.env, session.sub);
	if (!user || user.is_active !== 1) {
		return c.html(renderError(brand, "Your account is not active."), 403);
	}

	const grantedScopes = oauthReq.scope.length
		? oauthReq.scope
		: [...DEFAULT_MCP_SCOPES];
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: oauthReq,
		userId: user.id,
		metadata: { email: user.email },
		scope: grantedScopes,
		// These become `this.props` on the EmailMCP agent — identical shape to the
		// legacy bearer path, so the MCP tools are untouched.
		props: {
			userId: user.id,
			role: user.role,
			mailbox: user.mailbox_address,
			scopes: grantedScopes,
			sessionVersion: user.session_version,
		},
	});
	return c.redirect(redirectTo, 302);
}

// ── Legacy static bearer token (CLI clients) ────────────────────────

/**
 * resolveExternalToken hook: when a presented bearer isn't a provider-issued
 * token, fall back to the admin-issued per-user MCP token (SHA-256 in D1). Keeps
 * `claude mcp add --header "Authorization: Bearer <token>"` and other non-OAuth
 * clients working in parallel with the OAuth connector. Returns null → 401.
 */
export async function resolveLegacyBearer(
	input: ResolveExternalTokenInput,
): Promise<ResolveExternalTokenResult | null> {
	const env = input.env as Env;
	const user = await getUserByMcpTokenHash(env, await hashToken(input.token));
	if (!user || user.is_active !== 1) return null;
	return {
		props: {
			userId: user.id,
			role: user.role,
			mailbox: user.mailbox_address,
			scopes: legacyMcpScopes(user.role),
			sessionVersion: user.session_version,
		},
	};
}

// ── helpers ─────────────────────────────────────────────────────────

async function sessionFrom(c: Ctx): Promise<(SessionClaims & { exp: number }) | null> {
	const token = readCookie(c.req.header("cookie"), SESSION_COOKIE_NAME);
	const claims = token ? await verifySession(token, c.env.JWT_SECRET) : null;
	if (!claims) return null;
	const user = await getUserById(c.env, claims.sub);
	if (
		!user ||
		user.is_active !== 1 ||
		!sessionMatchesUserVersion(claims, user)
	) {
		return null;
	}
	return {
		...claims,
		email: user.email,
		role: user.role,
		mailbox: user.mailbox_address,
		sessionVersion: user.session_version,
	};
}

/** Reconstruct the /authorize URL from a parsed request (for re-login resume). */
function authorizeUrlFrom(req: AuthRequest): string {
	const p = new URLSearchParams();
	p.set("response_type", req.responseType);
	p.set("client_id", req.clientId);
	p.set("redirect_uri", req.redirectUri);
	if (req.scope.length) p.set("scope", req.scope.join(" "));
	if (req.state) p.set("state", req.state);
	if (req.codeChallenge) p.set("code_challenge", req.codeChallenge);
	if (req.codeChallengeMethod) p.set("code_challenge_method", req.codeChallengeMethod);
	for (const r of req.resource ? (Array.isArray(req.resource) ? req.resource : [req.resource]) : [])
		p.append("resource", r);
	return `/authorize?${p.toString()}`;
}

function renderConsent(
	brand: BrandConfig,
	opts: {
		appName: string;
		session: SessionClaims;
		txn: string;
		scopes: readonly string[];
	},
): string {
	const app = escapeHtml(opts.appName);
	const email = escapeHtml(opts.session.email);
	const mailbox = escapeHtml(opts.session.mailbox);
	const scopes = new Set(opts.scopes);
	const abilities = [
		scopes.has("email.read")
			? "<li>Read and search mailboxes you can access</li>"
			: "",
		scopes.has("email.send")
			? `<li>Create and update reviewable drafts for <strong>${mailbox}</strong> or any other mailbox you can access. Sending, moving, and deleting stay in the mail portal.</li>`
			: "",
		scopes.has("quiz.read")
			? "<li>Read team quiz results and submitted answers when you are an active administrator</li>"
			: "",
		scopes.has("quiz.write")
			? "<li>Grade team quiz answers when you are an active administrator</li>"
			: "",
	].join("");
	return pageShell(
		brand,
		`Authorize · ${brand.appName}`,
		`<div class="wrap--center">
  <div class="card card--auth">
    ${brandLogo(brand, { href: "/" })}
    <h2 style="margin-top:18px">Connect ${app} to ${brand.appName}</h2>
    <p class="sub">Signed in as <strong>${email}</strong></p>
    <div class="card" style="margin:8px 0 4px;background:var(--tint)">
      <p class="muted" style="margin:0 0 8px">${app} will be able to:</p>
      <ul style="margin:0;padding-left:18px;font-size:14px;color:var(--slate);line-height:1.7">
        ${abilities}
      </ul>
    </div>
    <form method="post" action="/authorize">
      <input type="hidden" name="txn" value="${escapeHtml(opts.txn)}">
      <button type="submit" name="decision" value="approve" class="block">Authorize ${app}</button>
      <button type="submit" name="decision" value="cancel" class="secondary block" style="margin-top:10px">Cancel</button>
    </form>
    <p class="note">Only authorize applications you trust.</p>
  </div>
</div>`,
	);
}

function renderError(brand: BrandConfig, message: string): string {
	return pageShell(
		brand,
		`Authorization error · ${brand.appName}`,
		`<div class="wrap--center">
  <div class="card card--auth">
    ${brandLogo(brand, { href: "/" })}
    <h2 style="margin-top:18px">Authorization error</h2>
    <div class="err">${escapeHtml(message)}</div>
    <a class="btn secondary block" href="/" style="margin-top:14px">Back to ${brand.appName}</a>
  </div>
</div>`,
	);
}
