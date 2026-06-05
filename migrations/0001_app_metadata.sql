CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	access_sub TEXT UNIQUE,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
	global_role TEXT NOT NULL DEFAULT 'none' CHECK (global_role IN ('admin', 'none')),
	display_name TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS mailboxes (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox_memberships (
	mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role TEXT NOT NULL CHECK (role IN ('manager', 'responder', 'viewer')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (mailbox_id, user_id)
);

CREATE TABLE IF NOT EXISTS response_templates (
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
);

CREATE TABLE IF NOT EXISTS ai_mailbox_settings (
	mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
	enabled INTEGER NOT NULL DEFAULT 0,
	model TEXT,
	system_prompt TEXT,
	updated_by TEXT REFERENCES users(id),
	updated_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_generation_audit (
	id TEXT PRIMARY KEY,
	mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
	email_id TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users(id),
	model TEXT NOT NULL,
	template_id TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_access_sub ON users(access_sub);
CREATE INDEX IF NOT EXISTS idx_mailbox_memberships_user ON mailbox_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_templates_mailbox ON response_templates(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_ai_audit_mailbox ON ai_generation_audit(mailbox_id, created_at);
