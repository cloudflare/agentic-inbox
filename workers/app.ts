// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import { verifyMobileSessionToken } from "./lib/apple-auth";
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

function isPublicAuthPath(pathname: string): boolean {
	return (
		pathname === "/api/v1/auth/apple" ||
		pathname === "/api/v1/auth/dev"
	);
}

async function verifyCfAccessToken(
	token: string,
	env: Env,
): Promise<boolean> {
	const { POLICY_AUD, TEAM_DOMAIN } = env;
	if (!POLICY_AUD || !TEAM_DOMAIN) return false;
	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = createRemoteJWKSet(certsUrl);
		await jwtVerify(token, JWKS, {
			issuer,
			audience: POLICY_AUD,
		});
		return true;
	} catch {
		return false;
	}
}

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();

// Auth middleware: Cloudflare Access (web) OR mobile Bearer JWT (iOS Apple Sign In).
// Skipped in local development. Auth bootstrap endpoints are public.
app.use("*", async (c, next) => {
	if (import.meta.env.DEV) {
		return next();
	}

	if (isPublicAuthPath(new URL(c.req.url).pathname)) {
		return next();
	}

	const { POLICY_AUD, TEAM_DOMAIN, MOBILE_JWT_SECRET } = c.env;

	const accessToken = c.req.header("cf-access-jwt-assertion");
	if (accessToken) {
		if (!POLICY_AUD || !TEAM_DOMAIN) {
			return c.text(
				"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
				500,
			);
		}
		const ok = await verifyCfAccessToken(accessToken, c.env);
		if (!ok) {
			return c.text("Invalid or expired Access token", 403);
		}
		return next();
	}

	const authHeader = c.req.header("authorization");
	const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
	if (bearer) {
		if (!MOBILE_JWT_SECRET) {
			return c.text(
				"Mobile auth is not configured. Set MOBILE_JWT_SECRET.",
				500,
			);
		}
		try {
			await verifyMobileSessionToken(bearer, MOBILE_JWT_SECRET);
			return next();
		} catch {
			return c.text("Invalid or expired mobile session token", 403);
		}
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
