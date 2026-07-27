// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	AiCostController,
	resolveAiCostControlConfig,
	type AiCostControlConfig,
	type AiCostControlStore,
	type AiCostEnvironment,
	type AiMonthLedger,
	type AiUsageEvent,
	type AiUsageReservation,
} from "./ai-cost-control.ts";
import type { Env } from "../types.ts";

type MonthRow = {
	environment: string;
	month_key: string;
	spent_micros: number;
	reserved_micros: number;
	approved_budget_micros: number;
	alert_emitted_at: number | null;
};

/** D1-backed store. Migration 0004 owns the aggregate-accounting triggers. */
export class D1AiCostControlStore implements AiCostControlStore {
	readonly #db: D1Database;
	readonly #defaultApprovedBudgetMicros: number;

	constructor(db: D1Database, defaultApprovedBudgetMicros: number) {
		this.#db = db;
		this.#defaultApprovedBudgetMicros = defaultApprovedBudgetMicros;
	}

	async getMonth(environment: string, monthKey: string): Promise<AiMonthLedger | null> {
		const row = await this.#db
			.prepare(
				`SELECT environment, month_key, spent_micros, reserved_micros,
				        approved_budget_micros, alert_emitted_at
				 FROM ai_usage_months
				 WHERE environment = ? AND month_key = ?`,
			)
			.bind(environment, monthKey)
			.first<MonthRow>();
		return row ? mapMonth(row) : null;
	}

	async reapExpiredReservations(now: number): Promise<void> {
		await this.#db
			.prepare(
				`UPDATE ai_usage_events
				 SET state = 'failed', error_code = 'reservation_expired',
				     actual_cost_micros = CASE
				       WHEN provider_started_at IS NULL THEN 0
				       ELSE estimated_cost_micros
				     END,
				     completed_at = ?
				 WHERE state = 'reserved' AND reservation_expires_at <= ?`,
			)
			.bind(now, now)
			.run();
	}

