import type {
	FollowUpReminder,
	FollowUpReminderListPage,
} from "../../shared/follow-up-reminders.ts";
import type { Env } from "../types.ts";
import { mailboxAccess } from "./mailbox-access.ts";
import {
	createFollowUpReminderService,
	FollowUpReminderError,
	type FollowUpReminderStore,
	type ReminderStoreOperation,
} from "./follow-up-reminders.ts";
import {
	LIVE_MAILBOX_ACCESS_SQL,
	liveMailboxAccessSql,
} from "./live-mailbox-access-sql.ts";

interface ReminderRow {
	id: string;
	owner_user_id: string;
	mailbox_address: string;
	conversation_key: string;
	baseline_message_id: string;
	baseline_message_date: number;
	remind_at: number;
	state: FollowUpReminder["state"];
	resolution_reason: FollowUpReminder["resolutionReason"];
	version: number;
	created_at: number;
	updated_at: number;
	resolved_at: number | null;
}

interface OperationRow {
	payload_fingerprint: string;
	result_json: string;
}

const REMINDER_COLUMNS = `id, owner_user_id, mailbox_address, conversation_key,
	baseline_message_id, baseline_message_date, remind_at, state,
	resolution_reason, version, created_at, updated_at, resolved_at`;

function fromRow(row: ReminderRow): FollowUpReminder {
	return {
		id: row.id,
		ownerUserId: row.owner_user_id,
		mailboxAddress: row.mailbox_address,
		conversationKey: row.conversation_key,
		baselineMessageId: row.baseline_message_id,
		baselineMessageDate: new Date(row.baseline_message_date).toISOString(),
		remindAt: new Date(row.remind_at).toISOString(),
		state: row.state,
		resolutionReason: row.resolution_reason,
		version: row.version,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		resolvedAt: row.resolved_at,
	};
}

function parseSnapshot(value: string): FollowUpReminder {
	const parsed = JSON.parse(value) as FollowUpReminder;
	if (!parsed || typeof parsed.id !== "string" || typeof parsed.version !== "number") {
		throw new Error("Stored follow-up reminder operation result is invalid");
	}
	return parsed;
}

function isUniqueConstraint(error: unknown): boolean {
	return error instanceof Error && /unique constraint/i.test(error.message);
}

function nextReminder(
	current: FollowUpReminder,
	input: ReminderStoreOperation,
): FollowUpReminder {
	return {
		...current,
		version: current.version + 1,
		updatedAt: input.occurredAt,
		...(input.action === "snooze"
			? { remindAt: input.remindAt! }
			: {
					state: input.action === "dismiss" ? "dismissed" as const : "completed" as const,
					resolutionReason: input.action === "dismiss" ? "dismissed" as const : "manual" as const,
					resolvedAt: input.occurredAt,
				}),
	};
}

