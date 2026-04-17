// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import { renderAccessNotConfiguredPage, renderAccessDeniedPage } from "./lib/setup-page";
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

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();

// Cloudflare Access JWT validation middleware (production only)
app.use("*", async (c, next) => {
	if (import.meta.env.DEV) {
		return next();
	}

	const { POLICY_AUD, TEAM_DOMAIN } = c.env;

	// Access not configured — serve a setup instructions page.
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.html(renderAccessNotConfiguredPage(), 500);
	}

	const isApiRequest = c.req.path.startsWith("/api/");
	const isBrowserRequest = !isApiRequest && (
		c.req.header("sec-fetch-mode") === "navigate" ||
		c.req.header("accept")?.includes("text/html") === true
	);

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		if (isBrowserRequest) {
			const returnUrl = c.req.url;
			const { issuer } = getAccessUrls(TEAM_DOMAIN);
			return c.html(renderAccessDeniedPage(issuer, returnUrl), 401);
		}
		return c.json({ error: "Missing required CF Access JWT", code: "ACCESS_TOKEN_MISSING" }, 401, {
			"WWW-Authenticate": `Bearer realm="Cloudflare Access", resource="${c.req.url}"`,
		});
	}

	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = createRemoteJWKSet(certsUrl);
		await jwtVerify(token, JWKS, { issuer, audience: POLICY_AUD });
	} catch {
		if (isBrowserRequest) {
			const returnUrl = c.req.url;
			const { issuer } = getAccessUrls(TEAM_DOMAIN);
			return c.html(renderAccessDeniedPage(issuer, returnUrl), 401);
		}
		return c.json({ error: "Invalid or expired Access token", code: "ACCESS_TOKEN_INVALID" }, 401, {
			"WWW-Authenticate": `Bearer realm="Cloudflare Access", resource="${c.req.url}"`,
		});
	}

	return next();
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
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

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		event: { raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
