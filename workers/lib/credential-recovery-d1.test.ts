import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import { createCredentialRecoveryWorkflow } from "./credential-recovery.ts";
import { credentialRecoveryD1 } from "./credential-recovery-d1.ts";
import { leaseCredentialRecoveryDeliveries } from "./credential-recovery-delivery-outbox.ts";

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

test("D1 atomically confirms first ownership and distinguishes later recovery", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0003_create_mailbox_access.sql",
    "0005_auth_security.sql",
    "0006_credential_recovery.sql",
    "0010_create_agent_connection_revocations.sql",
    "0012_create_credential_recovery_jobs.sql",
  ]) {
    db.exec(
      readFileSync(
        new URL(`../../migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  }
  for (const [id, email, claimed] of [
    ["usr_admin", "admin@wiserchat.ai", 100],
    ["usr_member", "member@wiserchat.ai", null],
  ] as const) {
    db.prepare(
      `INSERT INTO users
			 (id, email, password_hash, password_salt, session_version, role, is_active,
			  mailbox_address, recovery_email, ownership_confirmed_at, created_at, updated_at)
			 VALUES (?, ?, 'old-hash', 'old-salt', 1, ?, 1, ?, NULL, ?, 100, 100)`,
    ).run(id, email, id === "usr_admin" ? "ADMIN" : "AGENT", email, claimed);
    db.prepare(
      `INSERT INTO mailboxes
         (id, address, type, owner_user_id, is_active, created_at, updated_at)
       VALUES (?, ?, 'PERSONAL', ?, 1, 100, 100)`,
    ).run(email, email, id);
  }
  const env = {
    DB: d1(db),
    JWT_SECRET: "test-secret",
    CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1: "test-secret",
    BRAND: "wiser",
  } as unknown as Env;
  let now = 1_000;
  let token = "setup-token";
  const workflow = createCredentialRecoveryWorkflow({
    now: () => now,
    generateToken: () => token,
    hashToken: async (value) => `hash:${value}`,
    store: credentialRecoveryD1(env),
  });

  await workflow.issue({
    purpose: "setup",
    userId: "usr_member",
    loginEmail: "member@wiserchat.ai",
    recoveryEmail: "owner@personal.example",
    issuedBy: "usr_admin",
    origin: "https://mail.wiserchat.ai",
  });
  const setupDelivery = db
    .prepare(
      "SELECT state, payload_ciphertext FROM credential_recovery_delivery_outbox",
    )
    .get()!;
  assert.equal(setupDelivery.state, "pending");
  assert.doesNotMatch(
    String(setupDelivery.payload_ciphertext),
    /setup-token|member@wiserchat|owner@personal/,
  );
  now = 1_100;
  assert.equal(
    (
      await workflow.consume({
        token,
        passwordHash: "claimed-hash",
        passwordSalt: "claimed-salt",
        mcpTokenHash: null,
      })
    )?.outcome,
    "claimed",
  );
  assert.equal(
    db
      .prepare(
        "SELECT ownership_confirmed_at FROM users WHERE id = 'usr_member'",
      )
      .get()!.ownership_confirmed_at,
    1_100,
  );
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM agent_connection_revocations WHERE user_id = 'usr_member'",
    ).get()!.count,
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT state FROM credential_recovery_delivery_outbox WHERE token_id = (SELECT id FROM credential_recovery_tokens WHERE token_hash = 'hash:setup-token')",
      )
      .get()!.state,
    "cancelled",
  );
  assert.equal(
    await workflow.consume({
      token,
      passwordHash: "must-not-apply",
      passwordSalt: "must-not-apply",
      mcpTokenHash: null,
    }),
    null,
  );
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM agent_connection_revocations WHERE user_id = 'usr_member'",
    ).get()!.count,
    1,
  );

  now = 2_000;
  token = "superseded-recovery-token";
  await workflow.issue({
    purpose: "recovery",
    userId: "usr_member",
    loginEmail: "member@wiserchat.ai",
    recoveryEmail: "owner@personal.example",
    origin: "https://mail.wiserchat.ai",
  });
  now = 2_050;
  const concurrentIssue = (rawToken: string) =>
    createCredentialRecoveryWorkflow({
      now: () => now,
      generateToken: () => rawToken,
      hashToken: async (value) => `hash:${value}`,
      store: credentialRecoveryD1(env),
    }).issue({
      purpose: "recovery",
      userId: "usr_member",
      loginEmail: "member@wiserchat.ai",
      recoveryEmail: "owner@personal.example",
      origin: "https://mail.wiserchat.ai",
    });
  const concurrent = await Promise.allSettled([
    concurrentIssue("recovery-token-a"),
    concurrentIssue("recovery-token-b"),
  ]);
  const issuances = concurrent.flatMap((result) =>
    result.status === "fulfilled" ? [result.value.issuance] : [],
  );
  assert.deepEqual(issuances.sort(), ["issued", "rate_limited"]);
  await assert.rejects(
    () =>
      createCredentialRecoveryWorkflow({
        now: () => now,
        generateToken: () => "host-header-token",
        hashToken: async (value) => `hash:${value}`,
        store: credentialRecoveryD1(env),
      }).issue({
        purpose: "recovery",
        userId: "usr_member",
        loginEmail: "member@wiserchat.ai",
        recoveryEmail: "owner@personal.example",
        origin: "https://attacker.example",
      }),
    /delivery target is invalid/,
  );
  const activeToken = db
    .prepare(
      "SELECT id, token_hash FROM credential_recovery_tokens WHERE consumed_at IS NULL",
    )
    .get()!;
  token = String(activeToken.token_hash).slice("hash:".length);
  assert.equal(
    db
      .prepare(
        "SELECT state FROM credential_recovery_delivery_outbox WHERE token_id = (SELECT id FROM credential_recovery_tokens WHERE token_hash = 'hash:superseded-recovery-token')",
      )
      .get()!.state,
    "cancelled",
  );
  const leased = await leaseCredentialRecoveryDeliveries(env, now);
  assert.equal(leased.length, 1);
  assert.equal(leased[0]?.tokenId, activeToken.id);
  now = 2_100;
  assert.equal(
    (
      await workflow.consume({
        token,
        passwordHash: "recovered-hash",
        passwordSalt: "recovered-salt",
        mcpTokenHash: "new-mcp",
      })
    )?.outcome,
    "recovered",
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT event_type FROM credential_recovery_audit WHERE user_id = 'usr_member' ORDER BY created_at",
      )
      .all()
      .map((row) => row.event_type),
    [
      "setup_issued",
      "ownership_confirmed",
      "recovery_issued",
      "recovery_issued",
      "credentials_recovered",
    ],
  );
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM agent_connection_revocations WHERE user_id = 'usr_member'",
    ).get()!.count,
    2,
  );
  assert.equal(
    db
      .prepare(
        "SELECT state FROM credential_recovery_delivery_outbox WHERE token_id = ?",
      )
      .get(activeToken.id)!.state,
    "cancelled",
  );
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE credential_recovery_audit SET event_type = 'setup_issued'",
        )
        .run(),
    /immutable/,
  );

  db.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, session_version, role, is_active,
      mailbox_address, ownership_confirmed_at, created_at, updated_at)
     VALUES ('usr_inactive_setup', 'inactive-setup@wiserchat.ai', 'old', 'old', 1,
             'AGENT', 0, 'inactive-setup@wiserchat.ai', NULL, 1, 1),
            ('usr_inactive_recovery', 'inactive-recovery@wiserchat.ai', 'old', 'old', 1,
             'AGENT', 1, 'inactive-recovery@wiserchat.ai', 1, 1, 1)`,
  ).run();
  const inactiveSetup = await createCredentialRecoveryWorkflow({
    now: () => 1_000_000,
    generateToken: () => "inactive-setup-token",
    hashToken: async (value) => `hash:${value}`,
    store: credentialRecoveryD1(env),
  }).issue({
    purpose: "setup",
    userId: "usr_inactive_setup",
    loginEmail: "inactive-setup@wiserchat.ai",
    recoveryEmail: "owner@personal.example",
    origin: "https://mail.wiserchat.ai",
  });
  assert.equal(inactiveSetup.issuance, "suppressed");
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM credential_recovery_tokens WHERE user_id = 'usr_inactive_setup'",
    ).get()!.count,
    0,
  );

  const inactiveRecoveryWorkflow = createCredentialRecoveryWorkflow({
    now: () => 1_000_000,
    generateToken: () => "inactive-recovery-token",
    hashToken: async (value) => `hash:${value}`,
    store: credentialRecoveryD1(env),
  });
  assert.equal(
    (
      await inactiveRecoveryWorkflow.issue({
        purpose: "recovery",
        userId: "usr_inactive_recovery",
        loginEmail: "inactive-recovery@wiserchat.ai",
        recoveryEmail: "owner@personal.example",
        origin: "https://mail.wiserchat.ai",
      })
    ).issuance,
    "issued",
  );
  db.prepare(
    "UPDATE users SET is_active = 0 WHERE id = 'usr_inactive_recovery'",
  ).run();
  assert.equal(
    await inactiveRecoveryWorkflow.consume({
      token: "inactive-recovery-token",
      passwordHash: "must-not-apply",
      passwordSalt: "must-not-apply",
      mcpTokenHash: null,
    }),
    null,
  );
  const inactiveRow = db.prepare(
    `SELECT u.password_hash, t.consumed_at
     FROM users u JOIN credential_recovery_tokens t ON t.user_id = u.id
     WHERE u.id = 'usr_inactive_recovery'`,
  ).get()!;
  assert.equal(inactiveRow.password_hash, "old");
  assert.equal(inactiveRow.consumed_at, null);
  db.close();
});
