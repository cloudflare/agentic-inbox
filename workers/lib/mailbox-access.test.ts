import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { MailboxRow } from "../db/users-schema.ts";
import type { Env } from "../types.ts";
import {
	createMailboxAccess,
	mailboxAccess,
	type MailboxAccessRow,
	type MailboxAccessStore,
} from "./mailbox-access.ts";
import type { User } from "./users.ts";

function user(id: string, role: User["role"] = "AGENT", isActive = true): User {
	return {
		id,
		email: `${id}@wiserchat.ai`,
		password_hash: "hash",
		password_salt: "salt",
		session_version: 1,
		role,
		is_active: isActive ? 1 : 0,
		mailbox_address: `${id}@wiserchat.ai`,
		mcp_token_hash: null,
		recovery_email: null,
		created_at: 1,
		updated_at: 1,
	};
}

function mailbox(
	id: string,
	type: MailboxRow["type"],
	ownerUserId: string | null,
	isActive = true,
): MailboxRow {
	return {
		id,
		address: `${id}@wiserchat.ai`,
		type,
		owner_user_id: ownerUserId,
		is_active: isActive ? 1 : 0,
		created_at: 1,
		updated_at: 1,
	};
}

function memoryStore(input: {
	users: User[];
	mailboxes: MailboxRow[];
	memberships?: Array<{ mailboxId: string; userId: string }>;
}): MailboxAccessStore {
	const memberships = input.memberships ?? [];
	const accessRow = (mailbox: MailboxRow, userId: string): MailboxAccessRow => ({
		...mailbox,
		membership_user_id:
			memberships.find(
				(membership) =>
					membership.mailboxId === mailbox.id && membership.userId === userId,
			)?.userId ?? null,
	});

	return {
		async getUser(userId) {
			return input.users.find((candidate) => candidate.id === userId);
		},
		async listMailboxAccessRows(userId) {
			return input.mailboxes.map((candidate) => accessRow(candidate, userId));
		},
		async getMailboxAccessRow(userId, mailboxId) {
			const candidate = input.mailboxes.find((item) => item.id === mailboxId);
			return candidate ? accessRow(candidate, userId) : undefined;
		},
		async getMailbox(mailboxId) {
			return input.mailboxes.find((candidate) => candidate.id === mailboxId);
		},
		async listMailboxes() {
			return input.mailboxes;
		},
		async listMembershipMailboxIds() {
			return memberships.map((membership) => ({
				mailbox_id: membership.mailboxId,
			}));
		},
		async listMailboxMembers(mailboxId) {
			return memberships
				.filter((membership) => membership.mailboxId === mailboxId)
				.map((membership) => input.users.find((item) => item.id === membership.userId))
				.filter((item): item is User => Boolean(item))
				.map(({ id, email, role, is_active }) => ({ id, email, role, is_active }));
		},
		async addMailbox(candidate) {
			if (input.mailboxes.some((item) => item.id === candidate.id)) return false;
			input.mailboxes.push(candidate);
			return true;
		},
		async setMailboxActive(mailboxId, isActive) {
			const candidate = input.mailboxes.find((item) => item.id === mailboxId);
			if (!candidate) return false;
			candidate.is_active = isActive ? 1 : 0;
			return true;
		},
		async addMembership(mailboxId, userId) {
			if (
				memberships.some(
					(membership) =>
						membership.mailboxId === mailboxId && membership.userId === userId,
				)
			) {
				return false;
			}
			memberships.push({ mailboxId, userId });
			return true;
		},
		async removeMembership(mailboxId, userId) {
			const index = memberships.findIndex(
				(membership) =>
					membership.mailboxId === mailboxId && membership.userId === userId,
			);
			if (index === -1) return false;
			memberships.splice(index, 1);
			return true;
		},
	};
}

test("Personal Mailbox content reaches its active owner and every administrator, never another agent", async () => {
	const owner = user("owner");
	const other = user("other");
	const admin = user("admin", "ADMIN");
	const personal = mailbox("personal", "PERSONAL", owner.id);
	const access = createMailboxAccess(
		memoryStore({ users: [owner, other, admin], mailboxes: [personal] }),
	);

	assert.equal(await access.canAccessMailbox(owner.id, personal.id), true);
	assert.equal(await access.canAccessMailbox(admin.id, personal.id), true);
	assert.equal(await access.canAccessMailbox(other.id, personal.id), false);
	assert.deepEqual(await access.listAccessibleMailboxes(admin.id), [personal]);
	assert.deepEqual(await access.listAccessibleMailboxes(other.id), []);
});

