import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import { encodeMailboxChangeCursor, type MailboxChangePage } from "../../shared/mailbox-change-feed.ts";
import type { Env } from "../types.ts";
import type { SessionClaims } from "../lib/auth.ts";
import {
	hasLiveMailboxContentAccess,
	requireMailbox,
	type MailboxContext,
} from "../lib/mailbox.ts";
import { createMailboxChangeFeedRoutes } from "./mailbox-change-feed.ts";

class Statement {
	#values: unknown[] = [];
	readonly #database: DatabaseSync;
	readonly #sql: string;

	constructor(database: DatabaseSync, sql: string) {
		this.#database = database;
		this.#sql = sql;
	}

	bind(...values: unknown[]) {
		this.#values = values;
		return this;
	}

	async first<T>() {
		return (this.statement().get(...this.#values) as T | undefined) ?? null;
	}

	async all<T>() {
		return { success: true, results: this.statement().all(...this.#values) as T[] };
	}

	async raw<T extends unknown[]>() {
		return this.statement().all(...this.#values).map((row) => Object.values(row)) as T[];
	}

	async run() {
		const result = this.statement().run(...this.#values);
		return { success: true, meta: { changes: Number(result.changes) } };
	}

	private statement(): StatementSync {
		return this.#database.prepare(this.#sql);
	}
}

function d1(database: DatabaseSync): D1Database {
	return {
		prepare(sql: string) {
			return new Statement(database, sql);
		},
	} as unknown as D1Database;
}

const PAGE: MailboxChangePage = {
	changes: [],
	nextCursor: encodeMailboxChangeCursor(0),
};

function fixture() {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	for (const migration of [
		"0001_create_users.sql",
		"0003_create_mailbox_access.sql",
		"0005_auth_security.sql",
		"0006_credential_recovery.sql",
	]) {
		database.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));
	}
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
	let revokeDuringRead = false;
	const mailboxStub = {
		async listMailboxChanges() {
			reads += 1;
			if (revokeDuringRead) {
				database.prepare(
					"DELETE FROM mailbox_memberships WHERE mailbox_id = ? AND user_id = ?",
				).run("team@example.com", "member");
			}
			return PAGE;
		},
	};
	const env = {
		DB: d1(database),
		BUCKET: { head: async () => ({ exists: true }) },
		MAILBOX: {
			idFromName: (name: string) => name,
			get: () => mailboxStub,
		},
	} as unknown as Env;
	const app = new Hono<MailboxContext>();
	app.use("*", async (context, next) => {
		if (session) context.set("session", session);
		await next();
	});
	app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);
	app.route("/", createMailboxChangeFeedRoutes({
		operations: (context) => ({
			list: (options) => context.var.mailboxStub.listMailboxChanges(options),
		}),
		revalidateAccess: hasLiveMailboxContentAccess,
	}));

	return {
		database,
		get reads() {
			return reads;
		},
		setSession(userId: "owner" | "member" | "nonmember" | "admin") {
			session = {
				sub: userId,
				email: `${userId}@example.com`,
				role: userId === "admin" ? "ADMIN" : "AGENT",
				mailbox: `${userId}@example.com`,
				sessionVersion: 1,
			};
		},
		revokeDuringRead() {
			revokeDuringRead = true;
		},
		request(mailboxId: string, query = "") {
			return app.request(`/api/v1/mailboxes/${mailboxId}/changes${query}`, undefined, env);
		},
	};
}

test("mounted feed authorizes Personal owners and Shared members before query parsing and storage", async () => {
	const state = fixture();
	state.setSession("owner");
	assert.equal((await state.request("owner%40example.com")).status, 200);
	state.setSession("member");
	assert.equal((await state.request("team%40example.com")).status, 200);
	assert.equal(state.reads, 2);
	state.database.close();
});

test("mounted feed denies nonmember access before invalid query parsing or storage", async () => {
	const state = fixture();
	state.setSession("nonmember");
	const response = await state.request("team%40example.com", "?unexpected=mail-content");
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
	assert.equal(state.reads, 0);
	state.database.close();
});

test("mounted feed authorizes an administrator on mailboxes they neither own nor belong to", async () => {
	const state = fixture();
	state.setSession("admin");
	assert.equal((await state.request("team%40example.com")).status, 200);
	assert.equal((await state.request("owner%40example.com")).status, 200);
	assert.equal(state.reads, 2);
	state.database.close();
});

test("mounted feed suppresses a read when Shared membership is revoked in flight", async () => {
	const state = fixture();
	state.setSession("member");
	state.revokeDuringRead();
	const response = await state.request("team%40example.com");
	assert.equal(state.reads, 1);
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
	state.database.close();
});
