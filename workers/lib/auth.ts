import type { Context } from "hono";
import type { Env } from "../types";

export interface AuthUser { email: string; name: string; role: "admin" | "employee"; }
export type AuthContext = Context<{ Bindings: Env; Variables: { user: AuthUser } }>;
const SESSION_COOKIE = "agentic_session";

export function getSessionToken(request: Request): string | null {
	const cookie = request.headers.get("Cookie") || "";
	for (const part of cookie.split(";")) { const [name, ...rest] = part.trim().split("="); if (name === SESSION_COOKIE) return rest.join("=") || null; }
	return null;
}

// The server-side session remains valid for 7 days, but the browser cookie is
// now a session cookie. Closing the browser removes the cookie, so the next
// browser session requires a fresh login. The user can also explicitly sign out.
export function sessionCookie(token: string): string { return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`; }
export function expiredSessionCookie(): string { return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`; }

export async function getSessionUser(env: Env, request: Request): Promise<AuthUser | null> {
	const token = getSessionToken(request); if (!token) return null;
	const stub = env.USER_AUTH.get(env.USER_AUTH.idFromName("global"));
	const response = await stub.fetch("https://user-auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
	if (!response.ok) return null; return (await response.json() as { user: AuthUser }).user;
}
export async function requireUser(c: AuthContext, next: () => Promise<Response>): Promise<Response> { const user = await getSessionUser(c.env, c.req.raw); if (!user) return c.json({ error: "Authentication required" }, 401); c.set("user", user); return next(); }
export function canAccessMailbox(user: AuthUser, mailboxId: string): boolean { return user.role === "admin" || user.email.toLowerCase() === mailboxId.toLowerCase(); }
export function isAdmin(user: AuthUser): boolean { return user.role === "admin"; }

export async function seedAdmin(env: Env): Promise<void> {
	if (!env.ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD is not configured");
	const email = (env.ADMIN_EMAIL || "admin@astratradehk.com").trim().toLowerCase();
	const stub = env.USER_AUTH.get(env.USER_AUTH.idFromName("global"));
	const response = await stub.fetch("https://user-auth/seed-admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: env.ADMIN_PASSWORD }) });
	if (!response.ok) { const detail = await response.text().catch(() => ""); throw new Error(`Admin initialization failed (${response.status})${detail ? `: ${detail}` : ""}`); }
	const key = `mailboxes/${email}.json`;
	if (!(await env.BUCKET.head(key))) { const settings = { fromName: "Administrator", forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } }; await env.BUCKET.put(key, JSON.stringify(settings)); const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(email)); await mailbox.getFolders(); }
}