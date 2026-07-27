// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Provider-neutral AI cost controls.
 *
 * This module does not call a model. Callers must reserve a conservative USD
 * estimate before paid inference, then reconcile the reservation with observed
 * usage. Deterministic work and cache hits use the same ledger seam but are
 * never disabled by an AI budget.
 */

export type AiModelTier = "cheap" | "strong";
export type AiRequestedTier = "auto" | AiModelTier;
export type AiUsageState =
	| "reserved"
	| "completed"
	| "failed"
	| "blocked"
	| "cache_hit"
	| "deterministic";

export type AiCostControlConfig = {
	environment: string;
	alertThresholdMicros: number;
	reviewThresholdMicros: number;
	cheapModel: string;
	strongModel: string;
};

export const DEFAULT_AI_COST_CONFIG: AiCostControlConfig = {
	environment: "default",
	alertThresholdMicros: 25_000_000,
	reviewThresholdMicros: 50_000_000,
	cheapModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
	strongModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

export const AI_USAGE_RESERVATION_TTL_MS = 15 * 60 * 1000;

const MODEL_PRICE_MICROS_PER_MILLION_TOKENS: Record<
	AiModelTier,
	{ prompt: number; completion: number }
> = {
	// Cloudflare Workers AI public rates for the configured default model tiers.
	cheap: { prompt: 270_000, completion: 850_000 },
	strong: { prompt: 293_000, completion: 2_253_000 },
};

/** Convert observed token usage into integer micro-dollars for the ledger. */
export function calculateAiUsageCostMicros(
	tier: AiModelTier,
	usage: { promptTokens: number; completionTokens: number },
): number {
	const promptTokens = nonnegativeInteger(usage.promptTokens);
	const completionTokens = nonnegativeInteger(usage.completionTokens);
	const price = MODEL_PRICE_MICROS_PER_MILLION_TOKENS[tier];
	return Math.ceil(
		(promptTokens * price.prompt + completionTokens * price.completion) /
			1_000_000,
	);
}

export type AiMonthLedger = {
	environment: string;
	monthKey: string;
	spentMicros: number;
	reservedMicros: number;
	approvedBudgetMicros: number;
	alertEmittedAt: number | null;
};

type AiUsageIdentity = {
	id: string;
	environment: string;
	monthKey: string;
	feature: string;
	actorUserId?: string;
	mailboxId?: string;
	requestedTier: AiRequestedTier;
	selectedTier: AiModelTier;
	model: string;
	cacheKey?: string;
	escalationReason?: string;
	createdAt: number;
};

export type AiUsageEvent = AiUsageIdentity & {
	state: Exclude<AiUsageState, "reserved">;
	estimatedCostMicros: number;
	actualCostMicros: number;
	promptTokens: number;
	completionTokens: number;
	errorCode?: string;
};

export type AiUsageReservation = AiUsageIdentity & {
	state: "reserved";
	estimatedCostMicros: number;
	expiresAt: number;
	providerStartedAt?: number;
};

export type AiUsageFailure = {
	errorCode?: string;
	failedAt: number;
	charge: "auto" | "observed";
	actualCostMicros?: number;
	promptTokens?: number;
	completionTokens?: number;
};

export interface AiCostControlStore {
	getMonth(environment: string, monthKey: string): Promise<AiMonthLedger | null>;
	reapExpiredReservations(now: number): Promise<void>;
	recordEvent(event: AiUsageEvent): Promise<void>;
	tryReserve(
		reservation: AiUsageReservation,
		maximumTotalMicros: number,
		defaultApprovedBudgetMicros: number,
	): Promise<{ reserved: boolean; month: AiMonthLedger }>;
	completeReservation(
		reservationId: string,
		actual: {
			actualCostMicros: number;
			promptTokens: number;
			completionTokens: number;
		},
		alertThresholdMicros: number,
		completedAt: number,
	): Promise<{ completed: boolean; month: AiMonthLedger; emitAlert: boolean }>;
	markReservationStarted(reservationId: string, startedAt: number): Promise<boolean>;
	failReservation(
		reservationId: string,
		failure: AiUsageFailure,
	): Promise<boolean>;
	approveBudget(input: {
		environment: string;
		monthKey: string;
		newApprovedBudgetMicros: number;
		reviewedBy: string;
		reason: string;
		reviewedAt: number;
		reviewId: string;
	}): Promise<AiMonthLedger>;
}

export type BeginAiUsageInput = {
	feature: string;
	actorUserId?: string;
	mailboxId?: string;
	requestedTier?: AiRequestedTier;
	escalationReason?: string;
	estimatedCostMicros: number;
	cacheKey?: string;
	cacheHit?: boolean;
};

export type AiUsageDecision =
	| {
			decision: "allow";
			mode: "paid" | "cached" | "deterministic";
			tier: AiModelTier;
			model: string;
			reservationId?: string;
			ledgerRecorded: boolean;
			reason?: undefined;
			reviewRequired?: false;
	  }
	| {
			decision: "block";
			reason:
				| "strong_tier_requires_reason"
				| "strong_tier_not_allowed_for_feature"
				| "strong_tier_paused_at_alert_threshold"
				| "admin_review_required"
				| "ledger_unavailable"
				| "invalid_request";
			reviewRequired: boolean;
			fallback: "deterministic_only";
			mode?: undefined;
			tier?: AiModelTier;
			model?: string;
			reservationId?: undefined;
			ledgerRecorded: boolean;
	  };

const STRONG_TIER_FEATURES = new Set([
	"assistant_chat",
	"compose_draft",
	"reply_draft",
	"relationship_insight",
]);

const MIN_ESCALATION_REASON_LENGTH = 20;

type ControllerDependencies = {
	now?: () => number;
	createId?: (prefix: string) => string;
};

export class AiCostController {
	readonly #store: AiCostControlStore;
	readonly #config: AiCostControlConfig;
	readonly #now: () => number;
	readonly #createId: (prefix: string) => string;

	constructor(
		store: AiCostControlStore,
		config: AiCostControlConfig,
		dependencies: ControllerDependencies = {},
	) {
		if (
			!Number.isSafeInteger(config.alertThresholdMicros) ||
			!Number.isSafeInteger(config.reviewThresholdMicros) ||
			config.alertThresholdMicros <= 0 ||
			config.reviewThresholdMicros <= config.alertThresholdMicros
		) {
			throw new Error("AI cost thresholds are invalid");
		}
		this.#store = store;
		this.#config = config;
		this.#now = dependencies.now ?? Date.now;
		this.#createId =
			dependencies.createId ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`);
	}

	async beginUsage(input: BeginAiUsageInput): Promise<AiUsageDecision> {
		const requestedTier = input.requestedTier ?? "auto";
		const tier: AiModelTier = requestedTier === "strong" ? "strong" : "cheap";
		const model = tier === "strong" ? this.#config.strongModel : this.#config.cheapModel;
		const now = this.#now();
		const monthKey = utcMonthKey(now);
		const estimatedCostMicros = input.cacheHit ? 0 : input.estimatedCostMicros;
		const identity = {
			id: this.#createId("aiuse"),
			environment: this.#config.environment,
			monthKey,
			feature: normalizeFeature(input.feature),
			actorUserId: cleanOptional(input.actorUserId),
			mailboxId: cleanOptional(input.mailboxId)?.toLowerCase(),
			requestedTier,
			selectedTier: tier,
			model,
			cacheKey: cleanOptional(input.cacheKey),
			escalationReason: cleanOptional(input.escalationReason)?.slice(0, 500),
			createdAt: now,
		} satisfies AiUsageIdentity;

		if (!Number.isSafeInteger(estimatedCostMicros) || estimatedCostMicros < 0) {
			return this.#blocked(identity, "invalid_request", false, input.estimatedCostMicros);
		}

		// A cache hit performs no inference. It remains usable even when the cached
		// value was originally produced by a strong model.
		if (!input.cacheHit && tier === "strong") {
			if (!STRONG_TIER_FEATURES.has(identity.feature)) {
				return this.#blocked(
					identity,
					"strong_tier_not_allowed_for_feature",
					false,
					estimatedCostMicros,
				);
			}
			if (
				!identity.escalationReason ||
				identity.escalationReason.length < MIN_ESCALATION_REASON_LENGTH
			) {
				return this.#blocked(
					identity,
					"strong_tier_requires_reason",
					false,
					estimatedCostMicros,
				);
			}
		}

		if (input.cacheHit || estimatedCostMicros === 0) {
			const state = input.cacheHit ? "cache_hit" : "deterministic";
			const ledgerRecorded = await this.#recordBestEffort({
				...identity,
				state,
				estimatedCostMicros: 0,
				actualCostMicros: 0,
				promptTokens: 0,
				completionTokens: 0,
			});
			return {
				decision: "allow",
				mode: input.cacheHit ? "cached" : "deterministic",
				tier,
				model,
				ledgerRecorded,
				reviewRequired: false,
			};
		}

		let month: AiMonthLedger;
		try {
			await this.#store.reapExpiredReservations(now);
			month =
				(await this.#store.getMonth(identity.environment, monthKey)) ??
				emptyMonth(identity.environment, monthKey, this.#config.reviewThresholdMicros);
		} catch {
			return {
				decision: "block",
				reason: "ledger_unavailable",
				reviewRequired: false,
				fallback: "deterministic_only",
				tier,
				model,
				ledgerRecorded: false,
			};
		}

		const currentTotal = month.spentMicros + month.reservedMicros;
		const approvedLimit = Math.max(
			month.approvedBudgetMicros,
			this.#config.reviewThresholdMicros,
		);
		if (
			currentTotal >= approvedLimit ||
			currentTotal + estimatedCostMicros > approvedLimit
		) {
			return this.#blocked(identity, "admin_review_required", true, estimatedCostMicros);
		}

		if (
			tier === "strong" &&
			(currentTotal >= this.#config.alertThresholdMicros ||
				currentTotal + estimatedCostMicros > this.#config.alertThresholdMicros)
		) {
			return this.#blocked(
				identity,
				"strong_tier_paused_at_alert_threshold",
				false,
				estimatedCostMicros,
			);
		}

		const reservation: AiUsageReservation = {
			...identity,
			state: "reserved",
			estimatedCostMicros,
			expiresAt: now + AI_USAGE_RESERVATION_TTL_MS,
		};
		const maximumTotalMicros =
			tier === "strong"
				? Math.min(approvedLimit, this.#config.alertThresholdMicros)
				: approvedLimit;
		try {
			const reserved = await this.#store.tryReserve(
				reservation,
				maximumTotalMicros,
				this.#config.reviewThresholdMicros,
			);
			if (!reserved.reserved) {
				const total = reserved.month.spentMicros + reserved.month.reservedMicros;
				const reason =
					tier === "strong" && total < approvedLimit
						? "strong_tier_paused_at_alert_threshold"
						: "admin_review_required";
				return this.#blocked(
					identity,
					reason,
					reason === "admin_review_required",
					estimatedCostMicros,
				);
			}
			return {
				decision: "allow",
				mode: "paid",
				tier,
				model,
				reservationId: reservation.id,
				ledgerRecorded: true,
				reviewRequired: false,
			};
		} catch {
			return {
				decision: "block",
				reason: "ledger_unavailable",
				reviewRequired: false,
				fallback: "deterministic_only",
				tier,
				model,
				ledgerRecorded: false,
			};
		}
	}

	async completeUsage(
		reservationId: string,
		actual: {
			actualCostMicros: number;
			promptTokens?: number;
			completionTokens?: number;
		},
	) {
		if (
			!reservationId ||
			!Number.isSafeInteger(actual.actualCostMicros) ||
			actual.actualCostMicros < 0
		) {
			throw new Error("Actual AI usage is invalid");
		}
		return this.#store.completeReservation(
			reservationId,
			{
				actualCostMicros: actual.actualCostMicros,
				promptTokens: nonnegativeInteger(actual.promptTokens),
				completionTokens: nonnegativeInteger(actual.completionTokens),
			},
			this.#config.alertThresholdMicros,
			this.#now(),
		);
	}

	async startUsage(reservationId: string): Promise<boolean> {
		if (!reservationId) throw new Error("AI usage reservation is required");
		return this.#store.markReservationStarted(reservationId, this.#now());
	}

	async failUsage(
		reservationId: string,
		failure: {
			errorCode?: string;
			actualCostMicros?: number;
			promptTokens?: number;
			completionTokens?: number;
		} = {},
	): Promise<boolean> {
		const hasObservedUsage =
			Number.isSafeInteger(failure.actualCostMicros) &&
			(failure.actualCostMicros ?? 0) > 0;
		return this.#store.failReservation(reservationId, {
			errorCode: cleanOptional(failure.errorCode)?.slice(0, 100),
			failedAt: this.#now(),
			charge: hasObservedUsage ? "observed" : "auto",
			actualCostMicros: hasObservedUsage ? failure.actualCostMicros : undefined,
			promptTokens: nonnegativeInteger(failure.promptTokens),
			completionTokens: nonnegativeInteger(failure.completionTokens),
		});
	}

	async approveMonthlyBudget(input: {
		newApprovedBudgetMicros: number;
		reviewedBy: string;
		reason: string;
	}): Promise<AiMonthLedger> {
		const reviewedBy = cleanOptional(input.reviewedBy);
		const reason = cleanOptional(input.reason);
		if (
			!Number.isSafeInteger(input.newApprovedBudgetMicros) ||
			input.newApprovedBudgetMicros <= this.#config.reviewThresholdMicros ||
			!reviewedBy ||
			!reason
		) {
			throw new Error("A valid admin review and higher monthly cap are required");
		}
		const reviewedAt = this.#now();
		const monthKey = utcMonthKey(reviewedAt);
		await this.#store.reapExpiredReservations(reviewedAt);
		const month = await this.#store.getMonth(this.#config.environment, monthKey);
		const currentTotal = (month?.spentMicros ?? 0) + (month?.reservedMicros ?? 0);
		if (input.newApprovedBudgetMicros <= currentTotal) {
			throw new Error("The reviewed monthly cap must exceed current AI usage");
		}
		return this.#store.approveBudget({
			environment: this.#config.environment,
			monthKey,
			newApprovedBudgetMicros: input.newApprovedBudgetMicros,
			reviewedBy,
			reason: reason.slice(0, 500),
			reviewedAt,
			reviewId: this.#createId("aireview"),
		});
	}

	async getCurrentMonth(): Promise<AiMonthLedger> {
		const now = this.#now();
		const monthKey = utcMonthKey(now);
		await this.#store.reapExpiredReservations(now);
		return (
			(await this.#store.getMonth(this.#config.environment, monthKey)) ??
			emptyMonth(
				this.#config.environment,
				monthKey,
				this.#config.reviewThresholdMicros,
			)
		);
	}

	async #blocked(
		identity: AiUsageIdentity,
		reason: Extract<AiUsageDecision, { decision: "block" }>["reason"],
		reviewRequired: boolean,
		estimatedCostMicros: number,
	): Promise<AiUsageDecision> {
		const ledgerRecorded = await this.#recordBestEffort({
			...identity,
			state: "blocked",
			estimatedCostMicros: Number.isSafeInteger(estimatedCostMicros)
				? Math.max(0, estimatedCostMicros)
				: 0,
			actualCostMicros: 0,
			promptTokens: 0,
			completionTokens: 0,
			errorCode: reason,
		});
		return {
			decision: "block",
			reason,
			reviewRequired,
			fallback: "deterministic_only",
			tier: identity.selectedTier,
			model: identity.model,
			ledgerRecorded,
		};
	}

	async #recordBestEffort(event: AiUsageEvent): Promise<boolean> {
		try {
			await this.#store.recordEvent(event);
			return true;
		} catch {
			return false;
		}
	}
}

export type AiCostEnvironment = Partial<{
	BRAND: string;
	AI_COST_ENVIRONMENT: string;
	AI_COST_ALERT_USD: string | number;
	AI_COST_REVIEW_USD: string | number;
	AI_CHEAP_MODEL: string;
	AI_STRONG_MODEL: string;
}>;

export function resolveAiCostControlConfig(env: AiCostEnvironment): AiCostControlConfig {
	const alertThresholdMicros = dollarsToMicros(
		env.AI_COST_ALERT_USD,
		DEFAULT_AI_COST_CONFIG.alertThresholdMicros,
	);
	let reviewThresholdMicros = dollarsToMicros(
		env.AI_COST_REVIEW_USD,
		DEFAULT_AI_COST_CONFIG.reviewThresholdMicros,
	);
	if (reviewThresholdMicros <= alertThresholdMicros) {
		reviewThresholdMicros = Math.max(
			DEFAULT_AI_COST_CONFIG.reviewThresholdMicros,
			alertThresholdMicros + 1_000_000,
		);
	}
	return {
		environment:
			cleanOptional(env.AI_COST_ENVIRONMENT) ??
			cleanOptional(env.BRAND)?.toLowerCase() ??
			DEFAULT_AI_COST_CONFIG.environment,
		alertThresholdMicros,
		reviewThresholdMicros,
		cheapModel:
			cleanOptional(env.AI_CHEAP_MODEL) ?? DEFAULT_AI_COST_CONFIG.cheapModel,
		strongModel:
			cleanOptional(env.AI_STRONG_MODEL) ?? DEFAULT_AI_COST_CONFIG.strongModel,
	};
}

export async function buildAiCacheKey(input: {
	feature: string;
	tier: AiModelTier;
	model: string;
	promptVersion: string;
	sourceVersion: string;
	mailboxId?: string;
	input: unknown;
}): Promise<string> {
	const feature = normalizeFeature(input.feature);
	const canonical = stableSerialize({
		feature,
		tier: input.tier,
		model: input.model,
		promptVersion: input.promptVersion,
		sourceVersion: input.sourceVersion,
		mailboxId: input.mailboxId?.trim().toLowerCase() ?? null,
		input: input.input,
	});
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonical),
	);
	const hash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `aic:v1:${feature}:${input.tier}:${hash}`;
}

function stableSerialize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) throw new Error("Cache key input is not serializable");
		return serialized;
	}
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
	const record = value as Record<string, unknown>;
	const fields = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
	return `{${fields.join(",")}}`;
}

function dollarsToMicros(value: string | number | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	const dollars = typeof value === "number" ? value : Number(value);
	const micros = Math.round(dollars * 1_000_000);
	return Number.isSafeInteger(micros) && micros > 0 ? micros : fallback;
}

function utcMonthKey(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 7);
}

function normalizeFeature(feature: string): string {
	const normalized = feature.trim().toLowerCase();
	if (!/^[a-z][a-z0-9_]{1,63}$/.test(normalized)) {
		throw new Error("AI feature name is invalid");
	}
	return normalized;
}

function cleanOptional(value: string | undefined): string | undefined {
	const cleaned = value?.trim();
	return cleaned || undefined;
}

function nonnegativeInteger(value: number | undefined): number {
	return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? (value as number) : 0;
}

function emptyMonth(
	environment: string,
	monthKey: string,
	approvedBudgetMicros: number,
): AiMonthLedger {
	return {
		environment,
		monthKey,
		spentMicros: 0,
		reservedMicros: 0,
		approvedBudgetMicros,
		alertEmittedAt: null,
	};
}
