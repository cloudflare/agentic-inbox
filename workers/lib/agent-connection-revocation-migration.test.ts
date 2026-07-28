import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0003_create_mailbox_access.sql",
    "0005_auth_security.sql",
    "0010_create_agent_connection_revocations.sql",
    "0013_revoke_admin_agent_connections.sql",
  ]) {
    db.exec(
      readFileSync(
        new URL(`../../migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  }
  db.prepare(
    `INSERT INTO users
       (id, email, password_hash, password_salt, session_version, role, is_active,
        mailbox_address, created_at, updated_at)
     VALUES ('user-1', 'one@example.com', 'hash', 'salt', 1, 'AGENT', 1,
             'one@example.com', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO mailboxes
       (id, address, type, owner_user_id, is_active, created_at, updated_at)
     VALUES ('one@example.com', 'one@example.com', 'PERSONAL', 'user-1', 1, 1, 1),
            ('team@example.com', 'team@example.com', 'SHARED', NULL, 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at)
     VALUES ('team@example.com', 'user-1', 1)`,
  ).run();
  return db;
}

// An administrator reaches one@example.com and team@example.com through role
// alone, owns admin@example.com, and is redundantly a member of team@example.com
// so the enqueued set has to de-duplicate. retired@example.com is inactive and
// therefore unreachable.
function withAdministrator(db: DatabaseSync): DatabaseSync {
  db.prepare(
    `INSERT INTO users
       (id, email, password_hash, password_salt, session_version, role, is_active,
        mailbox_address, created_at, updated_at)
     VALUES ('user-2', 'admin@example.com', 'hash', 'salt', 1, 'ADMIN', 1,
             'admin@example.com', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO mailboxes
       (id, address, type, owner_user_id, is_active, created_at, updated_at)
     VALUES ('admin@example.com', 'admin@example.com', 'PERSONAL', 'user-2', 1, 1, 1),
            ('retired@example.com', 'retired@example.com', 'SHARED', NULL, 0, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at)
     VALUES ('team@example.com', 'user-2', 1)`,
  ).run();
  return db;
}

function enqueuedMailboxIds(db: DatabaseSync): string[] {
  return db
    .prepare(
      `SELECT mailbox_id FROM agent_connection_revocations
       WHERE scope = 'ACTOR' AND user_id = 'user-2'
       ORDER BY mailbox_id`,
    )
    .all()
    .map((row) => row.mailbox_id as string);
}

test("an administrator's revocation reaches every active mailbox, role-only ones included", () => {
  const db = withAdministrator(database());

  db.prepare(
    "UPDATE users SET session_version = session_version + 1 WHERE id = 'user-2'",
  ).run();
  assert.deepEqual(enqueuedMailboxIds(db), [
    "admin@example.com",
    "one@example.com",
    "team@example.com",
  ]);

  db.exec("DELETE FROM agent_connection_revocations");
  db.prepare("UPDATE users SET is_active = 0 WHERE id = 'user-2'").run();
  assert.deepEqual(enqueuedMailboxIds(db), [
    "admin@example.com",
    "one@example.com",
    "team@example.com",
  ]);
  db.close();
});

test("administrator demotion enqueues the same role-wide reconciliation", () => {
  const db = withAdministrator(database());

  db.prepare("UPDATE users SET role = 'AGENT' WHERE id = 'user-2'").run();
  assert.deepEqual(enqueuedMailboxIds(db), [
    "admin@example.com",
    "one@example.com",
    "team@example.com",
  ]);

  // Promotion grants access rather than removing it, so it enqueues nothing.
  db.exec("DELETE FROM agent_connection_revocations");
  db.prepare("UPDATE users SET role = 'ADMIN' WHERE id = 'user-2'").run();
  assert.deepEqual(enqueuedMailboxIds(db), []);
  db.close();
});

test("authorization mutations enqueue durable Agent reconciliation in the same transaction", () => {
  const db = database();

  db.prepare(
    "UPDATE users SET session_version = session_version + 1 WHERE id = 'user-1'",
  ).run();
  assert.deepEqual(
    db
      .prepare(
        `SELECT scope, mailbox_id, user_id
         FROM agent_connection_revocations
         ORDER BY mailbox_id`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { scope: "ACTOR", mailbox_id: "one@example.com", user_id: "user-1" },
      { scope: "ACTOR", mailbox_id: "team@example.com", user_id: "user-1" },
    ],
  );

  db.exec("DELETE FROM agent_connection_revocations");
  db.prepare(
    "DELETE FROM mailbox_memberships WHERE mailbox_id = 'team@example.com' AND user_id = 'user-1'",
  ).run();
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT scope, mailbox_id, user_id FROM agent_connection_revocations",
      ).get(),
    },
    { scope: "ACTOR", mailbox_id: "team@example.com", user_id: "user-1" },
  );

  db.exec("DELETE FROM agent_connection_revocations");
  db.prepare(
    "UPDATE mailboxes SET is_active = 0 WHERE id = 'team@example.com'",
  ).run();
  assert.deepEqual(
    {
      ...db.prepare(
        "SELECT scope, mailbox_id, user_id FROM agent_connection_revocations",
      ).get(),
    },
    { scope: "MAILBOX", mailbox_id: "team@example.com", user_id: null },
  );
  db.close();
});

test("unrelated updates and rolled-back mutations create no revocation work", () => {
  const db = database();
  db.prepare("UPDATE users SET updated_at = 2 WHERE id = 'user-1'").run();
  db.prepare(
    "UPDATE mailboxes SET updated_at = 2 WHERE id = 'team@example.com'",
  ).run();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM agent_connection_revocations").get()!
      .count,
    0,
  );

  db.exec("BEGIN IMMEDIATE");
  db.prepare(
    "UPDATE users SET session_version = session_version + 1 WHERE id = 'user-1'",
  ).run();
  db.exec("ROLLBACK");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM agent_connection_revocations").get()!
      .count,
    0,
  );
  db.close();
});

test("outbox constraints reject malformed targets and lease state", () => {
  const db = database();
  assert.throws(() =>
    db.prepare(
      `INSERT INTO agent_connection_revocations
       (id, scope, mailbox_id, user_id, next_attempt_at, lease_token,
        lease_expires_at, created_at, updated_at)
       VALUES ('bad-actor', 'ACTOR', 'team@example.com', NULL, 1, NULL, NULL, 1, 1)`,
    ).run(),
  );
  assert.throws(() =>
    db.prepare(
      `INSERT INTO agent_connection_revocations
       (id, scope, mailbox_id, user_id, next_attempt_at, lease_token,
        lease_expires_at, created_at, updated_at)
       VALUES ('bad-lease', 'MAILBOX', 'team@example.com', NULL, 1, 'lease', NULL, 1, 1)`,
    ).run(),
  );
  db.close();
});
