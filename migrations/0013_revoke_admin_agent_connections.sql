-- An active administrator is member-equivalent on every active mailbox, so the
-- revocation outbox has to enumerate that access class too. Migration 0010
-- derived the affected set from ownership and membership alone, which left a
-- revoked or deactivated administrator's live Agent sockets on role-only
-- mailboxes receiving broadcast frames.
--
-- Demotion is covered by the same trigger: no application path writes
-- users.role, so an administrator downgraded out of band would otherwise lose
-- role access silently, with nothing reaching the outbox.
DROP TRIGGER users_enqueue_agent_connection_reconciliation;

CREATE TRIGGER users_enqueue_agent_connection_reconciliation
AFTER UPDATE OF session_version, is_active, role ON users
WHEN NEW.session_version <> OLD.session_version
  OR (OLD.is_active = 1 AND NEW.is_active = 0)
  OR (OLD.role = 'ADMIN' AND NEW.role <> 'ADMIN')
BEGIN
  INSERT INTO agent_connection_revocations (
    id, scope, mailbox_id, user_id, attempt_count, next_attempt_at,
    lease_token, lease_expires_at, last_error_code, created_at, updated_at
  )
  SELECT
    'acr_' || lower(hex(randomblob(16))),
    'ACTOR',
    access.mailbox_id,
    NEW.id,
    0,
    unixepoch() * 1000,
    NULL,
    NULL,
    NULL,
    unixepoch() * 1000,
    unixepoch() * 1000
  FROM (
    SELECT id AS mailbox_id FROM mailboxes WHERE owner_user_id = NEW.id
    UNION
    SELECT mailbox_id FROM mailbox_memberships WHERE user_id = NEW.id
    UNION
    SELECT id AS mailbox_id FROM mailboxes
    WHERE is_active = 1 AND (NEW.role = 'ADMIN' OR OLD.role = 'ADMIN')
  ) AS access;
END;
