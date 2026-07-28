import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
	mailboxMemberships,
	mailboxes,
	users,
	type MailboxRow,
	type UserRow,
} from "../db/users-schema.ts";
import type { Env } from "../types.ts";

export type MailboxAccessRow = MailboxRow & {
	membership_user_id: string | null;
};

export type MailboxManagementRow = MailboxRow & {
	member_count: number;
};

export type MailboxMember = Pick<
	UserRow,
	"id" | "email" | "role" | "is_active"
>;

export type MailboxAccessErrorCode = "FORBIDDEN" | "NOT_FOUND" | "CONFLICT";

export class MailboxAccessError extends Error {
	readonly code: MailboxAccessErrorCode;

	constructor(code: MailboxAccessErrorCode, message: string) {
		super(message);
		this.name = "MailboxAccessError";
		this.code = code;
	}
}

export type MailboxAccessStore = {
	getUser: (userId: string) => Promise<UserRow | undefined>;
	listMailboxAccessRows: (userId: string) => Promise<MailboxAccessRow[]>;
	getMailboxAccessRow: (
		userId: string,
		mailboxId: string,
	) => Promise<MailboxAccessRow | undefined>;
	getMailbox: (mailboxId: string) => Promise<MailboxRow | undefined>;
	listMailboxes: () => Promise<MailboxRow[]>;
	listMembershipMailboxIds: () => Promise<Array<{ mailbox_id: string }>>;
	listMailboxMembers: (mailboxId: string) => Promise<MailboxMember[]>;
	addMailbox: (mailbox: MailboxRow) => Promise<boolean>;
	setMailboxActive: (mailboxId: string, isActive: boolean) => Promise<boolean>;
	addMembership: (mailboxId: string, userId: string) => Promise<boolean>;
	removeMembership: (mailboxId: string, userId: string) => Promise<boolean>;
};

export type SharedMailboxManagementAccess = {
	requireMailboxAdministrator: (adminUserId: string) => Promise<void>;
	listManagedMailboxes: (adminUserId: string) => Promise<MailboxManagementRow[]>;
	registerSharedMailbox: (
		adminUserId: string,
		address: string,
	) => Promise<MailboxRow>;
	listSharedMailboxMembers: (
		adminUserId: string,
		mailboxId: string,
	) => Promise<MailboxMember[]>;
	addSharedMailboxMember: (
		adminUserId: string,
		mailboxId: string,
		memberUserId: string,
	) => Promise<MailboxMember>;
	removeSharedMailboxMember: (
		adminUserId: string,
		mailboxId: string,
		memberUserId: string,
	) => Promise<void>;
	deactivateMailbox: (
		adminUserId: string,
		mailboxId: string,
	) => Promise<void>;
};

