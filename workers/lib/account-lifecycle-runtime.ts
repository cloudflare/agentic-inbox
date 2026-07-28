import type { Env } from "../types.ts";
import { generateMcpToken, hashPassword } from "./auth.ts";
import { createAccountLifecycle } from "./account-lifecycle.ts";
import { requireAgentConnectionReconciliation } from "./agent-connection-revocation-outbox.ts";

export function accountLifecycle(
  env: Env,
  reconcileAgent: (
    mailboxId: string,
    userId: string,
  ) => Promise<void> = (mailboxId, userId) =>
    requireAgentConnectionReconciliation(env, { mailboxId, userId }),
) {
  return createAccountLifecycle({
    generateReplacementPassword: () =>
      hashPassword(generateMcpToken(), env.JWT_SECRET),
    store: {
      async deactivate(input) {
        // An administrator is member-equivalent on every active mailbox, so
        // deactivation cleanup fans out over all of them, not only what the
        // user owns or joined. The role still reads ADMIN here: the batch
        // below revokes the session, it never rewrites the role.
        const mailboxRows = await env.DB.prepare(
          `SELECT DISTINCT m.address
					 FROM mailboxes m
					 LEFT JOIN mailbox_memberships mm ON mm.mailbox_id = m.id
					 WHERE m.owner_user_id = ? OR mm.user_id = ?
					    OR (m.is_active = 1 AND EXISTS (
					          SELECT 1 FROM users WHERE id = ? AND role = 'ADMIN'
					        ))`,
        )
          .bind(input.userId, input.userId, input.userId)
          .all<{ address: string }>();
        const results = await env.DB.batch([
          env.DB.prepare(
            `UPDATE users
						 SET is_active = 0, password_hash = ?, password_salt = ?,
						     mcp_token_hash = NULL, session_version = session_version + 1,
						     updated_at = ?
						 WHERE id = ?
						 RETURNING id`,
          ).bind(
            input.passwordHash,
            input.passwordSalt,
            input.at,
            input.userId,
          ),
          env.DB.prepare(
            "UPDATE mailboxes SET is_active = 0, updated_at = ? WHERE owner_user_id = ?",
          ).bind(input.at, input.userId),
          env.DB.prepare(
            "UPDATE credential_recovery_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL",
          ).bind(input.at, input.userId),
          env.DB.prepare(
            `UPDATE credential_recovery_delivery_outbox
             SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
                 payload_key_version = NULL, payload_iv = NULL,
                 payload_ciphertext = NULL, completed_at = ?, updated_at = ?,
                 last_error_code = 'ACCOUNT_DEACTIVATED',
                 cancellation_reason = 'ACCOUNT_DEACTIVATED',
                 cancellation_observed_at = ?
             WHERE token_id IN (
               SELECT id FROM credential_recovery_tokens WHERE user_id = ?
             ) AND state IN ('pending', 'leased')`,
          ).bind(input.at, input.at, input.at, input.userId),
          env.DB.prepare(
            `UPDATE credential_recovery_delivery_outbox
             SET cancellation_reason = COALESCE(cancellation_reason, 'ACCOUNT_DEACTIVATED'),
                 cancellation_observed_at = COALESCE(cancellation_observed_at, ?),
                 updated_at = ?
             WHERE token_id IN (
               SELECT id FROM credential_recovery_tokens WHERE user_id = ?
             ) AND state = 'dispatching'`,
          ).bind(input.at, input.at, input.userId),
          env.DB.prepare(
            `INSERT INTO credential_recovery_audit
						 (id, user_id, event_type, actor_user_id, created_at)
						 SELECT ?, ?, 'account_deactivated', NULL, ?
						 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`,
          ).bind(
            `audit_${crypto.randomUUID()}`,
            input.userId,
            input.at,
            input.userId,
          ),
        ]);
        // Row count, not meta.changes: the session_version bump fires a trigger
        // that enqueues one revocation per mailbox, inflating the change count.
        if ((results[0]?.results.length ?? 0) !== 1) {
          throw new Error("User was not found");
        }
        return { mailboxIds: mailboxRows.results.map((row) => row.address) };
      },
      async activate(userId) {
        const now = Date.now();
        const results = await env.DB.batch([
          env.DB.prepare(
            `UPDATE users
             SET is_active = 1, updated_at = ?
             WHERE id = ?
               AND EXISTS (
                 SELECT 1
                 FROM mailboxes
                 WHERE mailboxes.owner_user_id = users.id
                   AND mailboxes.type = 'PERSONAL'
                   AND mailboxes.id = users.mailbox_address
                   AND mailboxes.address = users.mailbox_address
               )`,
          ).bind(now, userId),
          env.DB.prepare(
            `UPDATE mailboxes
             SET is_active = 1, updated_at = ?
             WHERE owner_user_id = ?
               AND type = 'PERSONAL'
               AND id = address`,
          ).bind(now, userId),
        ]);
        if (
          (results[0]?.meta.changes ?? 0) !== 1 ||
          (results[1]?.meta.changes ?? 0) !== 1
        ) {
          throw new Error(
            "User cannot be reactivated without one canonical Personal Mailbox",
          );
        }
      },
    },
    async purgePush(userId, mailboxId) {
      const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
      await stub.removePushSubscriptionsForUser(userId);
    },
    async disconnectAgent(userId, mailboxId) {
      await reconcileAgent(mailboxId, userId);
    },
  });
}
