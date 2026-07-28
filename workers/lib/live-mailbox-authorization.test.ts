import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import {
	currentAgentActorSessionVersion,
	hasExactLiveMailboxAccess,
	isAgentMailboxActive,
	loadExactLiveMailboxRoster,
	listExactLiveMailboxes,
	listStableLiveMailboxes,
	runExactLiveMailboxRosterRead,
	runLiveMailboxAuthorizedRead,
} from "./live-mailbox-authorization.ts";
import {
	LiveReadAuthorizationError,
	LiveReadSessionAuthorizationError,
} from "./live-authorized-read.ts";
import { mcpCredentialSessionVersion } from "./mcp-authorization.ts";

class Statement {
	#values: unknown[] = [];
	readonly #db: DatabaseSync;
	readonly #sql: string;
	constructor(db: DatabaseSync, sql: string) {
		this.#db = db;
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
		return {
			success: true,
			results: this.statement().all(...this.#values) as T[],
		};
	}
	private statement(): StatementSync {
		return this.#db.prepare(this.#sql);
	}
}

function fixture() {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	for (const migration of [
		"0001_create_users.sql",
		"0003_create_mailbox_access.sql",
		"0005_auth_security.sql",
	]) {
		db.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));
	}
	db.prepare(
		`INSERT INTO users
		   (id, email, password_hash, password_salt, session_version, role, is_active,
		    mailbox_address, created_at, updated_at)
		 VALUES ('user-1', 'one@example.com', 'hash', 'salt', 7, 'AGENT', 1,
		         'one@example.com', 1, 1)`,
	).run();
	db.prepare(
		`INSERT INTO mailboxes
		   (id, address, type, owner_user_id, is_active, created_at, updated_at)
		 VALUES ('one@example.com', 'one@example.com', 'PERSONAL', 'user-1', 1, 1, 1),
		        ('team@example.com', 'team@example.com', 'SHARED', NULL, 1, 1, 1)`,
	).run();
	db.prepare(
		"INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at) VALUES ('team@example.com', 'user-1', 1)",
	).run();
	const env = {
		DB: {
			prepare(sql: string) {
				return new Statement(db, sql);
			},
		},
	} as unknown as Env;
	return { db, env };
}

test("live mailbox authorization reads the current generation only for active grants", async () => {
	const { db, env } = fixture();
	assert.equal(
		await hasExactLiveMailboxAccess(env, "TEAM@EXAMPLE.COM", "user-1", 7),
		true,
	);
	assert.equal(
		await hasExactLiveMailboxAccess(env, "team@example.com", "user-1", 6),
		false,
	);
	assert.deepEqual(
		(await listExactLiveMailboxes(env, "user-1", 7)).map((mailbox) => mailbox.id),
		["one@example.com", "team@example.com"],
	);
	assert.equal(await currentAgentActorSessionVersion(env, "TEAM@EXAMPLE.COM", "user-1"), 7);
	db.prepare(
		"DELETE FROM mailbox_memberships WHERE mailbox_id = 'team@example.com' AND user_id = 'user-1'",
	).run();
	assert.equal(
		await hasExactLiveMailboxAccess(env, "team@example.com", "user-1", 7),
		false,
	);
	assert.deepEqual(
		(await listExactLiveMailboxes(env, "user-1", 7)).map((mailbox) => mailbox.id),
		["one@example.com"],
	);
	assert.equal(await currentAgentActorSessionVersion(env, "team@example.com", "user-1"), null);
	db.prepare("UPDATE users SET is_active = 0 WHERE id = 'user-1'").run();
	assert.equal(await currentAgentActorSessionVersion(env, "one@example.com", "user-1"), null);
	db.close();
});

