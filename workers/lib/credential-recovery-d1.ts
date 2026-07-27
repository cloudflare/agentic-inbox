import type { Env } from "../types.ts";
import type {
  CredentialRecoveryIssue,
  CredentialRecoveryStore,
} from "./credential-recovery.ts";
import { encryptCredentialRecoveryPayload } from "./credential-recovery-crypto.ts";
import { resolveBrand } from "../routes/brand.ts";
import { CREDENTIAL_RECOVERY_JOB_LIMITS } from "./credential-recovery-request-jobs.ts";

const ISSUE_WINDOW_MS = 15 * 60 * 1_000;

export function credentialRecoveryD1(env: Env): CredentialRecoveryStore {
  return {
    async issue(record: CredentialRecoveryIssue, delivery, requestLease) {
      const recoveryUrl = new URL(delivery.recoveryUrl);
      if (
        recoveryUrl.origin !== resolveBrand(env.BRAND).mailOrigin ||
        recoveryUrl.pathname !== "/account/recover" ||
        !recoveryUrl.searchParams.get("token") ||
        recoveryUrl.username ||
        recoveryUrl.password ||
        recoveryUrl.hash ||
        delivery.expiresAt !== record.expiresAt
      ) {
        throw new Error("Credential recovery delivery target is invalid");
      }

      const deliveryId = `recovery_delivery_${crypto.randomUUID()}`;
      const encrypted = await encryptCredentialRecoveryPayload(
        env.CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1,
        delivery,
        { kind: "delivery", id: deliveryId },
      );
      const leaseSql = requestLease
        ? `EXISTS (
             SELECT 1 FROM credential_recovery_request_jobs
             WHERE id = ? AND state = 'leased' AND lease_token = ?
               AND created_at > ?
           )`
        : "1 = 1";
      const eligibilitySql = `EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = ? AND u.is_active = 1
          AND ((? = 'setup' AND u.ownership_confirmed_at IS NULL)
            OR (? = 'recovery' AND u.ownership_confirmed_at IS NOT NULL))
      )`;
      const rateSql = `(
        (SELECT COUNT(*) FROM credential_recovery_tokens
         WHERE user_id = ? AND created_at > ?) < 3
        OR EXISTS (SELECT 1 FROM credential_recovery_tokens WHERE id = ?)
      )`;
      const conditionSql = `${leaseSql} AND ${eligibilitySql} AND ${rateSql}`;
      const conditionValues = [
        ...(requestLease
          ? [
              requestLease.jobId,
              requestLease.leaseToken,
              record.createdAt - CREDENTIAL_RECOVERY_JOB_LIMITS.maxAgeMs,
            ]
          : []),
        record.userId,
        record.purpose,
        record.purpose,
        record.userId,
        record.createdAt - ISSUE_WINDOW_MS,
        record.id,
      ];
      const statements = [
        env.DB.prepare(
          `UPDATE credential_recovery_tokens
           SET consumed_at = ?
           WHERE user_id = ? AND consumed_at IS NULL AND ${conditionSql}`,
        ).bind(record.createdAt, record.userId, ...conditionValues),
        env.DB.prepare(
          `UPDATE credential_recovery_delivery_outbox
           SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
               payload_key_version = NULL, payload_iv = NULL,
               payload_ciphertext = NULL, completed_at = ?, updated_at = ?,
               last_error_code = 'SUPERSEDED', cancellation_reason = 'SUPERSEDED',
               cancellation_observed_at = ?
           WHERE token_id IN (
             SELECT id FROM credential_recovery_tokens WHERE user_id = ?
           ) AND state IN ('pending', 'leased') AND ${conditionSql}`,
        ).bind(
          record.createdAt,
          record.createdAt,
          record.createdAt,
          record.userId,
          ...conditionValues,
        ),
        env.DB.prepare(
          `UPDATE credential_recovery_delivery_outbox
           SET cancellation_reason = COALESCE(cancellation_reason, 'SUPERSEDED'),
               cancellation_observed_at = COALESCE(cancellation_observed_at, ?),
               updated_at = ?
           WHERE token_id IN (
             SELECT id FROM credential_recovery_tokens WHERE user_id = ?
           ) AND state = 'dispatching' AND ${conditionSql}`,
        ).bind(record.createdAt, record.createdAt, record.userId, ...conditionValues),
        env.DB.prepare(
          `INSERT INTO credential_recovery_tokens
           (id, user_id, token_hash, expires_at, issued_by, purpose, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${conditionSql}`,
        ).bind(
          record.id,
          record.userId,
          record.tokenHash,
          record.expiresAt,
          record.issuedBy ?? null,
          record.purpose,
          record.createdAt,
          ...conditionValues,
        ),
        env.DB.prepare(
          `INSERT INTO credential_recovery_audit
           (id, user_id, event_type, actor_user_id, created_at)
           SELECT ?, ?, ?, ?, ? WHERE ${conditionSql}`,
        ).bind(
          `audit_${crypto.randomUUID()}`,
          record.userId,
          record.purpose === "setup" ? "setup_issued" : "recovery_issued",
          record.issuedBy ?? null,
          record.createdAt,
          ...conditionValues,
        ),
        env.DB.prepare(
          `INSERT INTO credential_recovery_delivery_outbox
           (id, token_id, payload_key_version, payload_iv, payload_ciphertext,
            state, attempt_count, next_attempt_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ? WHERE ${conditionSql}`,
        ).bind(
          deliveryId,
          record.id,
          encrypted.keyVersion,
          encrypted.iv,
          encrypted.ciphertext,
          record.createdAt,
          record.createdAt,
          record.createdAt,
          ...conditionValues,
        ),
      ];
      const requestCompletionIndex = statements.length;
      if (requestLease) {
        statements.push(
          env.DB.prepare(
            `UPDATE credential_recovery_request_jobs
             SET state = 'completed', lease_token = NULL, lease_expires_at = NULL,
                 payload_key_version = NULL, payload_iv = NULL,
                 payload_ciphertext = NULL, completed_at = ?, updated_at = ?,
                 last_error_code = NULL
             WHERE id = ? AND state = 'leased' AND lease_token = ?
               AND ${conditionSql}`,
          ).bind(
            record.createdAt,
            record.createdAt,
            requestLease.jobId,
            requestLease.leaseToken,
            ...conditionValues,
          ),
          env.DB.prepare(
            `UPDATE credential_recovery_request_jobs
             SET state = 'suppressed', lease_token = NULL, lease_expires_at = NULL,
                 payload_key_version = NULL, payload_iv = NULL,
                 payload_ciphertext = NULL, completed_at = ?, updated_at = ?,
                 last_error_code = NULL
             WHERE id = ? AND state = 'leased' AND lease_token = ?
               AND NOT (${eligibilitySql})`,
          ).bind(
            record.createdAt,
            record.createdAt,
            requestLease.jobId,
            requestLease.leaseToken,
            record.userId,
            record.purpose,
            record.purpose,
          ),
          env.DB.prepare(
            `UPDATE credential_recovery_request_jobs
             SET state = 'expired', lease_token = NULL, lease_expires_at = NULL,
                 payload_key_version = NULL, payload_iv = NULL,
                 payload_ciphertext = NULL, completed_at = ?, updated_at = ?,
                 last_error_code = 'REQUEST_LIFETIME_EXPIRED'
             WHERE id = ? AND state = 'leased' AND lease_token = ?
               AND created_at <= ?`,
          ).bind(
            record.createdAt,
            record.createdAt,
            requestLease.jobId,
            requestLease.leaseToken,
            record.createdAt - CREDENTIAL_RECOVERY_JOB_LIMITS.maxAgeMs,
          ),
          env.DB.prepare(
            `UPDATE credential_recovery_request_jobs
             SET state = 'pending', lease_token = NULL, lease_expires_at = NULL,
                 next_attempt_at = COALESCE((
                   SELECT MIN(created_at) + ? FROM credential_recovery_tokens
                   WHERE user_id = ? AND created_at > ?
                 ), ?), updated_at = ?, last_error_code = 'ISSUE_RATE_LIMITED'
             WHERE id = ? AND state = 'leased' AND lease_token = ?
               AND ${eligibilitySql}
               AND (SELECT COUNT(*) FROM credential_recovery_tokens
                    WHERE user_id = ? AND created_at > ?) >= 3
               AND NOT EXISTS (SELECT 1 FROM credential_recovery_tokens WHERE id = ?)`,
          ).bind(
            ISSUE_WINDOW_MS,
            record.userId,
            record.createdAt - ISSUE_WINDOW_MS,
            record.createdAt + ISSUE_WINDOW_MS,
            record.createdAt,
            requestLease.jobId,
            requestLease.leaseToken,
            record.userId,
            record.purpose,
            record.purpose,
            record.userId,
            record.createdAt - ISSUE_WINDOW_MS,
            record.id,
          ),
        );
      }

      const results = await env.DB.batch(statements);
      const issued = [3, 4, 5].every(
        (index) => (results[index]?.meta.changes ?? 0) === 1,
      );
      if (issued) {
        if (
          requestLease &&
          (results[requestCompletionIndex]?.meta.changes ?? 0) !== 1
        ) {
          throw new Error("Credential recovery issuance did not settle its request");
        }
        return "issued";
      }
      if (!requestLease) {
        const user = await env.DB.prepare(
          `SELECT is_active, ownership_confirmed_at FROM users WHERE id = ?`,
        )
          .bind(record.userId)
          .first<{ is_active: number; ownership_confirmed_at: number | null }>();
        if (
          !user ||
          user.is_active !== 1 ||
          (record.purpose === "setup") !== (user.ownership_confirmed_at === null)
        ) {
          return "suppressed";
        }
        return "rate_limited";
      }
      if ((results[requestCompletionIndex + 1]?.meta.changes ?? 0) === 1) {
        return "suppressed";
      }
      if ((results[requestCompletionIndex + 2]?.meta.changes ?? 0) === 1) {
        return "expired";
      }
      if ((results[requestCompletionIndex + 3]?.meta.changes ?? 0) === 1) {
        return "rate_limited";
      }
      return "lost";
    },

    async consume(input) {
      const record = await env.DB.prepare(
        `SELECT t.id, t.user_id, t.purpose, u.email, u.ownership_confirmed_at
         FROM credential_recovery_tokens t
         JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = ? AND t.consumed_at IS NULL AND t.expires_at > ?`,
      )
        .bind(input.tokenHash, input.now)
        .first<{
          id: string;
          user_id: string;
          email: string;
          purpose: "setup" | "recovery";
          ownership_confirmed_at: number | null;
        }>();
      if (!record) return null;

      const nonce = crypto.randomUUID();
      const outcome = record.purpose === "setup" ? "claimed" : "recovered";
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE credential_recovery_tokens AS t
           SET consumed_at = ?, consumption_nonce = ?
           WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
             AND EXISTS (
               SELECT 1 FROM users u WHERE u.id = t.user_id AND u.is_active = 1
                 AND ((t.purpose = 'setup' AND u.ownership_confirmed_at IS NULL)
                   OR (t.purpose = 'recovery' AND u.ownership_confirmed_at IS NOT NULL))
             )`,
        ).bind(input.now, nonce, record.id, input.now),
        env.DB.prepare(
          `UPDATE users
           SET password_hash = ?, password_salt = ?, mcp_token_hash = ?,
               session_version = session_version + 1,
               ownership_confirmed_at = COALESCE(ownership_confirmed_at, ?),
               updated_at = ?
           WHERE id = ? AND is_active = 1 AND EXISTS (
             SELECT 1 FROM credential_recovery_tokens
             WHERE id = ? AND consumption_nonce = ?
           )
           RETURNING id`,
        ).bind(
          input.passwordHash,
          input.passwordSalt,
          input.mcpTokenHash,
          input.now,
          input.now,
          record.user_id,
          record.id,
          nonce,
        ),
        env.DB.prepare(
          `INSERT INTO credential_recovery_audit
           (id, user_id, event_type, actor_user_id, created_at)
           SELECT ?, ?, ?, NULL, ?
           WHERE EXISTS (
             SELECT 1 FROM credential_recovery_tokens
             WHERE id = ? AND consumption_nonce = ?
           )`,
        ).bind(
          `audit_${crypto.randomUUID()}`,
          record.user_id,
          outcome === "claimed" ? "ownership_confirmed" : "credentials_recovered",
          input.now,
          record.id,
          nonce,
        ),
        env.DB.prepare(
          `UPDATE credential_recovery_delivery_outbox
           SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
               payload_key_version = NULL, payload_iv = NULL,
               payload_ciphertext = NULL, completed_at = ?, updated_at = ?,
               last_error_code = 'TOKEN_CONSUMED',
               cancellation_reason = 'TOKEN_CONSUMED', cancellation_observed_at = ?
           WHERE token_id = ? AND state IN ('pending', 'leased')
             AND EXISTS (
               SELECT 1 FROM credential_recovery_tokens
               WHERE id = ? AND consumption_nonce = ?
             )`,
        ).bind(input.now, input.now, input.now, record.id, record.id, nonce),
        env.DB.prepare(
          `UPDATE credential_recovery_delivery_outbox
           SET cancellation_reason = COALESCE(cancellation_reason, 'TOKEN_CONSUMED'),
               cancellation_observed_at = COALESCE(cancellation_observed_at, ?),
               updated_at = ?
           WHERE token_id = ? AND state = 'dispatching'
             AND EXISTS (
               SELECT 1 FROM credential_recovery_tokens
               WHERE id = ? AND consumption_nonce = ?
             )`,
        ).bind(input.now, input.now, record.id, record.id, nonce),
      ]);
      if (
        (results[0]?.meta.changes ?? 0) !== 1 ||
        // Row count, not meta.changes: the session_version bump fires a trigger
        // that enqueues one revocation per mailbox, inflating the change count.
        (results[1]?.results.length ?? 0) !== 1 ||
        (results[2]?.meta.changes ?? 0) !== 1
      ) {
        return null;
      }
      return { userId: record.user_id, loginEmail: record.email, outcome };
    },
  };
}
