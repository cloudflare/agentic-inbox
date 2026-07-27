import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import type { Env } from "../types.ts";
import { handleSesEvent } from "../routes/ses-events.ts";
import { createCredentialRecoveryWorkflow } from "./credential-recovery.ts";
import { credentialRecoveryD1 } from "./credential-recovery-d1.ts";
import {
  decryptCredentialRecoveryDelivery,
  fenceCredentialRecoveryDeliveryDispatch,
  leaseCredentialRecoveryDeliveries,
  markCredentialRecoveryAccepted,
  parkCredentialRecoveryDelivery,
  recoverExpiredCredentialRecoveryDispatches,
} from "./credential-recovery-delivery-outbox.ts";

class Statement {
  #values: unknown[] = [];
  private readonly database: DatabaseSync;
  private readonly sql: string;
  constructor(database: DatabaseSync, sql: string) {
    this.database = database;
    this.sql = sql;
  }
  bind(...values: unknown[]) {
    this.#values = values;
    return this;
  }
  async run() {
    const before = totalChanges(this.database);
    const results = this.statement().all(...this.#values);
    return {
      success: true,
      results,
      meta: { changes: totalChanges(this.database) - before },
    };
  }
  async first<T>() {
    return (this.statement().get(...this.#values) as T | undefined) ?? null;
  }
  async all<T>() {
    return { success: true, results: this.statement().all(...this.#values) as T[] };
  }
  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

// D1 reports trigger-caused row changes in meta.changes, so the shim reports the
// total_changes() delta rather than the trigger-excluding sqlite3_changes count.
function totalChanges(database: DatabaseSync): number {
  const row = database.prepare("SELECT total_changes() AS total").get() as {
    total: number;
  };
  return Number(row.total);
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0005_auth_security.sql",
    "0006_credential_recovery.sql",
    "0012_create_credential_recovery_jobs.sql",
  ]) {
    database.exec(
      readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"),
    );
  }
  const d1 = {
    prepare(sql: string) {
      return new Statement(database, sql);
    },
    async batch(statements: Statement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const env = {
    DB: d1,
    JWT_SECRET: "jwt-can-rotate",
    CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1: "stable-payload-key",
    BRAND: "wiser",
  } as unknown as Env;
  database.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, session_version, role, is_active,
      mailbox_address, ownership_confirmed_at, created_at, updated_at)
     VALUES ('user-1', 'member@wiserchat.ai', 'old', 'old', 1, 'AGENT', 1,
             'member@wiserchat.ai', 100, 100, 100)`,
  ).run();
  database.prepare(
    `UPDATE credential_recovery_control
     SET enabled = 1, updated_at = 100
     WHERE control_id = 'global'`,
  ).run();
  return { database, env };
}

async function issueRecovery(env: Env, now = 1_000) {
  const workflow = createCredentialRecoveryWorkflow({
    now: () => now,
    generateToken: () => "raw-token",
    hashToken: async (value) => `hash:${value}`,
    store: credentialRecoveryD1(env),
  });
  const issued = await workflow.issue({
    purpose: "recovery",
    userId: "user-1",
    loginEmail: "member@wiserchat.ai",
    recoveryEmail: "owner@personal.example",
    origin: "https://mail.wiserchat.ai",
  });
  assert.equal(issued.issuance, "issued");
  return workflow;
}

test("provider acceptance survives token consumption after the dispatch fence", async () => {
  const { database, env } = fixture();
  const workflow = await issueRecovery(env);
  const [delivery] = await leaseCredentialRecoveryDeliveries(env, 1_000);
  assert.ok(delivery);
  const payload = await decryptCredentialRecoveryDelivery(env, delivery);
  assert.equal(
    await fenceCredentialRecoveryDeliveryDispatch(
      env,
      delivery,
      payload.expiresAt,
      1_001,
    ),
    "dispatching",
  );

  assert.equal(
    (
      await workflow.consume({
        token: "raw-token",
        passwordHash: "new-hash",
        passwordSalt: "new-salt",
        mcpTokenHash: null,
      })
    )?.outcome,
    "recovered",
  );
  const dispatching = database.prepare(
    `SELECT state, cancellation_reason, payload_ciphertext
     FROM credential_recovery_delivery_outbox`,
  ).get()!;
  assert.equal(dispatching.state, "dispatching");
  assert.equal(dispatching.cancellation_reason, "TOKEN_CONSUMED");
  assert.equal(typeof dispatching.payload_ciphertext, "string");

  assert.equal(
    await markCredentialRecoveryAccepted(env, delivery, "ses-message-1", 1_003),
    true,
  );
  const accepted = database.prepare(
    `SELECT state, provider_message_id, cancellation_reason, payload_ciphertext
     FROM credential_recovery_delivery_outbox`,
  ).get()!;
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.provider_message_id, "ses-message-1");
  assert.equal(accepted.cancellation_reason, "TOKEN_CONSUMED");
  assert.equal(accepted.payload_ciphertext, null);
  database.close();
});

test("an expired preflight lease cannot fence after another worker re-leases it", async () => {
  const { database, env } = fixture();
  await issueRecovery(env);
  const [stale] = await leaseCredentialRecoveryDeliveries(env, 1_000);
  assert.ok(stale);
  const payload = await decryptCredentialRecoveryDelivery(env, stale);
  const [fresh] = await leaseCredentialRecoveryDeliveries(env, 31_001);
  assert.ok(fresh);
  assert.notEqual(fresh.leaseToken, stale.leaseToken);

  assert.equal(
    await fenceCredentialRecoveryDeliveryDispatch(
      env,
      stale,
      payload.expiresAt,
      31_002,
    ),
    "lost",
  );
  assert.equal(
    await fenceCredentialRecoveryDeliveryDispatch(
      env,
      fresh,
      payload.expiresAt,
      31_002,
    ),
    "dispatching",
  );
  database.close();
});

test("the global disable switch wins atomically at the final provider fence", async () => {
  const { database, env } = fixture();
  await issueRecovery(env);
  const [delivery] = await leaseCredentialRecoveryDeliveries(env, 1_000);
  assert.ok(delivery);
  const payload = await decryptCredentialRecoveryDelivery(env, delivery);

  database.prepare(
    `UPDATE credential_recovery_control
     SET enabled = 0, updated_at = 1_001
     WHERE control_id = 'global'`,
  ).run();

  assert.equal(
    await fenceCredentialRecoveryDeliveryDispatch(
      env,
      delivery,
      payload.expiresAt,
      1_002,
    ),
    "lost",
  );
  assert.deepEqual(
    {
      ...database.prepare(
        `SELECT state, lease_token, dispatch_started_at
         FROM credential_recovery_delivery_outbox`,
      ).get()!,
    },
    {
      state: "leased",
      lease_token: delivery.leaseToken,
      dispatch_started_at: null,
    },
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM credential_recovery_delivery_attempts",
    ).get()!.count,
    0,
  );
  database.close();
});

test("expired dispatch evidence is recorded before a retry and stale acceptance loses", async () => {
  const { database, env } = fixture();
  await issueRecovery(env);
  const [delivery] = await leaseCredentialRecoveryDeliveries(env, 1_000);
  assert.ok(delivery);
  const payload = await decryptCredentialRecoveryDelivery(env, delivery);
  assert.equal(
    await fenceCredentialRecoveryDeliveryDispatch(
      env,
      delivery,
      payload.expiresAt,
      1_001,
    ),
    "dispatching",
  );
  assert.equal(await recoverExpiredCredentialRecoveryDispatches(env, 46_002), 1);
  const recovered = database.prepare(
    `SELECT state, ambiguous_dispatch_count, last_ambiguity_at
     FROM credential_recovery_delivery_outbox`,
  ).get()!;
  assert.equal(recovered.state, "pending");
  assert.equal(recovered.ambiguous_dispatch_count, 1);
  assert.equal(recovered.last_ambiguity_at, 46_002);
  assert.equal(
    await markCredentialRecoveryAccepted(env, delivery, "stale-message", 46_003),
    false,
  );
  database.close();
});

test("a token inside the provider safety window is terminalized before dispatch", async () => {
  const { database, env } = fixture();
  await issueRecovery(env);
  const expiresAt = 1_000 + 24 * 60 * 60 * 1_000;
  const nearExpiry = expiresAt - 59_000;
  const [delivery] = await leaseCredentialRecoveryDeliveries(env, nearExpiry);
  assert.ok(delivery);
  const payload = await decryptCredentialRecoveryDelivery(env, delivery);
  assert.equal(payload.expiresAt, expiresAt);
  assert.equal(
    await fenceCredentialRecoveryDeliveryDispatch(
      env,
      delivery,
      payload.expiresAt,
      nearExpiry + 1,
    ),
    "terminal",
  );
  const row = database.prepare(
    `SELECT state, payload_ciphertext, provider_message_id
     FROM credential_recovery_delivery_outbox`,
  ).get()!;
  assert.equal(row.state, "expired");
  assert.equal(row.payload_ciphertext, null);
  assert.equal(row.provider_message_id, null);
  database.close();
});

test("an ambiguous expired dispatch preserves evidence when cancellation wins", async () => {
  const { database, env } = fixture();
  const workflow = await issueRecovery(env);
  const [delivery] = await leaseCredentialRecoveryDeliveries(env, 1_000);
  assert.ok(delivery);
  const payload = await decryptCredentialRecoveryDelivery(env, delivery);
  assert.equal(
    await fenceCredentialRecoveryDeliveryDispatch(
      env,
      delivery,
      payload.expiresAt,
      1_001,
    ),
    "dispatching",
  );
  assert.ok(
    await workflow.consume({
      token: "raw-token",
      passwordHash: "new-hash",
      passwordSalt: "new-salt",
      mcpTokenHash: null,
    }),
  );
  assert.equal(await recoverExpiredCredentialRecoveryDispatches(env, 46_002), 1);
  const row = database.prepare(
    `SELECT state, ambiguous_dispatch_count, last_ambiguity_at,
            cancellation_reason, payload_ciphertext
     FROM credential_recovery_delivery_outbox`,
  ).get()!;
  assert.equal(row.state, "cancelled");
  assert.equal(row.ambiguous_dispatch_count, 1);
  assert.equal(row.last_ambiguity_at, 46_002);
  assert.equal(row.cancellation_reason, "TOKEN_CONSUMED");
  assert.equal(row.payload_ciphertext, null);
  database.close();
});

test("exact late SES evidence rescues an ambiguous attempt after a corrupt retry parks", async () => {
  const { database, env } = fixture();
  await issueRecovery(env);
  const [attemptA] = await leaseCredentialRecoveryDeliveries(env, 1_000);
  assert.ok(attemptA);
  const payload = await decryptCredentialRecoveryDelivery(env, attemptA);
  assert.equal(
    await fenceCredentialRecoveryDeliveryDispatch(
      env,
      attemptA,
      payload.expiresAt,
      1_001,
    ),
    "dispatching",
  );
  assert.equal(await recoverExpiredCredentialRecoveryDispatches(env, 46_002), 1);
  database.prepare(
    `UPDATE credential_recovery_delivery_outbox
     SET payload_ciphertext = ? WHERE id = ?`,
  ).run("z".repeat(32), attemptA.id);
  const [corruptRetry] = await leaseCredentialRecoveryDeliveries(env, 76_002);
  assert.ok(corruptRetry);
  await assert.rejects(() =>
    decryptCredentialRecoveryDelivery(env, corruptRetry),
  );
  assert.equal(
    await parkCredentialRecoveryDelivery(
      env,
      corruptRetry,
      "PAYLOAD_CORRUPT",
      76_003,
    ),
    true,
  );
  assert.equal(
    database.prepare(
      "SELECT state FROM credential_recovery_delivery_outbox WHERE id = ?",
    ).get(attemptA.id)!.state,
    "parked",
  );

  const app = new Hono();
  app.post("/webhooks/ses", handleSesEvent as never);
  const eventRequest = () =>
    app.request(
      "http://local/webhooks/ses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer event-secret",
        },
        body: JSON.stringify({
          id: "parked-rescue-event",
          time: "2026-07-16T10:00:00.000Z",
          detail: {
            eventType: "Delivery",
            mail: {
              messageId: "ses-parked-rescue",
              tags: {
                CredentialRecoveryId: [attemptA.id],
                CredentialRecoveryAttempt: [attemptA.leaseToken],
              },
            },
          },
        }),
      },
      { ...env, SES_EVENT_WEBHOOK_SECRET: "event-secret" },
    );
  assert.equal((await eventRequest()).status, 202);
  assert.equal((await eventRequest()).status, 202);
  assert.deepEqual(
    {
      ...database.prepare(
        `SELECT state, provider_message_id, accepted_attempt_id,
                provider_event_status, payload_ciphertext
         FROM credential_recovery_delivery_outbox WHERE id = ?`,
      ).get(attemptA.id)!,
    },
    {
      state: "accepted",
      provider_message_id: "ses-parked-rescue",
      accepted_attempt_id: attemptA.leaseToken,
      provider_event_status: "delivery",
      payload_ciphertext: null,
    },
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM credential_recovery_delivery_events",
    ).get()!.count,
    1,
  );
  database.close();
});