test("Shared Mailbox content reaches explicit active members and every administrator, never another agent", async () => {
	const member = user("member");
	const nonmember = user("nonmember");
	const admin = user("admin", "ADMIN");
	const shared = mailbox("shared", "SHARED", null);
	const access = createMailboxAccess(
		memoryStore({
			users: [member, nonmember, admin],
			mailboxes: [shared],
			memberships: [{ mailboxId: shared.id, userId: member.id }],
		}),
	);

	assert.equal(await access.canAccessMailbox(member.id, shared.id), true);
	assert.equal(await access.canAccessMailbox(nonmember.id, shared.id), false);
	assert.equal(await access.canAccessMailbox(admin.id, shared.id), true);
	assert.deepEqual(await access.listAccessibleMailboxes(member.id), [shared]);
	assert.deepEqual(await access.listAccessibleMailboxes(nonmember.id), []);
	assert.deepEqual(await access.listAccessibleMailboxes(admin.id), [shared]);
	assert.equal(
		await access.canManageMailboxSettings(member.id, shared.id),
		false,
	);
	assert.equal(await access.canManageMailboxSettings(admin.id, shared.id), true);
});

test("Personal Mailbox owners manage their own settings, administrators manage every mailbox, other agents manage none", async () => {
	const owner = user("owner");
	const other = user("other");
	const admin = user("admin", "ADMIN");
	const personal = mailbox("personal", "PERSONAL", owner.id);
	const access = createMailboxAccess(
		memoryStore({ users: [owner, other, admin], mailboxes: [personal] }),
	);

	assert.equal(await access.canManageMailboxSettings(owner.id, personal.id), true);
	assert.equal(await access.canManageMailboxSettings(admin.id, personal.id), true);
	assert.equal(await access.canAccessMailbox(admin.id, personal.id), true);
	assert.equal(await access.canManageMailboxSettings(other.id, personal.id), false);
});

test("Automation Rules require Personal ownership or an active administrator", async () => {
	const owner = user("owner");
	const member = user("member");
	const adminMember = user("admin-member", "ADMIN");
	const adminNonmember = user("admin-nonmember", "ADMIN");
	const inactiveAdmin = user("inactive-admin", "ADMIN", false);
	const personal = mailbox("personal", "PERSONAL", owner.id);
	const shared = mailbox("shared", "SHARED", null);
	const access = createMailboxAccess(
		memoryStore({
			users: [owner, member, adminMember, adminNonmember, inactiveAdmin],
			mailboxes: [personal, shared],
			memberships: [
				{ mailboxId: shared.id, userId: member.id },
				{ mailboxId: shared.id, userId: adminMember.id },
				{ mailboxId: shared.id, userId: inactiveAdmin.id },
			],
		}),
	);

	assert.equal(await access.canManageAutomationRules(owner.id, personal.id), true);
	assert.equal(
		await access.canManageAutomationRules(adminMember.id, personal.id),
		true,
	);
	assert.equal(await access.canManageAutomationRules(member.id, shared.id), false);
	assert.equal(await access.canManageAutomationRules(member.id, personal.id), false);
	assert.equal(
		await access.canManageAutomationRules(adminMember.id, shared.id),
		true,
	);
	assert.equal(
		await access.canManageAutomationRules(adminNonmember.id, shared.id),
		true,
	);
	assert.equal(
		await access.canManageAutomationRules(inactiveAdmin.id, shared.id),
		false,
	);
});

test("Inactive users and inactive mailboxes are never accessible", async () => {
	const inactiveMember = user("inactive-member", "AGENT", false);
	const activeMember = user("active-member");
	const shared = mailbox("shared", "SHARED", null);
	const inactiveShared = mailbox("inactive-shared", "SHARED", null, false);
	const access = createMailboxAccess(
		memoryStore({
			users: [inactiveMember, activeMember],
			mailboxes: [shared, inactiveShared],
			memberships: [
				{ mailboxId: shared.id, userId: inactiveMember.id },
				{ mailboxId: inactiveShared.id, userId: activeMember.id },
			],
		}),
	);

	assert.equal(await access.canAccessMailbox(inactiveMember.id, shared.id), false);
	assert.equal(
		await access.canAccessMailbox(activeMember.id, inactiveShared.id),
		false,
	);
	assert.deepEqual(await access.listAccessibleMailboxes(inactiveMember.id), []);
	assert.deepEqual(await access.listAccessibleMailboxes(activeMember.id), []);
});

test("An active admin can add and remove active Shared Mailbox members", async () => {
	const admin = user("admin", "ADMIN");
	const member = user("member");
	const shared = mailbox("shared", "SHARED", null);
	const access = createMailboxAccess(
		memoryStore({ users: [admin, member], mailboxes: [shared] }),
	);

	await access.addSharedMailboxMember(admin.id, shared.id, member.id);
	assert.equal(await access.canAccessMailbox(member.id, shared.id), true);

	await access.removeSharedMailboxMember(admin.id, shared.id, member.id);
	assert.equal(await access.canAccessMailbox(member.id, shared.id), false);
});

test("Registering a Shared Mailbox leaves it memberless while its administrator can already reach it", async () => {
	const admin = user("admin", "ADMIN");
	const mailboxes: MailboxRow[] = [];
	const access = createMailboxAccess(memoryStore({ users: [admin], mailboxes }));

	const registered = await access.registerSharedMailbox(
		admin.id,
		"support@wiserchat.ai",
	);

	assert.equal(registered.type, "SHARED");
	assert.equal(await access.canAccessMailbox(admin.id, registered.id), true);
	assert.deepEqual(await access.listSharedMailboxMembers(admin.id, registered.id), []);
});

