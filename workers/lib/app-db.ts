import {
	buildPendingRegistration,
	getCapabilitiesForRole,
	normalizeEmail,
	resolveAccessUser,
	type AccessIdentity,
	type AppUserRecord,
	type GlobalRole,
	type MailboxCapabilities,
	type MailboxRole,
	type UserStatus,
} from "./permissions";

export interface MailboxRecord {
	id: string;
	email: string;
	name: string;
	status: "active" | "disabled";
	createdAt: string;
	updatedAt: string;
}

export interface MailboxWithAccess extends MailboxRecord {
	role: "admin" | MailboxRole;
	capabilities: MailboxCapabilities;
}

export interface MailboxMembershipRecord {
	mailboxId: string;
	userId: string;
	email: string;
	displayName: string | null;
	status: UserStatus;
	role: MailboxRole;
	capabilities: MailboxCapabilities;
	createdAt: string;
	updatedAt: string;
}

export interface ResponseTemplateRecord {
	id: string;
	mailboxId: string;
	name: string;
	subject: string;
	bodyHtml: string;
	bodyText: string | null;
	createdBy: string;
	updatedBy: string;
	createdAt: string;
	updatedAt: string;
}

export interface AiMailboxSettingsRecord {
	mailboxId: string;
	enabled: boolean;
	model: string | null;
	systemPrompt: string | null;
	updatedBy: string | null;
	updatedAt: string | null;
}

interface UserRow {
	id: string;
	email: string;
	access_sub: string | null;
	status: UserStatus;
	global_role: GlobalRole;
	display_name: string | null;
	created_at: string;
	updated_at: string;
	last_login_at: string | null;
}

interface MailboxRow {
	id: string;
	email: string;
	name: string;
	status: "active" | "disabled";
	created_at: string;
	updated_at: string;
}

interface MembershipRow {
	mailbox_id: string;
	user_id: string;
	email: string;
	display_name: string | null;
	status: UserStatus;
	role: MailboxRole;
	created_at: string;
	updated_at: string;
}

interface TemplateRow {
	id: string;
	mailbox_id: string;
	name: string;
	subject: string | null;
	body_html: string;
	body_text: string | null;
	created_by: string;
	updated_by: string;
	created_at: string;
	updated_at: string;
}

interface AiSettingsRow {
	mailbox_id: string;
	enabled: number;
	model: string | null;
	system_prompt: string | null;
	updated_by: string | null;
	updated_at: string | null;
}

let schemaReady: Promise<void> | null = null;

export function nowIso(): string {
	return new Date().toISOString();
}