test("an active administrator is member-equivalent on every active mailbox", async () => {
	const { db, env } = fixture();
	db.prepare(
		`INSERT INTO users
		   (id, email, password_hash, password_salt, session_version, role, is_active,
		    mailbox_address, created_at, updated_at)
		 VALUES ('admin-1', 'admin@example.com', 'hash', 'salt', 3, 'ADMIN', 1,
		         'admin@example.com', 1, 1)`,
	).run();
	db.prepare(
		`INSERT INTO mailboxes
		   (id, address, type, owner_user_id, is_active, created_at, updated_at)
		 VALUES ('admin@example.com', 'admin@example.com', 'PERSONAL', 'admin-1', 1, 1, 1)`,
	).run();

	// Another agent's Personal Mailbox and a Shared Mailbox it never joined.
	assert.equal(await hasExactLiveMailboxAccess(env, "ONE@EXAMPLE.COM", "admin-1", 3), true);
	assert.equal(await hasExactLiveMailboxAccess(env, "team@example.com", "admin-1", 3), true);
	assert.deepEqual(
		(await listExactLiveMailboxes(env, "admin-1", 3)).map((mailbox) => mailbox.id),
		["admin@example.com", "one@example.com", "team@example.com"],
	);
	assert.deepEqual(
		(await loadExactLiveMailboxRoster(env, "admin-1", 3))?.mailboxIds,
		["admin@example.com", "one@example.com", "team@example.com"],
	);
	assert.equal(
		await currentAgentActorSessionVersion(env, "one@example.com", "admin-1"),
		3,
	);

	// The allowance is still bound to the exact live credential generation.
	assert.equal(await hasExactLiveMailboxAccess(env, "one@example.com", "admin-1", 2), false);

	// An agent gains nothing from the administrator's mailbox existing.
	assert.equal(await hasExactLiveMailboxAccess(env, "admin@example.com", "user-1", 7), false);
	assert.deepEqual(
		(await listExactLiveMailboxes(env, "user-1", 7)).map((mailbox) => mailbox.id),
		["one@example.com", "team@example.com"],
	);

	// Deactivation revokes the allowance everywhere at once.
	db.prepare("UPDATE users SET is_active = 0 WHERE id = 'admin-1'").run();
	assert.equal(await hasExactLiveMailboxAccess(env, "one@example.com", "admin-1", 3), false);
	assert.deepEqual(await listExactLiveMailboxes(env, "admin-1", 3), []);
	assert.equal(
		await currentAgentActorSessionVersion(env, "one@example.com", "admin-1"),
		null,
	);
	db.close();
});

test("an administrator never reaches a deactivated mailbox", async () => {
	const { db, env } = fixture();
	db.prepare(
		`INSERT INTO users
		   (id, email, password_hash, password_salt, session_version, role, is_active,
		    mailbox_address, created_at, updated_at)
		 VALUES ('admin-1', 'admin@example.com', 'hash', 'salt', 3, 'ADMIN', 1,
		         'admin@example.com', 1, 1)`,
	).run();
	db.prepare("UPDATE mailboxes SET is_active = 0 WHERE id = 'team@example.com'").run();

	assert.equal(await hasExactLiveMailboxAccess(env, "team@example.com", "admin-1", 3), false);
	assert.deepEqual(
		(await listExactLiveMailboxes(env, "admin-1", 3)).map((mailbox) => mailbox.id),
		["one@example.com"],
	);
	assert.equal(
		await currentAgentActorSessionVersion(env, "team@example.com", "admin-1"),
		null,
	);
	db.close();
});

test("stable mailbox rosters suppress access removed during the read", async () => {
	const mailbox = {
		id: "team@example.com",
		address: "team@example.com",
		type: "SHARED" as const,
		owner_user_id: null,
		is_active: 1,
		created_at: 1,
		updated_at: 1,
	};
	let reads = 0;
	assert.deepEqual(
		await listStableLiveMailboxes(
			{} as never,
			"user-1",
			7,
			async () => (reads += 1) === 1 ? [mailbox] : [],
		),
		[],
	);
	assert.equal(reads, 2);
});

test("legacy generation-one MCP grants retain exact live mail access", async () => {
	const { db, env } = fixture();
	db.prepare("UPDATE users SET session_version = 1 WHERE id = 'user-1'").run();
	assert.equal(
		await hasExactLiveMailboxAccess(
			env,
			"team@example.com",
			"user-1",
			mcpCredentialSessionVersion({}),
		),
		true,
	);
	assert.deepEqual(
		(
			await listExactLiveMailboxes(
				env,
				"user-1",
				mcpCredentialSessionVersion({}),
			)
		).map((mailbox) => mailbox.id),
		["one@example.com", "team@example.com"],
	);
	db.close();
});

test("mailbox reconciliation preserves only active mailboxes", async () => {
	const { db, env } = fixture();
	assert.equal(await isAgentMailboxActive(env, "TEAM@EXAMPLE.COM"), true);
	db.prepare("UPDATE mailboxes SET is_active = 0 WHERE id = 'team@example.com'").run();
	assert.equal(await isAgentMailboxActive(env, "team@example.com"), false);
	assert.equal(await isAgentMailboxActive(env, "missing@example.com"), false);
	db.close();
});

test("global roster snapshots distinguish active users with no mailboxes from stale sessions", async () => {
	const { db, env } = fixture();
	assert.deepEqual(await loadExactLiveMailboxRoster(env, "user-1", 7), {
		mailboxIds: ["one@example.com", "team@example.com"],
	});
	db.prepare("UPDATE mailboxes SET is_active = 0").run();
	assert.deepEqual(await loadExactLiveMailboxRoster(env, "user-1", 7), {
		mailboxIds: [],
	});
	assert.equal(await loadExactLiveMailboxRoster(env, "user-1", 6), null);
	db.prepare("UPDATE users SET is_active = 0 WHERE id = 'user-1'").run();
	assert.equal(await loadExactLiveMailboxRoster(env, "user-1", 7), null);
	db.close();
});