export function followUpReminderD1Store(
	env: Pick<Env, "DB">,
): FollowUpReminderStore {
	async function findOperation(ownerUserId: string, operationId: string) {
		return env.DB.prepare(
			`SELECT payload_fingerprint, result_json
			 FROM follow_up_reminder_operations
			 WHERE owner_user_id = ? AND operation_id = ?`,
		)
			.bind(ownerUserId, operationId)
			.first<OperationRow>();
	}

	async function getScoped(
		id: string,
		ownerUserId: string,
		mailboxAddress: string,
	) {
		const row = await env.DB.prepare(
			`SELECT ${REMINDER_COLUMNS}
			 FROM follow_up_reminders
			 WHERE id = ? AND owner_user_id = ? AND mailbox_address = ?`,
    )
      .bind(id, ownerUserId, mailboxAddress)
      .first<ReminderRow>();
    return row ? fromRow(row) : undefined;
  }

  async function hasLiveAccess(ownerUserId: string, mailboxAddress: string) {
    const row = await env.DB.prepare(
      `SELECT ${LIVE_MAILBOX_ACCESS_SQL} AS allowed`,
    )
      .bind(mailboxAddress, ownerUserId)
      .first<{ allowed: number }>();
    return row?.allowed === 1;
  }

  return {
    async list({ ownerUserId, mailboxAddress, limit, cursor }) {
      const result = await env.DB.prepare(
        `SELECT ${REMINDER_COLUMNS}
				 FROM follow_up_reminders
				 WHERE owner_user_id = ? AND mailbox_address = ? AND state = 'active'
				   AND (? IS NULL OR remind_at > ? OR (remind_at = ? AND id > ?))
				 ORDER BY remind_at ASC, id ASC
				 LIMIT ?`,
			)
				.bind(
					ownerUserId,
					mailboxAddress,
					cursor?.remindAt ?? null,
					cursor?.remindAt ?? null,
					cursor?.remindAt ?? null,
					cursor?.id ?? null,
					limit + 1,
				)
				.all<ReminderRow>();
			const hasMore = result.results.length > limit;
			const rows = hasMore ? result.results.slice(0, limit) : result.results;
			const last = rows.at(-1);
			return {
				reminders: rows.map(fromRow),
				nextCursor: hasMore && last
					? { remindAt: last.remind_at, id: last.id }
					: null,
			};
		},

		async findCreateReplay({ ownerUserId, idempotencyKey, fingerprint }) {
			const prior = await env.DB.prepare(
				`SELECT create_fingerprint, create_result_json
				 FROM follow_up_reminders
				 WHERE owner_user_id = ? AND create_idempotency_key = ?`,
			)
				.bind(ownerUserId, idempotencyKey)
				.first<{ create_fingerprint: string; create_result_json: string }>();
			if (!prior) return null;
			return prior.create_fingerprint === fingerprint
				? { status: "replayed", reminder: parseSnapshot(prior.create_result_json) }
				: { status: "idempotency_conflict" };
		},

		async createOrReplay({ row, idempotencyKey, fingerprint }) {
			const prior = await env.DB.prepare(
				`SELECT create_fingerprint, create_result_json
				 FROM follow_up_reminders
				 WHERE owner_user_id = ? AND create_idempotency_key = ?`,
			)
				.bind(row.ownerUserId, idempotencyKey)
				.first<{ create_fingerprint: string; create_result_json: string }>();
			if (prior) {
				return prior.create_fingerprint === fingerprint
					? { status: "replayed", reminder: parseSnapshot(prior.create_result_json) }
					: { status: "idempotency_conflict" };
			}

			try {
				const inserted = await env.DB.prepare(
					`INSERT INTO follow_up_reminders
					 (id, owner_user_id, mailbox_address, conversation_key,
					  baseline_message_id, baseline_message_date, remind_at, state,
					  resolution_reason, create_idempotency_key, create_fingerprint,
					  create_result_json, version, created_at, updated_at, resolved_at)
					 SELECT ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?, ?, NULL
					 WHERE ${LIVE_MAILBOX_ACCESS_SQL}`,
				)
					.bind(
						row.id,
						row.ownerUserId,
						row.mailboxAddress,
						row.conversationKey,
						row.baselineMessageId,
						Date.parse(row.baselineMessageDate),
						Date.parse(row.remindAt),
						idempotencyKey,
						fingerprint,
						JSON.stringify(row),
						row.version,
						row.createdAt,
						row.updatedAt,
						row.mailboxAddress,
						row.ownerUserId,
					)
					.run();
				if (!inserted.meta.changes) {
					return { status: "forbidden" };
				}
				return { status: "created", reminder: row };
			} catch (error) {
				if (!isUniqueConstraint(error)) throw error;
				const replay = await env.DB.prepare(
					`SELECT create_fingerprint, create_result_json
					 FROM follow_up_reminders
					 WHERE owner_user_id = ? AND create_idempotency_key = ?`,
				)
					.bind(row.ownerUserId, idempotencyKey)
					.first<{ create_fingerprint: string; create_result_json: string }>();
				if (replay) {
					return replay.create_fingerprint === fingerprint
						? { status: "replayed", reminder: parseSnapshot(replay.create_result_json) }
						: { status: "idempotency_conflict" };
				}
				const active = await env.DB.prepare(
					`SELECT ${REMINDER_COLUMNS}
					 FROM follow_up_reminders
					 WHERE owner_user_id = ? AND mailbox_address = ?
					   AND conversation_key = ? AND state = 'active'`,
				)
					.bind(row.ownerUserId, row.mailboxAddress, row.conversationKey)
					.first<ReminderRow>();
				if (active) return { status: "active_conflict", reminder: fromRow(active) };
				throw error;
			}
		},

		async applyOperation(input) {
			const prior = await findOperation(input.ownerUserId, input.operationId);
			if (prior) {
				return prior.payload_fingerprint === input.fingerprint
					? { status: "replayed", reminder: parseSnapshot(prior.result_json) }
					: { status: "idempotency_conflict" };
			}

			const current = await getScoped(
				input.reminderId,
				input.ownerUserId,
				input.mailboxAddress,
			);
			if (!current) return { status: "not_found" };
			if (current.state !== "active" || current.version !== input.expectedVersion) {
				return { status: "state_conflict", reminder: current };
			}
			const next = nextReminder(current, input);
			const state = input.action === "snooze" ? "active" : input.action === "dismiss" ? "dismissed" : "completed";
			const reason = input.action === "snooze" ? null : input.action === "dismiss" ? "dismissed" : "manual";
			const resolvedAt = input.action === "snooze" ? null : input.occurredAt;
			const remindAt = input.action === "snooze"
				? Date.parse(input.remindAt!)
				: Date.parse(current.remindAt);

			try {
				const results = await env.DB.batch([
					env.DB.prepare(
						 `UPDATE follow_up_reminders
						 SET remind_at = ?, state = ?, resolution_reason = ?,
						     version = version + 1, updated_at = ?, resolved_at = ?
						 WHERE id = ? AND owner_user_id = ? AND mailbox_address = ?
						   AND state = 'active' AND version = ?
						   AND ${LIVE_MAILBOX_ACCESS_SQL}`,
					)
						.bind(
							remindAt,
							state,
							reason,
							input.occurredAt,
							resolvedAt,
							input.reminderId,
							input.ownerUserId,
							input.mailboxAddress,
							input.expectedVersion,
							input.mailboxAddress,
							input.ownerUserId,
						),
					env.DB.prepare(
						`INSERT INTO follow_up_reminder_operations
						 (id, owner_user_id, mailbox_address, reminder_id, operation_id,
						  action, payload_fingerprint, result_json, created_at)
						 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
						 WHERE changes() = 1`,
					)
						.bind(
							`reminder_operation_${crypto.randomUUID()}`,
							input.ownerUserId,
							input.mailboxAddress,
							input.reminderId,
							input.operationId,
							input.action,
							input.fingerprint,
							JSON.stringify(next),
							input.occurredAt,
						),
				]);
				if (results[0]?.meta.changes && results[1]?.meta.changes) {
					return { status: "applied", reminder: next };
				}
			} catch (error) {
				if (!isUniqueConstraint(error)) throw error;
			}
			if (!(await hasLiveAccess(input.ownerUserId, input.mailboxAddress))) {
				return { status: "forbidden" };
			}

			const replay = await findOperation(input.ownerUserId, input.operationId);
			if (replay) {
				return replay.payload_fingerprint === input.fingerprint
					? { status: "replayed", reminder: parseSnapshot(replay.result_json) }
					: { status: "idempotency_conflict" };
			}
			const latest = await getScoped(
				input.reminderId,
				input.ownerUserId,
				input.mailboxAddress,
			);
			return latest
				? { status: "state_conflict", reminder: latest }
				: { status: "not_found" };
		},

		async completeForInboundReply(input) {
			const result = await env.DB.prepare(
				`UPDATE follow_up_reminders AS reminder
				 SET state = 'completed', resolution_reason = 'inbound_reply',
				     resolved_at = ?, updated_at = ?, version = version + 1
				 WHERE mailbox_address = ? AND conversation_key = ?
				   AND state = 'active' AND baseline_message_id <> ?
				   AND baseline_message_date < ?
				   AND ${liveMailboxAccessSql(
					"reminder.mailbox_address",
					"reminder.owner_user_id",
				)}`,
			)
				.bind(
					input.occurredAt,
					input.occurredAt,
					input.mailboxAddress,
					input.conversationKey,
					input.inboundMessageId,
					Date.parse(input.inboundMessageDate),
				)
				.run();
			return Number(result.meta.changes ?? 0);
		},
	};
}

