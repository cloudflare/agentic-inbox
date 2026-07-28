import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import { accountLifecycle } from "./account-lifecycle-runtime.ts";
import { sessionMatchesUserVersion } from "./auth.ts";
import { mcpCredentialVersionMatches } from "./mcp-authorization.ts";

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
  async run() {
    return this.runSync();
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
  runSync() {
    const before = totalChanges(this.#db);
    const results = this.statement().all(...this.#values);
    return {
      success: true,
      results,
      meta: { changes: totalChanges(this.#db) - before },
    };
  }
  private statement(): StatementSync {
    return this.#db.prepare(this.#sql);
  }
}

// D1 reports trigger-caused row changes in meta.changes, so the shim reports the
// total_changes() delta rather than the trigger-excluding sqlite3_changes count.
function totalChanges(db: DatabaseSync): number {
  const row = db.prepare("SELECT total_changes() AS total").get() as {
    total: number;
  };
  return Number(row.total);
}

function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new Statement(db, sql);
    },
    async batch(statements: Statement[]) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.runSync());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

test("D1 deactivation stays revoked after reactivation and purges every mailbox device", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0003_create_mailbox_access.sql",
    "0005_auth_security.sql",
    "0006_credential_recovery.sql",
    "0010_create_agent_connection_revocations.sql",
    "0012_create_credential_recovery_jobs.sql",
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
		  mailbox_address, mcp_token_hash, recovery_email, ownership_confirmed_at,
		  created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'AGENT', 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "usr_member",
    "member@wiserchat.ai",
    "old-hash",
    "old-salt",
    4,
    "member@wiserchat.ai",
    "old-mcp",
    null,
    100,
    100,
    100,
  );
  db.prepare(
    `INSERT INTO mailboxes
		 (id, address, type, owner_user_id, is_active, created_at, updated_at)
		 VALUES (?, ?, 'PERSONAL', ?, 1, 100, 100),
		        (?, ?, 'SHARED', NULL, 1, 100, 100)`,
  ).run(
    "member@wiserchat.ai",
    "member@wiserchat.ai",
    "usr_member",
    "team@wiserchat.ai",
    "team@wiserchat.ai",
  );
  db.prepare(
    "INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at) VALUES (?, ?, 100)",
  ).run("team@wiserchat.ai", "usr_member");
  db.prepare(
    `INSERT INTO credential_recovery_tokens
		 (id, user_id, token_hash, expires_at, purpose, created_at)
		 VALUES ('token', 'usr_member', 'hash', 999999, 'recovery', 100)`,
  ).run();

  const purged: string[] = [];
  const disconnected: string[] = [];
  const env = {
    DB: d1(db),
    JWT_SECRET: "test-secret",
    MAILBOX: {
      idFromName(name: string) {
        return name;
      },
      get(id: string) {
        return {
          async removePushSubscriptionsForUser(userId: string) {
            purged.push(`${id}:${userId}`);
          },
        };
      },
    },
  } as unknown as Env;
  const lifecycle = accountLifecycle(env, async (mailboxId, userId) => {
    disconnected.push(`${mailboxId}:${userId}`);
  });
  await lifecycle.deactivate("usr_member");
  await lifecycle.activate("usr_member");

  const user = db
    .prepare(
      "SELECT is_active, password_hash, session_version, mcp_token_hash FROM users WHERE id = 'usr_member'",
    )
    .get() as {
    is_active: number;
    password_hash: string;
    session_version: number;
    mcp_token_hash: string | null;
  };
  assert.equal(user.is_active, 1);
  assert.notEqual(user.password_hash, "old-hash");
  assert.equal(user.mcp_token_hash, null);
  assert.equal(
    sessionMatchesUserVersion(
      { sessionVersion: 4 },
      { session_version: user.session_version },
    ),
    false,
  );
  assert.equal(
    mcpCredentialVersionMatches(
      { sessionVersion: 4 },
      { session_version: user.session_version },
    ),
    false,
  );
  assert.notEqual(
    db
      .prepare(
        "SELECT consumed_at FROM credential_recovery_tokens WHERE id = 'token'",
      )
      .get()!.consumed_at,
    null,
  );
  assert.deepEqual(purged.sort(), [
    "member@wiserchat.ai:usr_member",
    "team@wiserchat.ai:usr_member",
  ]);
  assert.deepEqual(disconnected.sort(), [
    "member@wiserchat.ai:usr_member",
    "team@wiserchat.ai:usr_member",
  ]);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM agent_connection_revocations",
    ).get()!.count,
    3,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM credential_recovery_audit WHERE event_type = 'account_deactivated'",
      )
      .get()!.count,
    1,
  );
  db.close();
});

