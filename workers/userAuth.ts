// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

const PBKDF2_ITERATIONS = 120_000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

interface UserRecord {
	email: string;
	name: string;
	role: "admin" | "employee";
	status: "pending" | "active" | "disabled";
	password_hash: string;
	created_at: string;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hashPassword(password: string, salt?: Uint8Array): Promise<string> {
	const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: actualSalt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, key, 256);
	return `${bytesToBase64(actualSalt)}:${bytesToBase64(new Uint8Array(bits))}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [saltText, expectedText] = stored.split(":");
	if (!saltText || !expectedText) return false;
	const actual = await hashPassword(password, base64ToBytes(saltText));
	return timingSafeEqual(actual.split(":")[1], expectedText);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return result === 0;
}

function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }
function publicUser(row: any) { return { email: row.email, name: row.name, role: row.role, status: row.status, createdAt: row.created_at }; }
function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class UserAuthDO extends DurableObject<Env> {
	private initialized = false;

	private init() {
		if (this.initialized) return;
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS users (
				email TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				role TEXT NOT NULL,
				status TEXT NOT NULL,
				password_hash TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS sessions (
				token TEXT PRIMARY KEY,
				email TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
		`);
		this.initialized = true;
	}

	private cleanupSessions() { this.ctx.storage.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", Math.floor(Date.now() / 1000)); }

	async fetch(request: Request): Promise<Response> {
		this.init();
		this.cleanupSessions();
		const url = new URL(request.url);
		const body = request.method === "POST" ? await request.json().catch(() => ({})) as Record<string, unknown> : {};

		if (url.pathname === "/seed-admin" && request.method === "POST") {
			const email = normalizeEmail(String(body.email ?? ""));
			const password = String(body.password ?? "");
			if (!email || password.length < 8) return Response.json({ error: "Invalid admin credentials" }, { status: 400 });
			const existing = this.ctx.storage.sql.exec("SELECT * FROM users WHERE email = ?", email).toArray()[0] as UserRecord | undefined;
			if (!existing) {
				const passwordHash = await hashPassword(password);
				this.ctx.storage.sql.exec("INSERT INTO users (email,name,role,status,password_hash,created_at) VALUES (?,?,?,?,?,?)", email, "Administrator", "admin", "active", passwordHash, new Date().toISOString());
			} else if (existing.role !== "admin") {
				const passwordHash = await hashPassword(password);
				this.ctx.storage.sql.exec("UPDATE users SET name='Administrator', role='admin', status='active', password_hash=? WHERE email = ?", passwordHash, email);
			} else {
				this.ctx.storage.sql.exec("UPDATE users SET status='active' WHERE email = ?", email);
			}
			return Response.json({ ok: true });
		}

		if (url.pathname === "/register" && request.method === "POST") {
			const email = normalizeEmail(String(body.email ?? ""));
			const name = String(body.name ?? "").trim();
			const password = String(body.password ?? "");
			if (!email || !name || password.length < 8) return Response.json({ error: "Name, email and an 8+ character password are required" }, { status: 400 });
			if (!email.includes("@")) return Response.json({ error: "Invalid email address" }, { status: 400 });
			if (this.ctx.storage.sql.exec("SELECT email FROM users WHERE email = ?", email).toArray().length > 0) return Response.json({ error: "An account with this email already exists" }, { status: 409 });
			const passwordHash = await hashPassword(password);
			this.ctx.storage.sql.exec("INSERT INTO users (email,name,role,status,password_hash,created_at) VALUES (?,?,?,?,?,?)", email, name, "employee", "pending", passwordHash, new Date().toISOString());
			return Response.json({ status: "pending" }, { status: 201 });
		}

		if (url.pathname === "/login" && request.method === "POST") {
			const email = normalizeEmail(String(body.email ?? ""));
			const password = String(body.password ?? "");
			const row = this.ctx.storage.sql.exec("SELECT * FROM users WHERE email = ?", email).toArray()[0] as UserRecord | undefined;
			if (!row || !(await verifyPassword(password, row.password_hash))) return Response.json({ error: "Invalid email or password" }, { status: 401 });
			if (row.status !== "active") return Response.json({ error: row.status === "pending" ? "Your account is awaiting administrator approval" : "Your account is disabled" }, { status: 403 });
			const token = randomToken();
			const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
			this.ctx.storage.sql.exec("INSERT INTO sessions (token,email,expires_at) VALUES (?,?,?)", token, email, expiresAt);
			return Response.json({ token, user: { email: row.email, name: row.name, role: row.role } });
		}

		if (url.pathname === "/session" && request.method === "POST") {
			const token = String(body.token ?? "");
			const row = this.ctx.storage.sql.exec("SELECT u.email,u.name,u.role,u.status,s.expires_at FROM sessions s JOIN users u ON u.email=s.email WHERE s.token=?", token).toArray()[0] as (UserRecord & { expires_at: number }) | undefined;
			if (!row || row.expires_at <= Math.floor(Date.now() / 1000) || row.status !== "active") return Response.json({ error: "Invalid session" }, { status: 401 });
			return Response.json({ user: { email: row.email, name: row.name, role: row.role } });
		}

		if (url.pathname === "/logout" && request.method === "POST") {
			const token = String(body.token ?? "");
			this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token = ?", token);
			return Response.json({ ok: true });
		}

		if (url.pathname === "/admin/users" && request.method === "GET") {
			const users = this.ctx.storage.sql.exec("SELECT email,name,role,status,created_at FROM users ORDER BY created_at ASC").toArray();
			return Response.json({ users: users.map(publicUser) });
		}
		if (url.pathname === "/admin/approve" && request.method === "POST") {
			const email = normalizeEmail(String(body.email ?? ""));
			this.ctx.storage.sql.exec("UPDATE users SET status='active' WHERE email=? AND role='employee'", email);
			const row = this.ctx.storage.sql.exec("SELECT email,name,role,status,created_at FROM users WHERE email=?", email).toArray()[0];
			return row ? Response.json({ user: publicUser(row) }) : Response.json({ error: "User not found" }, { status: 404 });
		}
		if (url.pathname === "/admin/status" && request.method === "POST") {
			const email = normalizeEmail(String(body.email ?? ""));
			const status = String(body.status ?? "");
			if (!["active", "disabled", "pending"].includes(status)) return Response.json({ error: "Invalid status" }, { status: 400 });
			this.ctx.storage.sql.exec("UPDATE users SET status=? WHERE email=? AND role='employee'", status, email);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/admin/reset-password" && request.method === "POST") {
			const email = normalizeEmail(String(body.email ?? ""));
			const password = String(body.password ?? "");
			if (password.length < 8) return Response.json({ error: "Password must be at least 8 characters" }, { status: 400 });
			const passwordHash = await hashPassword(password);
			this.ctx.storage.sql.exec("UPDATE users SET password_hash=? WHERE email=? AND role='employee'", passwordHash, email);
			this.ctx.storage.sql.exec("DELETE FROM sessions WHERE email=?", email);
			return Response.json({ ok: true });
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	}
}