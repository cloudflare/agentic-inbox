-- Replace admin@example.com before running.
-- Local:
--   bunx wrangler d1 execute dumb-inbox-app --local --file DOCS/seed-admin.sql
-- Remote:
--   bunx wrangler d1 execute dumb-inbox-app --remote --file DOCS/seed-admin.sql

INSERT INTO users (
	id,
	email,
	access_sub,
	status,
	global_role,
	display_name,
	created_at,
	updated_at,
	last_login_at
) VALUES (
	'admin-' || lower(hex(randomblob(16))),
	'admin@example.com',
	NULL,
	'active',
	'admin',
	'Admin',
	datetime('now'),
	datetime('now'),
	NULL
);
