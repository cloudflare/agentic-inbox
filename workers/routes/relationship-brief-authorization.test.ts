import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import { requireMailbox, type MailboxContext } from "../lib/mailbox.ts";
import type { Env } from "../types.ts";
import { createRelationshipBriefRoutes } from "./relationship-brief.ts";

class Statement {
	#values: unknown[] = [];
	readonly database: DatabaseSync;
	readonly sql: string;
	constructor(database: DatabaseSync, sql: string) {
		this.database = database;
		this.sql = sql;
	}
	bind(...values: unknown[]) { this.#values = values; return this; }
	async first<T>() { return (this.statement().get(...this.#values) as T | undefined) ?? null; }
	async all<T>() { return { success: true, results: this.statement().all(...this.#values) as T[] }; }
	async raw<T extends unknown[]>() { return this.statement().all(...this.#values).map((row) => Object.values(row)) as T[]; }
	async run() { const result = this.statement().run(...this.#values); return { success: true, meta: { changes: Number(result.changes) } }; }
	private statement(): StatementSync { return this.database.prepare(this.sql); }
}

function d1(database: DatabaseSync): D1Database {
	return { prepare: (sql: string) => new Statement(database, sql) } as unknown as D1Database;
}

function fixture() {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	for (const migration of [
		"0001_create_users.sql",
		"0003_create_mailbox_access.sql",
		"0005_auth_security.sql",
		"0006_credential_recovery.sql",
	]) database.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));
	database.exec(`
		INSERT INTO users
		 (id, email, password_hash, password_salt, role, is_active, mailbox_address,
		  session_version, created_at, updated_at)
		VALUES
		 ('owner', 'owner@example.com', 'hash', 'salt', 'AGENT', 1, 'owner@example.com', 1, 1, 1),
		 ('member', 'member@example.com', 'hash', 'salt', 'AGENT', 1, 'member@example.com', 1, 1, 1),
		 ('nonmember', 'nonmember@example.com', 'hash', 'salt', 'AGENT', 1, 'nonmember@example.com', 1, 1, 1),
		 ('admin', 'admin@example.com', 'hash', 'salt', 'ADMIN', 1, 'admin@example.com', 1, 1, 1);
		INSERT INTO mailboxes
		 (id, address, type, owner_user_id, is_active, created_at, updated_at)
		VALUES
		 ('owner@example.com', 'owner@example.com', 'PERSONAL', 'owner', 1, 1, 1),
		 ('team@example.com', 'team@example.com', 'SHARED', NULL, 1, 1, 1);
		INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at)
		VALUES ('team@example.com', 'member', 1);
	`);
	let session: SessionClaims | undefined;
	let runs = 0;
	let revoke = false;
	const stub = { relationship: true };
	const env = {
		DB: d1(database),
		BUCKET: { head: async () => ({ exists: true }) },
		MAILBOX: { idFromName: (name: string) => name, get: () => stub },
	} as unknown as Env;
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => { if (session) c.set("session", session); await next(); });
	app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);
	app.route("/", createRelationshipBriefRoutes({
		run: async () => {
			runs += 1;
			if (revoke) database.prepare(
				"DELETE FROM mailbox_memberships WHERE mailbox_id = ? AND user_id = ?",
			).run("team@example.com", "member");
			return { state: "unavailable" };
		},
	}));
	return {
		database,
		get runs() { return runs; },
		setSession(userId: "owner" | "member" | "nonmember" | "admin") {
			session = {
				sub: userId,
				email: `${userId}@example.com`,
				role: userId === "admin" ? "ADMIN" : "AGENT",
				mailbox: `${userId}@example.com`,
				sessionVersion: 1,
			};
		},
		revoke() { revoke = true; },
		request(mailbox: string, body = JSON.stringify({ refresh: false })) {
			return app.request(
				`/api/v1/mailboxes/${mailbox}/people/person-1/relationship-brief`,
				{ method: "POST", headers: { "content-type": "application/json" }, body },
				env,
			);
		},
	};
}

test("mounted relationship brief allows Personal owners and current Shared members", async () => {
	const state = fixture();
	state.setSession("owner");
	assert.equal((await state.request("owner%40example.com")).status, 200);
	state.setSession("member");
	assert.equal((await state.request("team%40example.com")).status, 200);
	assert.equal(state.runs, 2);
	state.database.close();
});

test("nonmember access fails before malformed body consumption or runtime", async () => {
	const state = fixture();
	state.setSession("nonmember");
	const response = await state.request("team%40example.com", "not-json-private-body");
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
	assert.equal(state.runs, 0);
	state.database.close();
});

test("an administrator runs the brief on mailboxes they neither own nor belong to", async () => {
	const state = fixture();
	state.setSession("admin");
	assert.equal((await state.request("team%40example.com")).status, 200);
	assert.equal((await state.request("owner%40example.com")).status, 200);
	assert.equal(state.runs, 2);
	state.database.close();
});

test("mounted relationship brief suppresses output after in-flight Shared revocation", async () => {
	const state = fixture();
	state.setSession("member");
	state.revoke();
	const response = await state.request("team%40example.com");
	assert.equal(state.runs, 1);
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
	state.database.close();
});