function mailboxFromAccessRow(row: MailboxAccessRow): MailboxRow {
	return {
		id: row.id,
		address: row.address,
		type: row.type,
		owner_user_id: row.owner_user_id,
		is_active: row.is_active,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function rowGrantsAccess(row: MailboxAccessRow, userId: string): boolean {
	if (row.is_active !== 1) return false;
	if (row.type === "PERSONAL") return row.owner_user_id === userId;
	return row.membership_user_id === userId;
}

export function createMailboxAccess(store: MailboxAccessStore) {
	async function requireActiveAdmin(adminUserId: string): Promise<void> {
		const admin = await store.getUser(adminUserId);
		if (!admin || admin.is_active !== 1 || admin.role !== "ADMIN") {
			throw new MailboxAccessError(
				"FORBIDDEN",
				"Only an active administrator can manage mailboxes",
			);
		}
	}

	async function requireSharedMailbox(mailboxId: string): Promise<MailboxRow> {
		const mailbox = await store.getMailbox(mailboxId.toLowerCase());
		if (!mailbox) {
			throw new MailboxAccessError("NOT_FOUND", "Mailbox was not found");
		}
		if (mailbox.type !== "SHARED") {
			throw new MailboxAccessError(
				"CONFLICT",
				"Membership can only be changed for Shared Mailboxes",
			);
		}
		return mailbox;
	}

	return {
		async canManageAutomationRules(
			userId: string,
			mailboxId: string,
		): Promise<boolean> {
			const [user, mailbox] = await Promise.all([
				store.getUser(userId),
				store.getMailbox(mailboxId.toLowerCase()),
			]);
			if (!user || user.is_active !== 1 || !mailbox || mailbox.is_active !== 1) {
				return false;
			}
			// Shared automation rules were always administrator-only, so a non-admin
			// only ever qualifies through Personal ownership.
			return user.role === "ADMIN" ||
				(mailbox.type === "PERSONAL" && mailbox.owner_user_id === userId);
		},

		async canManageMailboxSettings(
			userId: string,
			mailboxId: string,
		): Promise<boolean> {
			const [user, mailbox] = await Promise.all([
				store.getUser(userId),
				store.getMailbox(mailboxId.toLowerCase()),
			]);
			if (!user || user.is_active !== 1 || !mailbox || mailbox.is_active !== 1) {
				return false;
			}
			return user.role === "ADMIN" ||
				(mailbox.type === "PERSONAL" && mailbox.owner_user_id === userId);
		},

		async requireMailboxAdministrator(adminUserId: string): Promise<void> {
			await requireActiveAdmin(adminUserId);
		},

		async listAccessibleMailboxes(userId: string): Promise<MailboxRow[]> {
			const user = await store.getUser(userId);
			if (!user || user.is_active !== 1) return [];
			if (user.role === "ADMIN") {
				return (await store.listMailboxes()).filter(
					(mailbox) => mailbox.is_active === 1,
				);
			}

			const rows = await store.listMailboxAccessRows(userId);
			return rows
				.filter((row) => rowGrantsAccess(row, userId))
				.map(mailboxFromAccessRow);
		},

		async canAccessMailbox(userId: string, mailboxId: string): Promise<boolean> {
			const user = await store.getUser(userId);
			if (!user || user.is_active !== 1) return false;
			if (user.role === "ADMIN") {
				return (await store.getMailbox(mailboxId))?.is_active === 1;
			}

			const row = await store.getMailboxAccessRow(userId, mailboxId);
			return row ? rowGrantsAccess(row, userId) : false;
		},

		async listManagedMailboxes(
			adminUserId: string,
		): Promise<MailboxManagementRow[]> {
			await requireActiveAdmin(adminUserId);
			const [registeredMailboxes, membershipRows] = await Promise.all([
				store.listMailboxes(),
				store.listMembershipMailboxIds(),
			]);
			const memberCounts = new Map<string, number>();
			for (const membership of membershipRows) {
				memberCounts.set(
					membership.mailbox_id,
					(memberCounts.get(membership.mailbox_id) ?? 0) + 1,
				);
			}
			return registeredMailboxes.map((mailbox) => ({
				...mailbox,
				member_count: memberCounts.get(mailbox.id) ?? 0,
			}));
		},

		async registerSharedMailbox(
			adminUserId: string,
			address: string,
		): Promise<MailboxRow> {
			await requireActiveAdmin(adminUserId);
			const normalized = address.toLowerCase();
			const now = Date.now();
			const row: MailboxRow = {
				id: normalized,
				address: normalized,
				type: "SHARED",
				owner_user_id: null,
				is_active: 1,
				created_at: now,
				updated_at: now,
			};
			if (!(await store.addMailbox(row))) {
				throw new MailboxAccessError(
					"CONFLICT",
					"Mailbox is already registered",
				);
			}
			return row;
		},

		async deactivateMailbox(
			adminUserId: string,
			mailboxId: string,
		): Promise<void> {
			await requireActiveAdmin(adminUserId);
			if (!(await store.setMailboxActive(mailboxId.toLowerCase(), false))) {
				throw new MailboxAccessError("NOT_FOUND", "Mailbox was not found");
			}
		},

		async listSharedMailboxMembers(
			adminUserId: string,
			mailboxId: string,
		): Promise<MailboxMember[]> {
			await requireActiveAdmin(adminUserId);
			const mailbox = await requireSharedMailbox(mailboxId);
			return store.listMailboxMembers(mailbox.id);
		},

		async addSharedMailboxMember(
			adminUserId: string,
			mailboxId: string,
			memberUserId: string,
		): Promise<MailboxMember> {
			await requireActiveAdmin(adminUserId);
			const mailbox = await requireSharedMailbox(mailboxId);
			const member = await store.getUser(memberUserId);
			if (!member) {
				throw new MailboxAccessError("NOT_FOUND", "User was not found");
			}
			if (member.is_active !== 1) {
				throw new MailboxAccessError(
					"CONFLICT",
					"A Shared Mailbox member must be active",
				);
			}
			if (!(await store.addMembership(mailbox.id, memberUserId))) {
				throw new MailboxAccessError(
					"CONFLICT",
					"User is already a Shared Mailbox member",
				);
			}
			return {
				id: member.id,
				email: member.email,
				role: member.role,
				is_active: member.is_active,
			};
		},

		async removeSharedMailboxMember(
			adminUserId: string,
			mailboxId: string,
			memberUserId: string,
		): Promise<void> {
			await requireActiveAdmin(adminUserId);
			const mailbox = await requireSharedMailbox(mailboxId);
			if (!(await store.removeMembership(mailbox.id, memberUserId))) {
				throw new MailboxAccessError(
					"NOT_FOUND",
					"Shared Mailbox member was not found",
				);
			}
		},
	};
}

function d1MailboxAccessStore(env: Env): MailboxAccessStore {
	const database = drizzle(env.DB);
	const mailboxSelection = {
		id: mailboxes.id,
		address: mailboxes.address,
		type: mailboxes.type,
		owner_user_id: mailboxes.owner_user_id,
		is_active: mailboxes.is_active,
		created_at: mailboxes.created_at,
		updated_at: mailboxes.updated_at,
		membership_user_id: mailboxMemberships.user_id,
	};

	return {
		async getUser(userId) {
			return database.select().from(users).where(eq(users.id, userId)).get();
		},
		async listMailboxAccessRows(userId) {
			return database
				.select(mailboxSelection)
				.from(mailboxes)
				.leftJoin(
					mailboxMemberships,
					and(
						eq(mailboxMemberships.mailbox_id, mailboxes.id),
						eq(mailboxMemberships.user_id, userId),
					),
				)
				.where(
					and(
						eq(mailboxes.is_active, 1),
						or(
							and(
								eq(mailboxes.type, "PERSONAL"),
								eq(mailboxes.owner_user_id, userId),
							),
							and(
								eq(mailboxes.type, "SHARED"),
								eq(mailboxMemberships.user_id, userId),
							),
						),
					),
				)
				.all();
		},
		async getMailboxAccessRow(userId, mailboxId) {
			return database
				.select(mailboxSelection)
				.from(mailboxes)
				.leftJoin(
					mailboxMemberships,
					and(
						eq(mailboxMemberships.mailbox_id, mailboxes.id),
						eq(mailboxMemberships.user_id, userId),
					),
				)
				.where(
					and(
						eq(mailboxes.id, mailboxId),
						eq(mailboxes.is_active, 1),
						or(
							and(
								eq(mailboxes.type, "PERSONAL"),
								eq(mailboxes.owner_user_id, userId),
							),
							and(
								eq(mailboxes.type, "SHARED"),
								eq(mailboxMemberships.user_id, userId),
							),
						),
					),
				)
				.get();
		},
		async getMailbox(mailboxId) {
			return database
				.select()
				.from(mailboxes)
				.where(eq(mailboxes.id, mailboxId))
				.get();
		},
		async listMailboxes() {
			return database.select().from(mailboxes).all();
		},
		async listMembershipMailboxIds() {
			return database
				.select({ mailbox_id: mailboxMemberships.mailbox_id })
				.from(mailboxMemberships)
				.all();
		},
		async listMailboxMembers(mailboxId) {
			return database
				.select({
					id: users.id,
					email: users.email,
					role: users.role,
					is_active: users.is_active,
				})
				.from(mailboxMemberships)
				.innerJoin(users, eq(users.id, mailboxMemberships.user_id))
				.where(eq(mailboxMemberships.mailbox_id, mailboxId))
				.all();
		},
		async addMailbox(mailbox) {
			const inserted = await database
				.insert(mailboxes)
				.values(mailbox)
				.onConflictDoNothing()
				.returning({ id: mailboxes.id })
				.get();
			return Boolean(inserted);
		},
		async setMailboxActive(mailboxId, isActive) {
			const updated = await database
				.update(mailboxes)
				.set({ is_active: isActive ? 1 : 0, updated_at: Date.now() })
				.where(eq(mailboxes.id, mailboxId))
				.returning({ id: mailboxes.id })
				.get();
			return Boolean(updated);
		},
		async addMembership(mailboxId, userId) {
			const inserted = await database
				.insert(mailboxMemberships)
				.values({ mailbox_id: mailboxId, user_id: userId, created_at: Date.now() })
				.onConflictDoNothing()
				.returning({ user_id: mailboxMemberships.user_id })
				.get();
			return Boolean(inserted);
		},
		async removeMembership(mailboxId, userId) {
			const deleted = await database
				.delete(mailboxMemberships)
				.where(
					and(
						eq(mailboxMemberships.mailbox_id, mailboxId),
						eq(mailboxMemberships.user_id, userId),
					),
				)
				.returning({ user_id: mailboxMemberships.user_id })
				.get();
			return Boolean(deleted);
		},
	};
}

export function mailboxAccess(env: Env) {
	return createMailboxAccess(d1MailboxAccessStore(env));
}

export async function unregisterMailbox(
	env: Env,
	mailboxId: string,
): Promise<void> {
	await drizzle(env.DB)
		.delete(mailboxes)
		.where(eq(mailboxes.id, mailboxId.toLowerCase()))
		.run();
}
