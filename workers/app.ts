// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file and at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import { app as apiApp } from "./index";
import { receiveEmailWithNotifications } from "./receive-with-notifications";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";
import { getSessionUser, sessionCookie, expiredSessionCookie, canAccessMailbox, seedAdmin, type AuthUser } from "./lib/auth";
import { listMailboxes } from "./lib/email-helpers";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";
export { UserAuthDO } from "./userAuth";

declare module "react-router" {
	export interface AppLoadContext { cloudflare: { env: Env; ctx: ExecutionContext }; }
}

const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);
const LOGIN_BACKGROUND_KEY = "system/login-background";
const DOMAINS_KEY = "system/email-domains.json";
const DEFAULT_APP_NAME = "Agentic Inbox";
const DEFAULT_DOMAIN = "astratradehk.com";
const app = new Hono<{ Bindings: Env }>();

async function getEmailDomains(env: Env): Promise<string[]> {
	try {
		const object = await env.BUCKET.get(DOMAINS_KEY);
		if (object) {
			const data = await object.json() as { domains?: unknown };
			if (Array.isArray(data.domains)) {
				const domains = data.domains.map((d) => String(d).trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
				if (domains.length) return [...new Set(domains)];
			}
		}
	} catch (error) { console.error("Unable to load stored email domains", error); }
	const raw = env.TEAM_DOMAINS || env.TEAM_DOMAIN || DEFAULT_DOMAIN;
	return [...new Set(raw.split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
}

async function saveEmailDomains(env: Env, domains: string[]) {
	await env.BUCKET.put(DOMAINS_KEY, JSON.stringify({ domains: [...new Set(domains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))] }), { httpMetadata: { contentType: "application/json" } });
}

app.use("/api/*", async (c, next) => {
	if (c.req.path.startsWith("/api/v1/auth/")) return next();
	const user = await getSessionUser(c.env, c.req.raw);
	if (!user) return c.json({ error: "Authentication required" }, 401);
	const path = c.req.path;
	if (path === "/api/v1/mailboxes") {
		if (c.req.method !== "GET" && user.role !== "admin") return c.json({ error: "Administrator permission required" }, 403);
	} else if (path.startsWith("/api/v1/mailboxes/")) {
		const remainder = path.slice("/api/v1/mailboxes/".length); const mailboxId = decodeURIComponent(remainder.split("/")[0] || "");
		if (mailboxId && !canAccessMailbox(user, mailboxId)) return c.json({ error: "You do not have permission to access this mailbox" }, 403);
	}
	return next();
});
const requireMcpAdmin = async (c: any, next: () => Promise<Response>) => { const user = await getSessionUser(c.env, c.req.raw); if (!user) return c.json({ error: "Authentication required" }, 401); if (user.role !== "admin") return c.json({ error: "MCP access is currently restricted to administrators" }, 403); return next(); };
app.use("/mcp", requireMcpAdmin); app.use("/mcp/*", requireMcpAdmin);
async function requireAdmin(c: any): Promise<AuthUser | Response> { const user = await getSessionUser(c.env, c.req.raw); if (!user) return c.json({ error: "Authentication required" }, 401); if (user.role !== "admin") return c.json({ error: "Administrator permission required" }, 403); return user; }

app.get("/api/v1/auth/config", async (c) => { const domains = await getEmailDomains(c.env); return c.json({ appName: (c.env.APP_NAME || DEFAULT_APP_NAME).trim() || DEFAULT_APP_NAME, teamDomain: domains[0] || DEFAULT_DOMAIN, domains }); });
app.get("/api/v1/auth/login-background", async (c) => { const object = await c.env.BUCKET.get(LOGIN_BACKGROUND_KEY); if (!object) return c.body(null, 404); const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("Cache-Control", "public, max-age=300"); return new Response(object.body, { headers }); });
app.post("/api/v1/auth/register", async (c) => {
	const body = await c.req.json().catch(() => null) as Record<string, unknown> | null; const email = String(body?.email ?? "").trim().toLowerCase(); const name = String(body?.name ?? "").trim(); const password = String(body?.password ?? ""); const domains = await getEmailDomains(c.env); const domain = email.split("@")[1] || ""; const adminEmail = (c.env.ADMIN_EMAIL || "admin@astratradehk.com").trim().toLowerCase();
	if (!email || !name || password.length < 8) return c.json({ error: "Name, company email and an 8+ character password are required" }, 400); if (!domains.includes(domain)) return c.json({ error: "Registration is restricted to the company email domain" }, 403); if (email === adminEmail) return c.json({ error: "This address is reserved for the administrator" }, 403);
	try { await seedAdmin(c.env); } catch (error) { console.error("Admin bootstrap failed during registration", error); return c.json({ error: error instanceof Error ? error.message : "Admin initialization failed" }, 500); }
	const stub = c.env.USER_AUTH.get(c.env.USER_AUTH.idFromName("global")); const response = await stub.fetch("https://user-auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, name, password }) }); return new Response(response.body, response);
});
app.post("/api/v1/auth/login", async (c) => { const body = await c.req.json().catch(() => null) as Record<string, unknown> | null; const email = String(body?.email ?? "").trim().toLowerCase(); const password = String(body?.password ?? ""); try { await seedAdmin(c.env); } catch (error) { console.error("Admin bootstrap failed during login", error); return c.json({ error: error instanceof Error ? error.message : "Admin initialization failed" }, 500); } const stub = c.env.USER_AUTH.get(c.env.USER_AUTH.idFromName("global")); const response = await stub.fetch("https://user-auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) }); if (!response.ok) return new Response(response.body, response); const data = await response.json() as { token: string; user: AuthUser }; return new Response(JSON.stringify({ user: data.user }), { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookie(data.token) } }); });
app.get("/api/v1/auth/me", async (c) => { const user = await getSessionUser(c.env, c.req.raw); if (!user) return c.json({ error: "Not authenticated" }, 401); return c.json({ user }); });
app.post("/api/v1/auth/logout", async (c) => { const cookie = c.req.header("Cookie") || ""; const token = cookie.split(";").map((p) => p.trim()).find((p) => p.startsWith("agentic_session="))?.split("=").slice(1).join("="); if (token) { const stub = c.env.USER_AUTH.get(c.env.USER_AUTH.idFromName("global")); await stub.fetch("https://user-auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }); } return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": expiredSessionCookie() } }); });
app.get("/api/v1/admin/users", async (c) => { const admin = await requireAdmin(c); if (admin instanceof Response) return admin; const stub = c.env.USER_AUTH.get(c.env.USER_AUTH.idFromName("global")); const response = await stub.fetch("https://user-auth/admin/users"); return new Response(response.body, response); });
app.post("/api/v1/admin/approve", async (c) => { const admin = await requireAdmin(c); if (admin instanceof Response) return admin; const body = await c.req.json().catch(() => null) as Record<string, unknown> | null; const email = String(body?.email ?? "").trim().toLowerCase(); const stub = c.env.USER_AUTH.get(c.env.USER_AUTH.idFromName("global")); const response = await stub.fetch("https://user-auth/admin/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }); if (!response.ok) return new Response(response.body, response); const data = await response.json() as { user?: { email: string; name: string } }; if (data.user) { const key = `mailboxes/${data.user.email}.json`; if (!(await c.env.BUCKET.head(key))) { const settings = { fromName: data.user.name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } }; await c.env.BUCKET.put(key, JSON.stringify(settings)); const mailbox = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(data.user.email)); await mailbox.getFolders(); } } return c.json(data); });
app.post("/api/v1/admin/status", async (c) => { const admin = await requireAdmin(c); if (admin instanceof Response) return admin; const body = await c.req.json().catch(() => null) as Record<string, unknown> | null; const email = String(body?.email ?? "").trim().toLowerCase(); const status = String(body?.status ?? ""); const stub = c.env.USER_AUTH.get(c.env.USER_AUTH.idFromName("global")); const response = await stub.fetch("https://user-auth/admin/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, status }) }); return new Response(response.body, response); });
app.post("/api/v1/admin/reset-password", async (c) => { const admin = await requireAdmin(c); if (admin instanceof Response) return admin; const body = await c.req.json().catch(() => null) as Record<string, unknown> | null; const email = String(body?.email ?? "").trim().toLowerCase(); const password = String(body?.password ?? ""); const name = String(body?.name ?? "").trim() || email.split("@")[0]; const stub = c.env.USER_AUTH.get(c.env.USER_AUTH.idFromName("global")); const response = await stub.fetch("https://user-auth/admin/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, name }) }); return new Response(response.body, response); });
app.get("/api/v1/admin/domains", async (c) => { const admin = await requireAdmin(c); if (admin instanceof Response) return admin; return c.json({ domains: await getEmailDomains(c.env) }); });
app.post("/api/v1/admin/domains", async (c) => { const admin = await requireAdmin(c); if (admin instanceof Response) return admin; const body = await c.req.json().catch(() => null) as Record<string, unknown> | null; const domain = String(body?.domain ?? "").trim().toLowerCase().replace(/^@/, ""); if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain)) return c.json({ error: "Invalid domain" }, 400); const domains = await getEmailDomains(c.env); if (!domains.includes(domain)) domains.push(domain); await saveEmailDomains(c.env, domains); return c.json({ domains }); });
app.delete("/api/v1/admin/domains", async (c) => { const admin = await requireAdmin(c); if (admin instanceof Response) return admin; const body = await c.req.json().catch(() => null) as Record<string, unknown> | null; const domain = String(body?.domain ?? "").trim().toLowerCase().replace(/^@/, ""); const domains = await getEmailDomains(c.env); if (domains.length <= 1 && domains.includes(domain)) return c.json({ error: "At least one email domain must remain" }, 400); const next = domains.filter((d) => d !== domain); await saveEmailDomains(c.env, next); return c.json({ domains: next }); });
app.post("/api/v1/admin/login-background", async (c) => { const admin = await requireAdmin(c); if (admin instanceof Response) return admin; const form = await c.req.raw.formData().catch(() => null); const file = form?.get("file"); if (!(file instanceof File)) return c.json({ error: "Image file is required" }, 400); if (!file.type.startsWith("image/")) return c.json({ error: "Only image files are allowed" }, 400); if (file.size > 5 * 1024 * 1024) return c.json({ error: "Image must be 5 MB or smaller" }, 400); await c.env.BUCKET.put(LOGIN_BACKGROUND_KEY, file.stream(), { httpMetadata: { contentType: file.type } }); return c.json({ ok: true }); });
app.delete("/api/v1/admin/login-background", async (c) => { const admin = await requireAdmin(c); if (admin instanceof Response) return admin; await c.env.BUCKET.delete(LOGIN_BACKGROUND_KEY); return c.json({ ok: true }); });
app.get("/api/v1/mailboxes", async (c) => { const user = await getSessionUser(c.env, c.req.raw); if (!user) return c.json({ error: "Authentication required" }, 401); const allMailboxes = await listMailboxes(c.env.BUCKET); const visible = user.role === "admin" ? allMailboxes : allMailboxes.filter((m) => m.id.toLowerCase() === user.email.toLowerCase()); return c.json(visible.map((m) => ({ ...m, name: m.id })));
});
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext));
app.all("/mcp/*", async (c) => mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext));
app.route("/", apiApp);

// Agent authentication is handled by routeAgentRequest's WebSocket-aware hooks.
// This is important for same-origin browser WebSockets: the Agent SDK performs
// the upgrade after these hooks run, while preserving the request/cookie context.
async function authorizeAgentRequest(request: Request, env: Env): Promise<Response | undefined> {
	const user = await getSessionUser(env, request);
	if (!user) return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });

	// /agents/EmailAgent/:mailboxId/... — keep the same mailbox authorization
	// rules used by the REST API.
	const pathname = new URL(request.url).pathname;
	const parts = pathname.split("/").filter(Boolean);
	const mailboxId = parts.length >= 3 && parts[0] === "agents" ? decodeURIComponent(parts[2] || "") : "";
	if (mailboxId && !canAccessMailbox(user, mailboxId)) {
		return new Response(JSON.stringify({ error: "You do not have permission to access this mailbox" }), { status: 403, headers: { "Content-Type": "application/json" } });
	}
}

app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env, {
		onBeforeConnect: (request) => authorizeAgentRequest(request, c.env),
		onBeforeRequest: (request) => authorizeAgentRequest(request, c.env),
	});
	if (response) return response;
	return c.text("Agent not found", 404);
});
app.all("*", (c) => requestHandler(c.req.raw, { cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext } }));
export default { fetch: app.fetch, async email(event: { raw: ReadableStream; rawSize: number; forward: (target: string) => Promise<void> }, env: Env, ctx: ExecutionContext) { try { await receiveEmailWithNotifications(event, env, ctx); } catch (e) { console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack); throw e; } } };