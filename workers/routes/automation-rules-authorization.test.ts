import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import { requireMailbox, type MailboxContext } from "../lib/mailbox.ts";
import type { Env } from "../types.ts";
import { automationRuleRoutes } from "./automation-rules.ts";

class Statement {
	#values: unknown[] = [];
	readonly #database: DatabaseSync;
	readonly #sql: string;
	constructor(database: DatabaseSync, sql: string) {
		this.#database = database;
		this.#sql = sql;
	}
	bind(...values: unknown[]) { this.#values = values; return this; }
	async first<T>() { return (this.statement().get(...this.#values) as T | undefined) ?? null; }
	async all<T>() { return { success: true, results: this.statement().all(...this.#values) as T[] }; }
	async raw<T extends unknown[]>() {
		return this.statement().all(...this.#values).map((row) => Object.values(row)) as T[];
	}
	async run() {
		const result = this.statement().run(...this.#values);
		return { success: true, meta: { changes: Number(result.changes) } };
	}
	private statement(): StatementSync { return this.#database.prepare(this.#sql); }
}

function d1(database: DatabaseSync): D1Database {
	return { prepare: (sql: string) => new Statement(database, sql) } as unknown as D1Database;
}

const EMPTY_RULES = { rules: [], rulesetGeneration: 0, orderRevision: 0 };
const definition = {
	schemaVersion: 1,
	name: "Everything",
	match: "all",
	conditions: [{ kind: "every_incoming" }],
	actions: [{ kind: "star" }],
	stopProcessing: false,
};

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
		 ('admin-member', 'admin-member@example.com', 'hash', 'salt', 'ADMIN', 1, 'admin-member@example.com', 1, 1, 1),
		 ('admin', 'admin@example.com', 'hash', 'salt', 'ADMIN', 1, 'admin@example.com', 1, 1, 1),
		 ('nonmember', 'nonmember@example.com', 'hash', 'salt', 'AGENT', 1, 'nonmember@example.com', 1, 1, 1);
		INSERT INTO mailboxes
		 (id, address, type, owner_user_id, is_active, created_at, updated_at)
		VALUES
		 ('owner@example.com', 'owner@example.com', 'PERSONAL', 'owner', 1, 1, 1),
		 ('team@example.com', 'team@example.com', 'SHARED', NULL, 1, 1, 1);
		INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at)
		VALUES ('team@example.com', 'member', 1), ('team@example.com', 'admin-member', 1);
	`);
	let session: SessionClaims | undefined;
	let reads = 0;
	let writes = 0;
	let revokeRead = false;
	const stub = {
		async listAutomationRules() {
			reads += 1;
			if (revokeRead) {
				database.prepare(
					"DELETE FROM mailbox_memberships WHERE mailbox_id = ? AND user_id = ?",
				).run("team@example.com", "member");
			}
			return EMPTY_RULES;
		},
		async createAutomationRuleDraft() {
			writes += 1;
			return {
				rule: {
					id: "rule-1", name: "Everything", state: "draft", position: 0,
					revision: 1, activeVersion: null, draftVersion: 1,
					activeDefinition: null, draftDefinition: definition,
					createdBy: "admin-member", createdAt: "2026-07-12T10:00:00.000Z",
					updatedBy: "admin-member", updatedAt: "2026-07-12T10:00:00.000Z",
					archivedBy: null, archivedAt: null, targetHealth: "ready",
					lastRunAt: null, lastMatchedAt: null,
				},
				rulesetGeneration: 0,
				orderRevision: 1,
			};
		},
	};
	const env = {
		DB: d1(database),
		BUCKET: { head: async () => ({ exists: true }) },
		MAILBOX: { idFromName: (name: string) => name, get: () => stub },
	} as unknown as Env;
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		if (session) c.set("session", session);
		await next();
	});
	app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);
	app.route("/", automationRuleRoutes);
	return {
		database,
		get reads() { return reads; },
		get writes() { return writes; },
		setSession(userId: "owner" | "member" | "admin-member" | "admin" | "nonmember") {
			session = {
				sub: userId,
				email: `${userId}@example.com`,
				role: userId.startsWith("admin") ? "ADMIN" : "AGENT",
				mailbox: `${userId}@example.com`,
				sessionVersion: 1,
			};
		},
		revokeDuringRead() { revokeRead = true; },
		request(mailbox: string, init?: RequestInit) {
			return app.request(
				`/api/v1/mailboxes/${encodeURIComponent(mailbox)}/automation-rules`,
				init,
				env,
			);
		},
	};
}

test("mounted Automation reads allow Personal owners and every current Shared member", async () => {
	const state = fixture();
	for (const [userId, mailbox] of [
		["owner", "owner@example.com"],
		["member", "team@example.com"],
		["admin-member", "team@example.com"],
	] as const) {
		state.setSession(userId);
		assert.equal((await state.request(mailbox)).status, 200);
	}
	assert.equal(state.reads, 3);
	state.database.close();
});

test("nonmembers fail before Automation parsing or storage", async () => {
	const state = fixture();
	state.setSession("nonmember");
	const response = await state.request("team@example.com", {
		method: "POST",
		body: "not-json",
	});
	assert.equal(response.status, 403);
	assert.equal(state.reads, 0);
	assert.equal(state.writes, 0);
	state.database.close();
});

test("an administrator manages Automation Rules on a Shared Mailbox they do not belong to", async () => {
	const state = fixture();
	state.setSession("admin");
	assert.equal((await state.request("team@example.com")).status, 200);
	assert.equal(
		(await state.request("team@example.com", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ definition, expectedOrderRevision: 0 }),
		})).status,
		201,
	);
	assert.equal(state.reads, 1);
	assert.equal(state.writes, 1);
	state.database.close();
});

test("Shared mutation requires an administrator, never a plain member", async () => {
	const state = fixture();
	const init = {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ definition, expectedOrderRevision: 0 }),
	};
	state.setSession("member");
	assert.equal((await state.request("team@example.com", init)).status, 403);
	state.setSession("admin-member");
	assert.equal((await state.request("team@example.com", init)).status, 201);
	assert.equal(state.writes, 1);
	state.database.close();
});

test("mounted Automation read suppresses output after in-flight membership revocation", async () => {
	const state = fixture();
	state.setSession("member");
	state.revokeDuringRead();
	const response = await state.request("team@example.com");
	assert.equal(response.status, 403);
	assert.equal(state.reads, 1);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
	state.database.close();
});