export async function ensureAppSchema(db: D1Database): Promise<void> {
	const statements = [
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE,
			access_sub TEXT UNIQUE,
			status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
			global_role TEXT NOT NULL DEFAULT 'none' CHECK (global_role IN ('admin', 'none')),
			display_name TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_login_at TEXT
		)`,

		`CREATE TABLE IF NOT EXISTS mailboxes (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,

		`CREATE TABLE IF NOT EXISTS mailbox_memberships (
			mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			role TEXT NOT NULL CHECK (role IN ('manager', 'responder', 'viewer')),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (mailbox_id, user_id)
		)`,

		`CREATE TABLE IF NOT EXISTS response_templates (
			id TEXT PRIMARY KEY,
			mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			subject TEXT,
			body_html TEXT NOT NULL,
			body_text TEXT,
			created_by TEXT NOT NULL REFERENCES users(id),
			updated_by TEXT NOT NULL REFERENCES users(id),
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,

		`CREATE TABLE IF NOT EXISTS ai_mailbox_settings (
			mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
			enabled INTEGER NOT NULL DEFAULT 0,
			model TEXT,
			system_prompt TEXT,
			updated_by TEXT REFERENCES users(id),
			updated_at TEXT
		)`,

		`CREATE TABLE IF NOT EXISTS ai_generation_audit (
			id TEXT PRIMARY KEY,
			mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
			email_id TEXT NOT NULL,
			user_id TEXT NOT NULL REFERENCES users(id),
			model TEXT NOT NULL,
			template_id TEXT,
			created_at TEXT NOT NULL
		)`,

		"CREATE INDEX IF NOT EXISTS idx_users_access_sub ON users(access_sub)",
		"CREATE INDEX IF NOT EXISTS idx_mailbox_memberships_user ON mailbox_memberships(user_id)",
		"CREATE INDEX IF NOT EXISTS idx_templates_mailbox ON response_templates(mailbox_id)",
		"CREATE INDEX IF NOT EXISTS idx_ai_audit_mailbox ON ai_generation_audit(mailbox_id, created_at)",
	];
	for (const statement of statements) {
		await db.exec(statement.replace(/\s+/g, " ").trim());
	}
}

export function ensureAppSchemaOnce(db: D1Database): Promise<void> {
	schemaReady ??= ensureAppSchema(db).catch((error: unknown) => {
		schemaReady = null;
		throw error;
	});
	return schemaReady;
}

function toUser(row: UserRow): AppUserRecord {
	return {
		id: row.id,
		email: row.email,
		accessSub: row.access_sub,
		status: row.status,
		globalRole: row.global_role,
		displayName: row.display_name,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastLoginAt: row.last_login_at,
	};
}

function toMailbox(row: MailboxRow): MailboxRecord {
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function toTemplate(row: TemplateRow): ResponseTemplateRecord {
	return {
		id: row.id,
		mailboxId: row.mailbox_id,
		name: row.name,
		subject: row.subject ?? "",
		bodyHtml: row.body_html,
		bodyText: row.body_text,
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function toAiSettings(row: AiSettingsRow | null, mailboxId: string): AiMailboxSettingsRecord {
	return {
		mailboxId,
		enabled: row ? row.enabled === 1 : false,
		model: row?.model ?? null,
		systemPrompt: row?.system_prompt ?? null,
		updatedBy: row?.updated_by ?? null,
		updatedAt: row?.updated_at ?? null,
	};
}

export async function getUserBySub(
	db: D1Database,
	accessSub: string,
): Promise<AppUserRecord | null> {
	const row = await db
		.prepare("SELECT * FROM users WHERE access_sub = ?1 LIMIT 1")
		.bind(accessSub)
		.first<UserRow>();
	return row ? toUser(row) : null;
}

export async function getUserByEmail(
	db: D1Database,
	email: string,
): Promise<AppUserRecord | null> {
	const row = await db
		.prepare("SELECT * FROM users WHERE email = ?1 LIMIT 1")
		.bind(normalizeEmail(email))
		.first<UserRow>();
	return row ? toUser(row) : null;
}

export async function getUserByIdOrEmail(
	db: D1Database,
	idOrEmail: string,
): Promise<AppUserRecord | null> {
	const normalized = normalizeEmail(idOrEmail);
	const row = await db
		.prepare("SELECT * FROM users WHERE id = ?1 OR email = ?2 LIMIT 1")
		.bind(idOrEmail, normalized)
		.first<UserRow>();
	return row ? toUser(row) : null;
}

async function putUser(db: D1Database, user: AppUserRecord): Promise<AppUserRecord> {
	await db
		.prepare(`
			INSERT INTO users (id, email, access_sub, status, global_role, display_name, created_at, updated_at, last_login_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
			ON CONFLICT(id) DO UPDATE SET
				email = excluded.email,
				access_sub = excluded.access_sub,
				status = excluded.status,
				global_role = excluded.global_role,
				display_name = excluded.display_name,
				updated_at = excluded.updated_at,
				last_login_at = excluded.last_login_at
		`)
		.bind(
			user.id,
			user.email,
			user.accessSub,
			user.status,
			user.globalRole,
			user.displayName,
			user.createdAt,
			user.updatedAt,
			user.lastLoginAt,
		)
		.run();
	return user;
}

export async function resolveCurrentUser(
	db: D1Database,
	identity: AccessIdentity,
	now: string,
): Promise<AppUserRecord | null> {
	const userBySub = await getUserBySub(db, identity.sub);
	const userByEmail = userBySub ? null : await getUserByEmail(db, identity.email);
	const resolved = resolveAccessUser(identity, userBySub, userByEmail, now);
	if (!resolved.user) return null;
	if (resolved.action !== "none") await putUser(db, resolved.user);
	return resolved.user;
}

export async function registerIdentityUser(
	db: D1Database,
	identity: AccessIdentity,
	now: string,
): Promise<AppUserRecord> {
	const existing = await resolveCurrentUser(db, identity, now);
	if (existing) return existing;
	return putUser(db, buildPendingRegistration(identity, crypto.randomUUID(), now));
}

export async function listUsers(db: D1Database): Promise<AppUserRecord[]> {
	const result = await db
		.prepare("SELECT * FROM users ORDER BY email ASC")
		.all<UserRow>();
	return (result.results ?? []).map(toUser);
}

export async function updateUser(
	db: D1Database,
	userId: string,
	input: {
		status?: UserStatus;
		globalRole?: GlobalRole;
		displayName?: string | null;
	},
	now: string,
): Promise<AppUserRecord | null> {
	const existing = await getUserByIdOrEmail(db, userId);
	if (!existing) return null;
	const next: AppUserRecord = {
		...existing,
		status: input.status ?? existing.status,
		globalRole: input.globalRole ?? existing.globalRole,
		displayName: input.displayName === undefined ? existing.displayName : input.displayName,
		updatedAt: now,
	};
	return putUser(db, next);
}

export async function upsertMailboxRecord(
	db: D1Database,
	input: { email: string; name: string; status?: "active" | "disabled" },
	now: string,
): Promise<MailboxRecord> {
	const email = normalizeEmail(input.email);
	const status = input.status ?? "active";
	await db
		.prepare(`
			INSERT INTO mailboxes (id, email, name, status, created_at, updated_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6)
			ON CONFLICT(id) DO UPDATE SET
				email = excluded.email,
				name = excluded.name,
				status = excluded.status,
				updated_at = excluded.updated_at
		`)
		.bind(email, email, input.name, status, now, now)
		.run();
	const mailbox = await getMailboxRecord(db, email);
	if (!mailbox) throw new Error(`Failed to upsert mailbox ${email}`);
	return mailbox;
}

export async function getMailboxRecord(
	db: D1Database,
	mailboxId: string,
): Promise<MailboxRecord | null> {
	const email = normalizeEmail(mailboxId);
	const row = await db
		.prepare("SELECT * FROM mailboxes WHERE id = ?1 AND status = 'active' LIMIT 1")
		.bind(email)
		.first<MailboxRow>();
	return row ? toMailbox(row) : null;
}

export async function listMailboxesForUser(
	db: D1Database,
	user: AppUserRecord,
): Promise<MailboxWithAccess[]> {
	if (user.globalRole === "admin") {
		const result = await db
			.prepare("SELECT * FROM mailboxes WHERE status = 'active' ORDER BY email ASC")
			.all<MailboxRow>();
		return (result.results ?? []).map((row) => ({
			...toMailbox(row),
			role: "admin",
			capabilities: getCapabilitiesForRole("admin"),
		}));
	}

	const result = await db
		.prepare(`
			SELECT m.*
			FROM mailboxes m
			INNER JOIN mailbox_memberships mm ON mm.mailbox_id = m.id
			WHERE mm.user_id = ?1 AND m.status = 'active'
			ORDER BY m.email ASC
		`)
		.bind(user.id)
		.all<MailboxRow>();

	const mailboxes: MailboxWithAccess[] = [];
	for (const row of result.results ?? []) {
		const role = await getMailboxRole(db, user, row.id);
		if (role === "none" || role === "admin") continue;
		mailboxes.push({
			...toMailbox(row),
			role,
			capabilities: getCapabilitiesForRole(role),
		});
	}
	return mailboxes;
}

export async function getMailboxRole(
	db: D1Database,
	user: AppUserRecord,
	mailboxId: string,
): Promise<"admin" | MailboxRole | "none"> {
	if (user.globalRole === "admin") return "admin";
	const row = await db
		.prepare(`
			SELECT role FROM mailbox_memberships
			WHERE mailbox_id = ?1 AND user_id = ?2
			LIMIT 1
		`)
		.bind(normalizeEmail(mailboxId), user.id)
		.first<{ role: MailboxRole }>();
	return row?.role ?? "none";
}

export async function listMailboxMemberships(
	db: D1Database,
	mailboxId: string,
): Promise<MailboxMembershipRecord[]> {
	const result = await db
		.prepare(`
			SELECT mm.mailbox_id, mm.user_id, u.email, u.display_name, u.status, mm.role, mm.created_at, mm.updated_at
			FROM mailbox_memberships mm
			INNER JOIN users u ON u.id = mm.user_id
			WHERE mm.mailbox_id = ?1
			ORDER BY u.email ASC
		`)
		.bind(normalizeEmail(mailboxId))
		.all<MembershipRow>();
	return (result.results ?? []).map((row) => ({
		mailboxId: row.mailbox_id,
		userId: row.user_id,
		email: row.email,
		displayName: row.display_name,
		status: row.status,
		role: row.role,
		capabilities: getCapabilitiesForRole(row.role),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}));
}

export async function upsertMailboxMembership(
	db: D1Database,
	mailboxId: string,
	userIdOrEmail: string,
	role: MailboxRole,
	now: string,
): Promise<MailboxMembershipRecord | null> {
	const mailbox = await getMailboxRecord(db, mailboxId);
	const user = await getUserByIdOrEmail(db, userIdOrEmail);
	if (!mailbox || !user) return null;
	await db
		.prepare(`
			INSERT INTO mailbox_memberships (mailbox_id, user_id, role, created_at, updated_at)
			VALUES (?1, ?2, ?3, ?4, ?5)
			ON CONFLICT(mailbox_id, user_id) DO UPDATE SET
				role = excluded.role,
				updated_at = excluded.updated_at
		`)
		.bind(mailbox.id, user.id, role, now, now)
		.run();
	const memberships = await listMailboxMemberships(db, mailbox.id);
	return memberships.find((membership) => membership.userId === user.id) ?? null;
}

export async function deleteMailboxMembership(
	db: D1Database,
	mailboxId: string,
	userIdOrEmail: string,
): Promise<boolean> {
	const user = await getUserByIdOrEmail(db, userIdOrEmail);
	if (!user) return false;
	const result = await db
		.prepare("DELETE FROM mailbox_memberships WHERE mailbox_id = ?1 AND user_id = ?2")
		.bind(normalizeEmail(mailboxId), user.id)
		.run();
	return result.meta.changes > 0;
}

export async function listTemplates(
	db: D1Database,
	mailboxId: string,
): Promise<ResponseTemplateRecord[]> {
	const result = await db
		.prepare("SELECT * FROM response_templates WHERE mailbox_id = ?1 ORDER BY name ASC")
		.bind(normalizeEmail(mailboxId))
		.all<TemplateRow>();
	return (result.results ?? []).map(toTemplate);
}

export async function createTemplate(
	db: D1Database,
	mailboxId: string,
	userId: string,
	input: { name: string; subject?: string; bodyHtml: string; bodyText?: string | null },
	now: string,
): Promise<ResponseTemplateRecord> {
	const id = crypto.randomUUID();
	await db
		.prepare(`
			INSERT INTO response_templates (id, mailbox_id, name, subject, body_html, body_text, created_by, updated_by, created_at, updated_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
		`)
		.bind(
			id,
			normalizeEmail(mailboxId),
			input.name,
			input.subject ?? "",
			input.bodyHtml,
			input.bodyText ?? null,
			userId,
			userId,
			now,
			now,
		)
		.run();
	const template = await getTemplate(db, mailboxId, id);
	if (!template) throw new Error("Failed to create template");
	return template;
}

export async function getTemplate(
	db: D1Database,
	mailboxId: string,
	templateId: string,
): Promise<ResponseTemplateRecord | null> {
	const row = await db
		.prepare("SELECT * FROM response_templates WHERE mailbox_id = ?1 AND id = ?2 LIMIT 1")
		.bind(normalizeEmail(mailboxId), templateId)
		.first<TemplateRow>();
	return row ? toTemplate(row) : null;
}

export async function updateTemplate(
	db: D1Database,
	mailboxId: string,
	templateId: string,
	userId: string,
	input: { name: string; subject?: string; bodyHtml: string; bodyText?: string | null },
	now: string,
): Promise<ResponseTemplateRecord | null> {
	const result = await db
		.prepare(`
			UPDATE response_templates
			SET name = ?3, subject = ?4, body_html = ?5, body_text = ?6, updated_by = ?7, updated_at = ?8
			WHERE mailbox_id = ?1 AND id = ?2
		`)
		.bind(
			normalizeEmail(mailboxId),
			templateId,
			input.name,
			input.subject ?? "",
			input.bodyHtml,
			input.bodyText ?? null,
			userId,
			now,
		)
		.run();
	if (result.meta.changes === 0) return null;
	return getTemplate(db, mailboxId, templateId);
}

export async function deleteTemplate(
	db: D1Database,
	mailboxId: string,
	templateId: string,
): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM response_templates WHERE mailbox_id = ?1 AND id = ?2")
		.bind(normalizeEmail(mailboxId), templateId)
		.run();
	return result.meta.changes > 0;
}

export async function getAiMailboxSettings(
	db: D1Database,
	mailboxId: string,
): Promise<AiMailboxSettingsRecord> {
	const normalized = normalizeEmail(mailboxId);
	const row = await db
		.prepare("SELECT * FROM ai_mailbox_settings WHERE mailbox_id = ?1 LIMIT 1")
		.bind(normalized)
		.first<AiSettingsRow>();
	return toAiSettings(row, normalized);
}

export async function updateAiMailboxSettings(
	db: D1Database,
	mailboxId: string,
	userId: string,
	input: { enabled: boolean; model?: string | null; systemPrompt?: string | null },
	now: string,
): Promise<AiMailboxSettingsRecord> {
	const normalized = normalizeEmail(mailboxId);
	await db
		.prepare(`
			INSERT INTO ai_mailbox_settings (mailbox_id, enabled, model, system_prompt, updated_by, updated_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6)
			ON CONFLICT(mailbox_id) DO UPDATE SET
				enabled = excluded.enabled,
				model = excluded.model,
				system_prompt = excluded.system_prompt,
				updated_by = excluded.updated_by,
				updated_at = excluded.updated_at
		`)
		.bind(
			normalized,
			input.enabled ? 1 : 0,
			input.model ?? null,
			input.systemPrompt ?? null,
			userId,
			now,
		)
		.run();
	return getAiMailboxSettings(db, normalized);
}

export async function recordAiGeneration(
	db: D1Database,
	input: {
		mailboxId: string;
		emailId: string;
		userId: string;
		model: string;
		templateId?: string | null;
	},
	now: string,
): Promise<void> {
	await db
		.prepare(`
			INSERT INTO ai_generation_audit (id, mailbox_id, email_id, user_id, model, template_id, created_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
		`)
		.bind(
			crypto.randomUUID(),
			normalizeEmail(input.mailboxId),
			input.emailId,
			input.userId,
			input.model,
			input.templateId ?? null,
			now,
		)
		.run();
}