	async recordEvent(event: AiUsageEvent): Promise<void> {
		await this.#db.batch([
			this.#ensureMonth(
				event.environment,
				event.monthKey,
				event.createdAt,
				this.#defaultApprovedBudgetMicros,
			),
			this.#db
				.prepare(
					`INSERT INTO ai_usage_events (
					   id, environment, month_key, feature, actor_user_id, mailbox_id,
					   requested_tier, selected_tier, model, cache_key, escalation_reason,
					   state, estimated_cost_micros, actual_cost_micros, prompt_tokens,
					   completion_tokens, error_code, created_at, completed_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					event.id,
					event.environment,
					event.monthKey,
					event.feature,
					event.actorUserId ?? null,
					event.mailboxId ?? null,
					event.requestedTier,
					event.selectedTier,
					event.model,
					event.cacheKey ?? null,
					event.escalationReason ?? null,
					event.state,
					event.estimatedCostMicros,
					event.actualCostMicros,
					event.promptTokens,
					event.completionTokens,
					event.errorCode ?? null,
					event.createdAt,
					event.createdAt,
				),
		]);
	}

	async tryReserve(
		reservation: AiUsageReservation,
		maximumTotalMicros: number,
		defaultApprovedBudgetMicros: number,
	): Promise<{ reserved: boolean; month: AiMonthLedger }> {
		const results = await this.#db.batch([
			this.#ensureMonth(
				reservation.environment,
				reservation.monthKey,
				reservation.createdAt,
				defaultApprovedBudgetMicros,
			),
			this.#db
				.prepare(
					`INSERT INTO ai_usage_events (
					   id, environment, month_key, feature, actor_user_id, mailbox_id,
					   requested_tier, selected_tier, model, cache_key, escalation_reason,
					   state, estimated_cost_micros, reservation_limit_micros,
					   reservation_expires_at, created_at
					 )
					 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?
					 FROM ai_usage_months
					 WHERE environment = ? AND month_key = ?
					   AND spent_micros + reserved_micros + ? <= ?
					 RETURNING id`,
				)
				.bind(
					reservation.id,
					reservation.environment,
					reservation.monthKey,
					reservation.feature,
					reservation.actorUserId ?? null,
					reservation.mailboxId ?? null,
					reservation.requestedTier,
					reservation.selectedTier,
					reservation.model,
					reservation.cacheKey ?? null,
					reservation.escalationReason ?? null,
					reservation.estimatedCostMicros,
					maximumTotalMicros,
					reservation.expiresAt,
					reservation.createdAt,
					reservation.environment,
					reservation.monthKey,
					reservation.estimatedCostMicros,
					maximumTotalMicros,
				),
		]);
		const month = await this.#requiredMonth(
			reservation.environment,
			reservation.monthKey,
		);
		return { reserved: rowCount(results[1]) === 1, month };
	}

	async completeReservation(
		reservationId: string,
		actual: {
			actualCostMicros: number;
			promptTokens: number;
			completionTokens: number;
		},
		alertThresholdMicros: number,
		completedAt: number,
	): Promise<{ completed: boolean; month: AiMonthLedger; emitAlert: boolean }> {
		const results = await this.#db.batch([
			this.#db
				.prepare(
					`UPDATE ai_usage_events
					 SET state = 'completed', actual_cost_micros = ?, prompt_tokens = ?,
					     completion_tokens = ?, completed_at = ?
					 WHERE id = ? AND state = 'reserved'
					 RETURNING id`,
				)
				.bind(
					actual.actualCostMicros,
					actual.promptTokens,
					actual.completionTokens,
					completedAt,
					reservationId,
				),
			this.#db
				.prepare(
					`UPDATE ai_usage_months
					 SET alert_emitted_at = ?, updated_at = ?
					 WHERE alert_emitted_at IS NULL
					   AND spent_micros >= ?
					   AND (environment, month_key) = (
					     SELECT environment, month_key FROM ai_usage_events WHERE id = ?
					   )
					 RETURNING month_key`,
				)
				.bind(completedAt, completedAt, alertThresholdMicros, reservationId),
		]);
		const month = await this.#monthForEvent(reservationId);
		return {
			completed: rowCount(results[0]) === 1,
			month,
			emitAlert: rowCount(results[1]) === 1,
		};
	}

	async markReservationStarted(reservationId: string, startedAt: number): Promise<boolean> {
		const result = await this.#db
			.prepare(
				`UPDATE ai_usage_events
				 SET provider_started_at = COALESCE(provider_started_at, ?)
				 WHERE id = ? AND state = 'reserved'
				 RETURNING id`,
			)
			.bind(startedAt, reservationId)
			.run();
		return rowCount(result) === 1;
	}

	async failReservation(
		reservationId: string,
		failure: {
			errorCode?: string;
			failedAt: number;
			charge: "auto" | "observed";
			actualCostMicros?: number;
			promptTokens?: number;
			completionTokens?: number;
		},
	): Promise<boolean> {
		const result = await this.#db
			.prepare(
				`UPDATE ai_usage_events
				 SET state = 'failed', error_code = ?,
				     actual_cost_micros = CASE
				       WHEN ? = 'observed' THEN ?
				       WHEN provider_started_at IS NOT NULL THEN estimated_cost_micros
				       ELSE 0
				     END,
				     prompt_tokens = ?, completion_tokens = ?, completed_at = ?
				 WHERE id = ? AND state = 'reserved'
				 RETURNING id`,
			)
			.bind(
				failure.errorCode ?? null,
				failure.charge,
				failure.actualCostMicros ?? 0,
				failure.promptTokens ?? 0,
				failure.completionTokens ?? 0,
				failure.failedAt,
				reservationId,
			)
			.run();
		return rowCount(result) === 1;
	}

	async approveBudget(input: {
		environment: string;
		monthKey: string;
		newApprovedBudgetMicros: number;
		reviewedBy: string;
		reason: string;
		reviewedAt: number;
		reviewId: string;
	}): Promise<AiMonthLedger> {
		const results = await this.#db.batch([
			this.#ensureMonth(
				input.environment,
				input.monthKey,
				input.reviewedAt,
				this.#defaultApprovedBudgetMicros,
			),
			this.#db
				.prepare(
					`INSERT INTO ai_budget_reviews (
					   id, environment, month_key, previous_budget_micros,
					   approved_budget_micros, reviewed_by, reason, reviewed_at
					 )
					 SELECT ?, environment, month_key, approved_budget_micros, ?, ?, ?, ?
					 FROM ai_usage_months
					 WHERE environment = ? AND month_key = ?
					   AND ? > approved_budget_micros
					   AND ? > spent_micros + reserved_micros
					 RETURNING id`,
				)
				.bind(
					input.reviewId,
					input.newApprovedBudgetMicros,
					input.reviewedBy,
					input.reason,
					input.reviewedAt,
					input.environment,
					input.monthKey,
					input.newApprovedBudgetMicros,
					input.newApprovedBudgetMicros,
				),
		]);
		if (rowCount(results[1]) !== 1) {
			throw new Error("The reviewed AI budget did not raise the active monthly cap");
		}
		return this.#requiredMonth(input.environment, input.monthKey);
	}

	#ensureMonth(
		environment: string,
		monthKey: string,
		updatedAt: number,
		approvedBudgetMicros: number,
	): D1PreparedStatement {
		return this.#db
			.prepare(
				`INSERT INTO ai_usage_months (
				   environment, month_key, approved_budget_micros, updated_at
				 ) VALUES (?, ?, ?, ?)
				 ON CONFLICT(environment, month_key) DO NOTHING`,
			)
			.bind(environment, monthKey, approvedBudgetMicros, updatedAt);
	}

	async #requiredMonth(environment: string, monthKey: string): Promise<AiMonthLedger> {
		const month = await this.getMonth(environment, monthKey);
		if (!month) throw new Error("AI monthly ledger is unavailable");
		return month;
	}

	async #monthForEvent(eventId: string): Promise<AiMonthLedger> {
		const row = await this.#db
			.prepare(
				`SELECT m.environment, m.month_key, m.spent_micros, m.reserved_micros,
				        m.approved_budget_micros, m.alert_emitted_at
				 FROM ai_usage_events e
				 JOIN ai_usage_months m
				   ON m.environment = e.environment AND m.month_key = e.month_key
				 WHERE e.id = ?`,
			)
			.bind(eventId)
			.first<MonthRow>();
		if (!row) throw new Error("AI usage reservation is unavailable");
		return mapMonth(row);
	}
}

export function createAiCostController(
	env: Env,
	config: AiCostControlConfig = resolveAiCostControlConfig(
		env as unknown as AiCostEnvironment,
	),
): AiCostController {
	return new AiCostController(
		new D1AiCostControlStore(env.DB, config.reviewThresholdMicros),
		config,
	);
}

export async function getCachedAiResponse<T>(
	env: Env,
	input: {
		cacheKey: string;
		mailboxId?: string;
		cacheScope?: string;
		now?: number;
	},
): Promise<T | null> {
	const config = resolveAiCostControlConfig(
		env as unknown as AiCostEnvironment,
	);
	const mailboxScope = cacheScope(input);
	const row = await env.DB.prepare(
		`SELECT value_json
		 FROM ai_response_cache
		 WHERE cache_key = ? AND environment = ? AND mailbox_scope = ?
		   AND expires_at > ?`,
	)
		.bind(
			input.cacheKey,
			config.environment,
			mailboxScope,
			input.now ?? Date.now(),
		)
		.first<{ value_json: string }>();
	if (!row) return null;
	try {
		return JSON.parse(row.value_json) as T;
	} catch {
		return null;
	}
}

export async function getLatestCachedAiResponseForScope<T>(
	env: Env,
	input: {
		cacheScope: string;
		feature: string;
		now?: number;
	},
): Promise<{ cacheKey: string; createdAt: number; value: T } | null> {
	const config = resolveAiCostControlConfig(env as unknown as AiCostEnvironment);
	const mailboxScope = cacheScope(input);
	const row = await env.DB.prepare(
		`SELECT cache_key, value_json, created_at
		 FROM ai_response_cache
		 WHERE environment = ? AND mailbox_scope = ? AND feature = ?
		   AND expires_at > ?
		 ORDER BY created_at DESC, cache_key ASC
		 LIMIT 1`,
	)
		.bind(config.environment, mailboxScope, input.feature, input.now ?? Date.now())
		.first<{ cache_key: string; value_json: string; created_at: number }>();
	if (!row) return null;
	try {
		return { cacheKey: row.cache_key, createdAt: row.created_at, value: JSON.parse(row.value_json) as T };
	} catch {
		return null;
	}
}

export async function putCachedAiResponse(
	env: Env,
	input: {
		cacheKey: string;
		mailboxId?: string;
		cacheScope?: string;
		feature: string;
		value: unknown;
		ttlMs?: number;
		now?: number;
	},
): Promise<void> {
	const config = resolveAiCostControlConfig(
		env as unknown as AiCostEnvironment,
	);
	const now = input.now ?? Date.now();
	const mailboxScope = cacheScope(input);
	await env.DB.prepare(
		`INSERT INTO ai_response_cache (
		   cache_key, environment, mailbox_id, mailbox_scope, feature,
		   value_json, created_at, expires_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(environment, cache_key, mailbox_scope) DO UPDATE SET
		   feature = excluded.feature,
		   value_json = excluded.value_json,
		   created_at = excluded.created_at,
		   expires_at = excluded.expires_at`,
	)
		.bind(
			input.cacheKey,
			config.environment,
			input.mailboxId?.toLowerCase() ?? null,
			mailboxScope,
			input.feature,
			JSON.stringify(input.value),
			now,
			now + (input.ttlMs ?? 30 * 24 * 60 * 60 * 1000),
		)
		.run();
}

function cacheScope(input: { mailboxId?: string; cacheScope?: string }): string {
	if (input.cacheScope !== undefined) {
		const scope = input.cacheScope.trim().toLowerCase();
		if (!scope || scope.length > 1_000) {
			throw new Error("AI cache scope is invalid");
		}
		return scope;
	}
	return input.mailboxId?.toLowerCase() ?? "";
}

function mapMonth(row: MonthRow): AiMonthLedger {
	return {
		environment: row.environment,
		monthKey: row.month_key,
		spentMicros: row.spent_micros,
		reservedMicros: row.reserved_micros,
		approvedBudgetMicros: row.approved_budget_micros,
		alertEmittedAt: row.alert_emitted_at,
	};
}

// Row counts, not meta.changes: these writes fire the migration 0004 aggregate
// triggers and D1 folds trigger-caused row changes into meta.changes, so only
// the RETURNING rows count the statement itself.
function rowCount(result: D1Result<unknown> | undefined): number {
	return result?.results.length ?? 0;
}