export function followUpReminderService(env: Env) {
	const access = mailboxAccess(env);
	const service = createFollowUpReminderService({
		store: followUpReminderD1Store(env),
		canAccessMailbox: (userId, mailboxAddress) =>
			access.canAccessMailbox(userId, mailboxAddress),
		resolveReminderAnchor: async (mailboxAddress, emailId) => {
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxAddress));
			return stub.getFollowUpReminderAnchor(emailId);
		},
	});
	return {
		...service,
		async create(userId: string, mailboxAddress: string, input: unknown) {
			const reminder = await service.create(userId, mailboxAddress, input);
			if (!(await access.canAccessMailbox(userId, mailboxAddress))) {
				throw new FollowUpReminderError("FORBIDDEN", "Live mailbox access is required");
			}
			return reminder;
		},
		async apply(userId: string, mailboxAddress: string, reminderId: string, input: unknown) {
			const reminder = await service.apply(userId, mailboxAddress, reminderId, input);
			if (!(await access.canAccessMailbox(userId, mailboxAddress))) {
				throw new FollowUpReminderError("FORBIDDEN", "Live mailbox access is required");
			}
			return reminder;
		},
		async list(
			userId: string,
			mailboxAddress: string,
			limit = 100,
			cursor?: string,
		): Promise<FollowUpReminderListPage> {
			// The domain service performs the live access check before any mail
			// content is projected by the mailbox Durable Object.
			const page = await service.list(
				userId,
				mailboxAddress,
				limit,
				cursor,
			);
			if (page.reminders.length === 0) {
				if (!(await access.canAccessMailbox(userId, mailboxAddress))) {
					throw new FollowUpReminderError("FORBIDDEN", "Live mailbox access is required");
				}
				return { reminders: [], nextCursor: page.nextCursor };
			}
			const mailbox = mailboxAddress.toLowerCase();
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
			const projected = await stub.getFollowUpReminderPreviews(
				page.reminders.map((reminder) => reminder.baselineMessageId),
				mailbox,
			);
			const previews = new Map(
				projected.map((preview) => [preview.baselineMessageId, preview]),
			);
			const response = {
				reminders: page.reminders.map((reminder) => {
					const projectedPreview = previews.get(reminder.baselineMessageId);
					return {
						...reminder,
						preview: projectedPreview
							? {
									subject: projectedPreview.subject,
									counterparty: projectedPreview.counterparty,
								}
							: null,
					};
				}),
				nextCursor: page.nextCursor,
			};
			if (!(await access.canAccessMailbox(userId, mailboxAddress))) {
				throw new FollowUpReminderError("FORBIDDEN", "Live mailbox access is required");
			}
			return response;
		},
	};
}
