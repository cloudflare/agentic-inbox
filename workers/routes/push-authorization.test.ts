import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import type { PushHealthResponse } from "../../shared/push-health.ts";
import type { SessionClaims } from "../lib/auth.ts";
import {
	hasLiveMailboxContentAccess,
	requireMailbox,
	type MailboxContext,
} from "../lib/mailbox.ts";
import type { Env } from "../types.ts";
import { createPushHealthRoutes } from "./push-health.ts";
import { createPushSubscriptionRoutes } from "./push-subscriptions.ts";

class Statement {
	#values: unknown[] = [];
	private readonly database: DatabaseSync;
	private readonly statementSql: string;
	constructor(database: DatabaseSync, statementSql: string) {
		this.database = database;
		this.statementSql = statementSql;
	}
	bind(...values: unknown[]) { this.#values = values; return this; }
	async first<T>() { return (this.statement().get(...this.#values) as T | undefined) ?? null; }
	async all<T>() { return { success: true, results: this.statement().all(...this.#values) as T[] }; }
	async raw<T extends unknown[]>() { return this.statement().all(...this.#values).map((row) => Object.values(row)) as T[]; }
	async run() { const result = this.statement().run(...this.#values); return { success: true, meta: { changes: Number(result.changes) } }; }
	private statement(): StatementSync { return this.database.prepare(this.statementSql); }
}

function d1(database: DatabaseSync): D1Database {
	return { prepare: (statementSql: string) => new Statement(database, statementSql) } as unknown as D1Database;
}

const health: PushHealthResponse = {
	state: "no_devices",
	pendingCount: 0,
	refreshedAt: "2026-07-12T10:00:00.000Z",
	devices: [],
};

const subscription = {
	endpoint: "https://push.example/device",
	keys: {
		p256dh: Buffer.from(Uint8Array.from({ length: 65 }, (_, index) => index === 0 ? 4 : index)).toString("base64url"),
		auth: Buffer.from(Uint8Array.from({ length: 16 }, (_, index) => index)).toString("base64url"),
	},
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
	let reads = 0;
	let mutations = 0;
	const env = {
		DB: d1(database),
		BUCKET: { head: async () => ({ exists: true }) },
		MAILBOX: { idFromName: (name: string) => name, get: () => ({}) },
	} as unknown as Env;
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => { if (session) c.set("session", session); await next(); });
	app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);
	app.route("/", createPushHealthRoutes({
		read: async () => { reads += 1; return health; },
		revalidateAccess: hasLiveMailboxContentAccess,
	}));
	app.route("/", createPushSubscriptionRoutes({
		operations: () => ({
			upsert: async () => { mutations += 1; return { id: "device-1", deviceLabel: "Browser", generation: 1 }; },
			remove: async () => { mutations += 1; return true; },
		}),
		revalidateAccess: hasLiveMailboxContentAccess,
	}));
	return {
		database,
		get reads() { return reads; },
		get mutations() { return mutations; },
		setSession(userId: "owner" | "member" | "nonmember" | "admin") {
			session = {
				sub: userId,
				email: `${userId}@example.com`,
				role: userId === "admin" ? "ADMIN" : "AGENT",
				mailbox: `${userId}@example.com`,
				sessionVersion: 1,
			};
		},
		requestHealth(mailbox: string) {
			return app.request(`/api/v1/mailboxes/${mailbox}/push-health`, undefined, env);
		},
		register(mailbox: string) {
			return app.request(`/api/v1/mailboxes/${mailbox}/push-subscriptions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(subscription),
			}, env);
		},
	};
}

test("mounted push surfaces allow Personal owners and current Shared members", async () => {
	const state = fixture();
	state.setSession("owner");
	assert.equal((await state.requestHealth("owner%40example.com")).status, 200);
	assert.equal((await state.register("owner%40example.com")).status, 201);
	state.setSession("member");
	assert.equal((await state.requestHealth("team%40example.com")).status, 200);
	assert.equal((await state.register("team%40example.com")).status, 201);
	assert.equal(state.reads, 2);
	assert.equal(state.mutations, 2);
	state.database.close();
});

test("nonmembers cannot read or mutate push state", async () => {
	const state = fixture();
	state.setSession("nonmember");
	const healthResponse = await state.requestHealth("team%40example.com");
	assert.equal(healthResponse.status, 403);
	assert.deepEqual(await healthResponse.json(), { error: "Forbidden" });
	const mutationResponse = await state.register("team%40example.com");
	assert.equal(mutationResponse.status, 403);
	assert.deepEqual(await mutationResponse.json(), { error: "Forbidden" });
	assert.equal(state.reads, 0);
	assert.equal(state.mutations, 0);
	state.database.close();
});

test("an administrator reads and mutates push state on mailboxes they neither own nor belong to", async () => {
	const state = fixture();
	state.setSession("admin");
	assert.equal((await state.requestHealth("team%40example.com")).status, 200);
	assert.equal((await state.register("team%40example.com")).status, 201);
	assert.equal((await state.requestHealth("owner%40example.com")).status, 200);
	assert.equal((await state.register("owner%40example.com")).status, 201);
	assert.equal(state.reads, 2);
	assert.equal(state.mutations, 2);
	state.database.close();
});