test("Membership management rejects non-admins, inactive users, and Personal Mailboxes", async () => {
	const admin = user("admin", "ADMIN");
	const agent = user("agent");
	const inactiveMember = user("inactive-member", "AGENT", false);
	const shared = mailbox("shared", "SHARED", null);
	const personal = mailbox("personal", "PERSONAL", agent.id);
	const access = createMailboxAccess(
		memoryStore({
			users: [admin, agent, inactiveMember],
			mailboxes: [shared, personal],
		}),
	);

	await assert.rejects(
		() => access.addSharedMailboxMember(agent.id, shared.id, agent.id),
		/active administrator/,
	);
	await assert.rejects(
		() => access.addSharedMailboxMember(admin.id, shared.id, inactiveMember.id),
		/must be active/,
	);
	await assert.rejects(
		() => access.addSharedMailboxMember(admin.id, personal.id, agent.id),
		/Shared Mailboxes/,
	);
});

// The Durable Object re-checks delivery and outbound authority through this exact
// entry point (workers/durableObject/index.ts:10421, :13185, :13365), so it is
// pinned against real SQL rather than the in-memory store above.
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

function liveFixture() {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	for (const migration of [
		"0001_create_users.sql",
		"0003_create_mailbox_access.sql",
		"0005_auth_security.sql",
		"0006_credential_recovery.sql",
	]) {
		database.exec(
			readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"),
		);
	}
	database.exec(`
		INSERT INTO users
		 (id, email, password_hash, password_salt, role, is_active, mailbox_address,
		  session_version, created_at, updated_at)
		VALUES
		 ('owner', 'owner@example.com', 'hash', 'salt', 'AGENT', 1, 'owner@example.com', 1, 1, 1),
		 ('nonmember', 'nonmember@example.com', 'hash', 'salt', 'AGENT', 1, 'nonmember@example.com', 1, 1, 1),
		 ('admin', 'admin@example.com', 'hash', 'salt', 'ADMIN', 1, 'admin@example.com', 1, 1, 1);
		INSERT INTO mailboxes
		 (id, address, type, owner_user_id, is_active, created_at, updated_at)
		VALUES
		 ('owner@example.com', 'owner@example.com', 'PERSONAL', 'owner', 1, 1, 1),
		 ('nonmember@example.com', 'nonmember@example.com', 'PERSONAL', 'nonmember', 1, 1, 1),
		 ('admin@example.com', 'admin@example.com', 'PERSONAL', 'admin', 1, 1, 1),
		 ('team@example.com', 'team@example.com', 'SHARED', NULL, 1, 1, 1),
		 ('closed@example.com', 'closed@example.com', 'SHARED', NULL, 0, 1, 1);
	`);
	return { database, env: { DB: { prepare: (sql: string) => new Statement(database, sql) } } as unknown as Env };
}

test("the Durable Object access entry point grants an administrator every active mailbox over real SQL", async () => {
	const { database, env } = liveFixture();
	const access = mailboxAccess(env);

	assert.equal(await access.canAccessMailbox("admin", "owner@example.com"), true);
	assert.equal(await access.canAccessMailbox("admin", "team@example.com"), true);
	assert.equal(await access.canAccessMailbox("admin", "closed@example.com"), false);
	assert.deepEqual(
		(await access.listAccessibleMailboxes("admin")).map((mailbox) => mailbox.id).sort(),
		[
			"admin@example.com",
			"nonmember@example.com",
			"owner@example.com",
			"team@example.com",
		],
	);
	database.close();
});

test("the Durable Object access entry point still confines an agent over real SQL", async () => {
	const { database, env } = liveFixture();
	const access = mailboxAccess(env);

	assert.equal(await access.canAccessMailbox("nonmember", "owner@example.com"), false);
	assert.equal(await access.canAccessMailbox("nonmember", "team@example.com"), false);
	assert.deepEqual(
		(await access.listAccessibleMailboxes("nonmember")).map((mailbox) => mailbox.id),
		["nonmember@example.com"],
	);

	assert.equal(await access.canAccessMailbox("owner", "owner@example.com"), true);
	assert.equal(await access.canAccessMailbox("owner", "team@example.com"), false);
	database.close();
});

test("an administrator deactivated between checks loses every mailbox over real SQL", async () => {
	const { database, env } = liveFixture();
	const access = mailboxAccess(env);
	assert.equal(await access.canAccessMailbox("admin", "team@example.com"), true);

	database.exec("UPDATE users SET is_active = 0 WHERE id = 'admin'");
	assert.equal(await access.canAccessMailbox("admin", "team@example.com"), false);
	assert.deepEqual(await access.listAccessibleMailboxes("admin"), []);
	database.close();
});
