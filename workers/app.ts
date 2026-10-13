// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { getAgentByName, routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { handleEmailSendingQueueBatch } from "./lib/email-sending-queue";
import { EmailMCP } from "./mcp";
import { verifyMobileSessionToken } from "./lib/apple-auth";
import {
	authorizeMailbox,
	devWebPrincipal,
	principalFromClaims,
	type RequestPrincipal,
} from "./lib/mailbox-acl";
import { expandPrincipalWithLinks } from "./lib/identity-links";
import { canonicalMailboxId } from "./lib/mailbox-routing";
import { PASSWORD_SESSION_COOKIE } from "./lib/password-auth";
import { mailboxIdFromAgentsUrl } from "../shared/agent-conversations";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

import { isPublicAuthPath } from "./lib/auth-paths";

export { isPublicAuthPath };

function readCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const trimmed = part.trim();
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		if (trimmed.slice(0, eq) !== name) continue;
		try {
			return decodeURIComponent(trimmed.slice(eq + 1));
		} catch {
			return trimmed.slice(eq + 1);
		}
	}
	return undefined;
}

/** Access JWT from the edge header, or the CF_Authorization cookie after a path bypass. */
function getAccessJwt(c: { req: { header: (name: string) => string | undefined } }): string | undefined {
	return (
		c.req.header("cf-access-jwt-assertion") ||
		readCookie(c.req.header("cookie"), "CF_Authorization")
	);
}

async function verifyCfAccessToken(
	token: string,
	env: Env,
): Promise<JWTPayload | null> {
	const { POLICY_AUD, TEAM_DOMAIN } = env;
	if (!POLICY_AUD || !TEAM_DOMAIN) return null;
	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = createRemoteJWKSet(certsUrl);
		const { payload } = await jwtVerify(token, JWKS, {
			issuer,
			audience: POLICY_AUD,
		});
		return payload;
	} catch {
		return null;
	}
}

type AppVariables = { principal?: RequestPrincipal };
type ExecutionCtxWithProps = ExecutionContext & {
	props?: { principal?: RequestPrincipal };
};

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Auth middleware: Cloudflare Access (web) OR mobile Bearer JWT OR password session cookie.
// Auth bootstrap + invite endpoints are public. DEV still attaches a principal so ACL is exercised.
app.use("*", async (c, next) => {
	const pathname = new URL(c.req.url).pathname;
	if (isPublicAuthPath(pathname)) {
		return next();
	}

	const { POLICY_AUD, TEAM_DOMAIN, MOBILE_JWT_SECRET } = c.env;

	const accessToken = getAccessJwt(c);
	if (accessToken) {
		if (!POLICY_AUD || !TEAM_DOMAIN) {
			if (!import.meta.env.DEV) {
				return c.text(
					"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
					500,
				);
			}
			// Local wrangler often has no Access config; ignore leftover cookies.
		} else {
			const payload = await verifyCfAccessToken(accessToken, c.env);
			if (!payload) {
				return c.text("Invalid or expired Access token", 403);
			}
			const principal = await expandPrincipalWithLinks(
				c.env.BUCKET,
				principalFromClaims(payload),
			);
			c.set("principal", principal);
			return next();
		}
	}

	const authHeader = c.req.header("authorization");
	const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
	const cookieSession = readCookie(c.req.header("cookie"), PASSWORD_SESSION_COOKIE);
	const sessionToken = bearer || cookieSession;
	if (sessionToken) {
		const mobileSecret =
			MOBILE_JWT_SECRET ||
			(import.meta.env.DEV ? "dev-mobile-jwt-secret-change-me" : "");
		if (!mobileSecret) {
			return c.text(
				"Mobile auth is not configured. Set MOBILE_JWT_SECRET.",
				500,
			);
		}
		try {
			const claims = await verifyMobileSessionToken(sessionToken, mobileSecret);
			const principal = await expandPrincipalWithLinks(
				c.env.BUCKET,
				principalFromClaims(claims),
			);
			c.set("principal", principal);
			return next();
		} catch {
			if (bearer) {
				return c.text("Invalid or expired mobile session token", 403);
			}
			// Invalid password cookie: fall through to Access / DEV / fail-closed.
		}
	}

	if (import.meta.env.DEV) {
		c.set("principal", await expandPrincipalWithLinks(c.env.BUCKET, devWebPrincipal()));
		return next();
	}

	// Fail closed: require Access config message if neither token present
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
			500,
		);
	}

	return c.text(
		"Missing authentication. Provide cf-access-jwt-assertion or Authorization: Bearer <mobile-token>.",
		403,
	);
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
function mcpFetch(c: { req: { raw: Request }; env: Env; executionCtx: ExecutionContext; get: (key: "principal") => RequestPrincipal | undefined }) {
	const ctx = c.executionCtx as ExecutionCtxWithProps;
	ctx.props = { principal: c.get("principal") };
	return mcpHandler.fetch(c.req.raw, c.env, ctx);
}
app.all("/mcp", async (c) => mcpFetch(c));
app.all("/mcp/*", async (c) => mcpFetch(c));

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	const mailboxId = mailboxIdFromAgentsUrl(c.req.url);
	// The agent's tools act on this raw string, so it must already be the
	// canonical id that gets authorized: no %-escapes, +tags or <brackets>.
	if (!mailboxId || mailboxId.includes("%") || canonicalMailboxId(mailboxId) !== mailboxId) {
		return c.json({ error: "Forbidden" }, 403);
	}
	const authz = await authorizeMailbox(c.env.BUCKET, c.get("principal"), mailboxId);
	if (!authz.ok) {
		return c.json({ error: authz.error }, authz.status);
	}
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with email + queue handlers
export default {
	fetch: app.fetch,
	async email(
		message: ForwardableEmailMessage,
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(message, env, ctx, getAgentByName);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
	async queue(batch: MessageBatch<unknown>, env: Env) {
		await handleEmailSendingQueueBatch(batch, env);
	},
};
