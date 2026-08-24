// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";
import { getSessionUser, sessionCookie, expiredSessionCookie, canAccessMailbox, seedAdmin, type AuthUser } from "./lib/auth";
import { listMailboxes } from "./lib/email-helpers";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";
export { UserAuthDO } from "./userAuth";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath) ? teamUrl : new URL(certsPath, issuer);
	return { issuer, certsUrl };
}

const app = new Hono<{ Bindings: Env }>();

// Cloudflare Access remains the outer security layer. The application
// authentication below adds the mailbox-level identity and authorization model.
app.use("*", async (c, next) => {
	if (import.meta.env.DEV) return next();
	const { POLICY_AUD, TEAM_DOMAIN } = c.env;
	if (!POLICY_AUD || !TEAM_DOMAIN) return c.text("Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.", 500);
	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) return c.text("Missing required CF Access JWT", 403);
	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = createRemoteJWKSet(certsUrl);
		await jwtVerify(token, JWKS, { issuer, audience: POLICY_AUD });
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}
	return next();
});

// Application authentication and authorization. Auth endpoints are public to the
// application layer; all other API endpoints require a valid application session.
app.use("/api/*", async (c, next) => {
	if (c.req.path.startsWith("/api/v1/auth/")) return next();
	const user = await getSessionUser(c.env, c.req.raw);
	if (!user) return c.json({ error: "Authentication required" }, 401);
	const path = c.req.path;
	if (path === "/api/v1/mailboxes") {
		if (c.req.method !== "GET" && user.role !== "admin") return c.json({ error: "Administrator permission required" }, 403);
	} else if (path.startsWith("/api/v1/mailboxes/")) {
		const remainder = path.slice("/api/v1/mailboxes/".length);
		const mailboxId = decodeURIComponent(remainder.split("/")[0] || "");
		if (mailboxId && !canAccessMailbox(user, mailboxId)) return c.json({ error: "You do not have permission to access this mailbox" }, 403);
	}
	return next();
});

// Auth API. The user database and sessions live in an isolated SQLite-backed DO.
app.post("/api/v1/auth/register", async (c) => {
	const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
	const email = String(body?.email ?? "").trim().toLowerCase();
	const name = String(body?.name ?? "").trim();
	const password = String(body?.password ?? "");
	const domains = (c.env.DOMAINS || "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
	const domain = email.split("@")[1] || "";
	if (!email || !name || password.length < 8) return c.json({ error: "Name, company email and an 8+ character password are required" }, 400);
	if (!domains.some((d) => domain === d)) return c.json({ error: "Registration is restricted to the company email domain" }, 403);
	await seedAdmin(c.env);
	const stub = c.env.USER_AUTH.get(c.env.USER_AUTH.idFromName("global"));
	const response = await stub.fetch("https://user-auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, name, password }) });
	return new Response(response.body, response);
});

app.post("/api/v1/auth/login", async (c) => {
	const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
	const email = String(body?.email ?? "").trim().toLowerCase();
	const password = String(body?.password ?? "");
	await seedAdmin(c.env);
	const stub = c.env.USER_AUTH.get(c.env.USER_AUTH.idFromName("global"));
	const response = await stub.fetch("https://user-auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
	if (!response.ok) return new Response(response.body, response);
	const data = await response.json() as { token: string; user: AuthUser };
	return new Response(JSON.stringify({ user: data.user }), { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookie(data.token) } });
});

app.get("/api/v1/auth/me", async (c) => {
	const user = await getSessionUser(c.env, c.req.raw);
	if (!user) return c.json({ error: "Not authenticated" }, 401);
	return c.json({ user });
});

app.post("/api/v1/auth/logout", async (c) => {
	const cookie = c.req.header("Cookie") || "";
	const token = cookie.split(";").map((p) => p.trim()).find((p) => p.startsWith("agentic_session="))?.split("=").slice(1).join("=");
	if (token) {
		const stub = c.env.USER_AUTH.get(c.env.USER_AUTH.idFromName("global"));
		await stub.fetch("https://user-auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
	}
	return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": expiredSessionCookie() } });
});

// Mailbox directory is handled here so employees never receive the full list.
app.get("/api/v1/mailboxes", async (c) => {
	const user = await getSessionUser(c.env, c.req.raw);
	if (!user) return c.json({ error: "Authentication required" }, 401);
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	const visible = user.role === "admin" ? allMailboxes : allMailboxes.filter((m) => m.id.toLowerCase() === user.email.toLowerCase());
	return c.json(visible.map((m) => ({ ...m, name: m.id })));
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext));
app.all("/mcp/*", async (c) => mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext));

app.route("/", apiApp);

app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

app.all("*", (c) => requestHandler(c.req.raw, { cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext } }));

export default {
	fetch: app.fetch,
	async email(event: { raw: ReadableStream; rawSize: number }, env: Env, ctx: ExecutionContext) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			throw e;
		}
	},
};