test("per-mailbox disclosure reads discard every form of in-flight access loss", async () => {
	for (const revoke of [
		(db: DatabaseSync) => db.prepare(
			"DELETE FROM mailbox_memberships WHERE mailbox_id = 'team@example.com' AND user_id = 'user-1'",
		).run(),
		(db: DatabaseSync) => db.prepare(
			"UPDATE mailboxes SET is_active = 0 WHERE id = 'team@example.com'",
		).run(),
		(db: DatabaseSync) => db.prepare(
			"UPDATE users SET is_active = 0 WHERE id = 'user-1'",
		).run(),
		(db: DatabaseSync) => db.prepare(
			"UPDATE users SET session_version = 8 WHERE id = 'user-1'",
		).run(),
	]) {
		const { db, env } = fixture();
		await assert.rejects(
			() => runLiveMailboxAuthorizedRead(
				env,
				{ mailboxId: "TEAM@EXAMPLE.COM", userId: "user-1", sessionVersion: 7 },
				async () => {
					revoke(db);
					return { subject: "private mail" };
				},
			),
			LiveReadAuthorizationError,
		);
		db.close();
	}
});

test("global disclosure reads require the exact same canonical mailbox set", async () => {
	for (const change of [
		(db: DatabaseSync) => db.prepare(
			"DELETE FROM mailbox_memberships WHERE mailbox_id = 'team@example.com' AND user_id = 'user-1'",
		).run(),
		(db: DatabaseSync) => {
			db.prepare(
				`INSERT INTO mailboxes
				   (id, address, type, owner_user_id, is_active, created_at, updated_at)
				 VALUES ('added@example.com', 'added@example.com', 'SHARED', NULL, 1, 1, 1)`,
			).run();
			db.prepare(
				"INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at) VALUES ('added@example.com', 'user-1', 1)",
			).run();
		},
		(db: DatabaseSync) => {
			db.prepare(
				"DELETE FROM mailbox_memberships WHERE mailbox_id = 'team@example.com' AND user_id = 'user-1'",
			).run();
			db.prepare(
				`INSERT INTO mailboxes
				   (id, address, type, owner_user_id, is_active, created_at, updated_at)
				 VALUES ('replacement@example.com', 'replacement@example.com', 'SHARED', NULL, 1, 1, 1)`,
			).run();
			db.prepare(
				"INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at) VALUES ('replacement@example.com', 'user-1', 1)",
			).run();
		},
	]) {
		const { db, env } = fixture();
		await assert.rejects(
			() => runExactLiveMailboxRosterRead(env, {
				userId: "user-1",
				sessionVersion: 7,
			}, async () => {
				change(db);
				return { secret: "private result" };
			}),
			(error: unknown) => {
				assert.ok(error instanceof LiveReadAuthorizationError);
				assert.equal(error instanceof LiveReadSessionAuthorizationError, false);
				return true;
			},
		);
		db.close();
	}
});

test("global disclosure permits stable ordering and an active empty roster, but not a stale session", async () => {
	const stable = fixture();
	let reads = 0;
	assert.equal(await runExactLiveMailboxRosterRead(
		stable.env,
		{ userId: "user-1", sessionVersion: 7 },
		async () => "safe",
		async () => ({
			mailboxIds: (++reads === 1
				? ["z@example.com", "a@example.com"]
				: ["a@example.com", "z@example.com"]
			).sort(),
		}),
	), "safe");

	assert.equal(await runExactLiveMailboxRosterRead(
		stable.env,
		{ userId: "user-1", sessionVersion: 7 },
		async () => "safe",
		async () => ({ mailboxIds: [] }),
	), "safe");

	await assert.rejects(
		() => runExactLiveMailboxRosterRead(
			stable.env,
			{ userId: "user-1", sessionVersion: 7 },
			async () => "private",
			async () => null,
		),
		LiveReadSessionAuthorizationError,
	);
	stable.db.close();

	const { db, env } = fixture();
	await assert.rejects(
		() => runExactLiveMailboxRosterRead(env, {
			userId: "user-1",
			sessionVersion: 7,
		}, async () => {
			db.prepare("UPDATE users SET session_version = 8 WHERE id = 'user-1'").run();
			return "private";
		}),
		LiveReadSessionAuthorizationError,
	);
	db.close();
});