test("deactivating an administrator cleans up every active mailbox they could reach", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0003_create_mailbox_access.sql",
    "0005_auth_security.sql",
    "0006_credential_recovery.sql",
    "0010_create_agent_connection_revocations.sql",
    "0012_create_credential_recovery_jobs.sql",
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
     VALUES ('usr_admin', 'admin@wiserchat.ai', 'hash', 'salt', 1, 'ADMIN', 1,
             'admin@wiserchat.ai', 100, 100),
            ('usr_member', 'member@wiserchat.ai', 'hash', 'salt', 1, 'AGENT', 1,
             'member@wiserchat.ai', 100, 100)`,
  ).run();
  // The administrator owns only their own mailbox: the other Personal Mailbox
  // and the Shared Mailbox are reachable by role alone, and the retired one is
  // reachable by nobody.
  db.prepare(
    `INSERT INTO mailboxes
     (id, address, type, owner_user_id, is_active, created_at, updated_at)
     VALUES ('admin@wiserchat.ai', 'admin@wiserchat.ai', 'PERSONAL', 'usr_admin', 1, 100, 100),
            ('member@wiserchat.ai', 'member@wiserchat.ai', 'PERSONAL', 'usr_member', 1, 100, 100),
            ('team@wiserchat.ai', 'team@wiserchat.ai', 'SHARED', NULL, 1, 100, 100),
            ('retired@wiserchat.ai', 'retired@wiserchat.ai', 'SHARED', NULL, 0, 100, 100)`,
  ).run();

  const purged: string[] = [];
  const disconnected: string[] = [];
  const env = {
    DB: d1(db),
    JWT_SECRET: "test-secret",
    MAILBOX: {
      idFromName(name: string) {
        return name;
      },
      get(id: string) {
        return {
          async removePushSubscriptionsForUser(userId: string) {
            purged.push(`${id}:${userId}`);
          },
        };
      },
    },
  } as unknown as Env;
  const lifecycle = accountLifecycle(env, async (mailboxId, userId) => {
    disconnected.push(`${mailboxId}:${userId}`);
  });
  await lifecycle.deactivate("usr_admin");

  assert.deepEqual(disconnected.sort(), [
    "admin@wiserchat.ai:usr_admin",
    "member@wiserchat.ai:usr_admin",
    "team@wiserchat.ai:usr_admin",
  ]);
  assert.deepEqual(purged.sort(), [
    "admin@wiserchat.ai:usr_admin",
    "member@wiserchat.ai:usr_admin",
    "team@wiserchat.ai:usr_admin",
  ]);
  // The durable outbox saw the same reach, without duplicating the mailbox the
  // administrator also owns.
  assert.deepEqual(
    db
      .prepare(
        `SELECT mailbox_id FROM agent_connection_revocations
         WHERE scope = 'ACTOR' AND user_id = 'usr_admin'
         ORDER BY mailbox_id`,
      )
      .all()
      .map((row) => row.mailbox_id),
    ["admin@wiserchat.ai", "member@wiserchat.ai", "team@wiserchat.ai"],
  );
  db.close();
});

test("a Shared Mailbox tombstone cannot be reactivated as a login account", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0003_create_mailbox_access.sql",
    "0005_auth_security.sql",
    "0006_credential_recovery.sql",
    "0010_create_agent_connection_revocations.sql",
    "0012_create_credential_recovery_jobs.sql",
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
      mailbox_address, mcp_token_hash, recovery_email, ownership_confirmed_at,
      created_at, updated_at)
     VALUES ('usr_hello', 'hello@wiserchat.ai', 'retired-hash', 'retired-salt',
             2, 'AGENT', 0, 'hello@wiserchat.ai', NULL, NULL, 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO mailboxes
     (id, address, type, owner_user_id, is_active, created_at, updated_at)
     VALUES ('hello@wiserchat.ai', 'hello@wiserchat.ai', 'SHARED', NULL, 1, 1, 1)`,
  ).run();

  const lifecycle = accountLifecycle({
    DB: d1(db),
  } as unknown as Env);
  await assert.rejects(
    () => lifecycle.activate("usr_hello"),
    /canonical Personal Mailbox/,
  );
  assert.equal(
    db
      .prepare("SELECT is_active FROM users WHERE id = 'usr_hello'")
      .get()!.is_active,
    0,
  );
  db.close();
});
