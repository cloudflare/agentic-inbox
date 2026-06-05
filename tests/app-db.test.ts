import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	createTemplate,
	deleteMailboxMembership,
	deleteTemplate,
	ensureAppSchema,
	getMailboxRole,
	listMailboxesForUser,
	listTemplates,
	registerIdentityUser,
	updateTemplate,
	updateUser,
	upsertMailboxMembership,
	upsertMailboxRecord,
} from "../workers/lib/app-db";
import type { AppUserRecord } from "../workers/lib/permissions";

type SqlValue = string | number | boolean | null | ArrayBuffer | Uint8Array;
type QueryRow = Record<string, unknown>;

class TestD1PreparedStatement {
	constructor(
		private readonly database: Database,
		private readonly sql: string,
		private readonly values: SqlValue[] = [],
	) {}

	bind(...values: SqlValue[]): TestD1PreparedStatement {
		return new TestD1PreparedStatement(this.database, this.sql, values);
	}

	async first<T = QueryRow>(): Promise<T | null> {
		const row = this.database.query(this.sql).get(...this.values) as T | null | undefined;
		return row ?? null;
	}

	async all<T = QueryRow>(): Promise<{ results: T[] }> {
		const rows = this.database.query(this.sql).all(...this.values) as T[];
		return { results: rows };
	}

	async run(): Promise<{ success: true; meta: { changes: number } }> {
		const result = this.database.query(this.sql).run(...this.values) as { changes?: number };
		return { success: true, meta: { changes: result.changes ?? 0 } };
	}
}

class TestD1Database {
	constructor(private readonly database: Database) {}

	prepare(sql: string): TestD1PreparedStatement {
		return new TestD1PreparedStatement(this.database, sql);
	}

	async exec(sql: string): Promise<void> {
		this.database.exec(sql);
	}
}

function createTestDb(): D1Database {
	const database = new Database(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	return new TestD1Database(database) as unknown as D1Database;
}

async function createActiveUser(
	db: D1Database,
	email: string,
	globalRole: AppUserRecord["globalRole"] = "none",
): Promise<AppUserRecord> {
	const registered = await registerIdentityUser(
		db,
		{ sub: `sub:${email}`, email },
		"2026-06-05T09:00:00.000Z",
	);
	const user = await updateUser(
		db,
		registered.id,
		{ status: "active", globalRole },
		"2026-06-05T09:01:00.000Z",
	);
	if (!user) throw new Error(`Failed to create ${email}`);
	return user;
}

describe("app metadata database", () => {
	test("membership grants control mailbox filtering and role upgrades", async () => {
		const db = createTestDb();
		await ensureAppSchema(db);
		const admin = await createActiveUser(db, "admin@example.com", "admin");
		const responder = await createActiveUser(db, "responder@example.com");
		await upsertMailboxRecord(db, { email: "alpha@example.com", name: "Alpha" }, "2026-06-05T09:02:00.000Z");
		await upsertMailboxRecord(db, { email: "beta@example.com", name: "Beta" }, "2026-06-05T09:02:00.000Z");

		expect(await listMailboxesForUser(db, responder)).toEqual([]);
		expect((await listMailboxesForUser(db, admin)).map((mailbox) => mailbox.id)).toEqual([
			"alpha@example.com",
			"beta@example.com",
		]);

		const grant = await upsertMailboxMembership(
			db,
			"alpha@example.com",
			responder.email,
			"responder",
			"2026-06-05T09:03:00.000Z",
		);
		expect(grant?.role).toBe("responder");
		expect(await getMailboxRole(db, responder, "alpha@example.com")).toBe("responder");

		const visible = await listMailboxesForUser(db, responder);
		expect(visible).toHaveLength(1);
		expect(visible[0]).toMatchObject({
			id: "alpha@example.com",
			role: "responder",
			capabilities: {
				readMail: true,
				sendMail: true,
				manageMembers: false,
			},
		});

		const upgraded = await upsertMailboxMembership(
			db,
			"alpha@example.com",
			responder.id,
			"manager",
			"2026-06-05T09:04:00.000Z",
		);
		expect(upgraded?.role).toBe("manager");
		expect(await getMailboxRole(db, responder, "alpha@example.com")).toBe("manager");

		expect(await deleteMailboxMembership(db, "alpha@example.com", responder.email)).toBe(true);
		expect(await listMailboxesForUser(db, responder)).toEqual([]);
	});

	test("response templates are scoped to a mailbox and support CRUD", async () => {
		const db = createTestDb();
		await ensureAppSchema(db);
		const manager = await createActiveUser(db, "manager@example.com");
		await upsertMailboxRecord(db, { email: "alpha@example.com", name: "Alpha" }, "2026-06-05T09:02:00.000Z");
		await upsertMailboxRecord(db, { email: "beta@example.com", name: "Beta" }, "2026-06-05T09:02:00.000Z");

		const created = await createTemplate(
			db,
			"alpha@example.com",
			manager.id,
			{
				name: "Greeting",
				subject: "Hello",
				bodyHtml: "<p>Hello</p>",
				bodyText: "Hello",
			},
			"2026-06-05T09:05:00.000Z",
		);
		expect(created).toMatchObject({
			mailboxId: "alpha@example.com",
			name: "Greeting",
			subject: "Hello",
			bodyHtml: "<p>Hello</p>",
			bodyText: "Hello",
		});
		expect(await listTemplates(db, "beta@example.com")).toEqual([]);

		const updated = await updateTemplate(
			db,
			"alpha@example.com",
			created.id,
			manager.id,
			{
				name: "Updated",
				subject: "Re: Hello",
				bodyHtml: "<p>Updated</p>",
				bodyText: "Updated",
			},
			"2026-06-05T09:06:00.000Z",
		);
		expect(updated?.name).toBe("Updated");
		expect(updated?.updatedBy).toBe(manager.id);

		expect(await deleteTemplate(db, "alpha@example.com", created.id)).toBe(true);
		expect(await listTemplates(db, "alpha@example.com")).toEqual([]);
	});
});
