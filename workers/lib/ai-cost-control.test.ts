import assert from "node:assert/strict";
import test from "node:test";

import {
	AiCostController,
	DEFAULT_AI_COST_CONFIG,
	buildAiCacheKey,
	calculateAiUsageCostMicros,
	resolveAiCostControlConfig,
	type AiCostControlStore,
	type AiMonthLedger,
	type AiUsageEvent,
	type AiUsageReservation,
} from "./ai-cost-control.ts";

class MemoryStore implements AiCostControlStore {
	month: AiMonthLedger | null = null;
	events: AiUsageEvent[] = [];
	reservations = new Map<string, AiUsageReservation>();
	throwOnRead = false;

	async getMonth(): Promise<AiMonthLedger | null> {
		if (this.throwOnRead) throw new Error("ledger unavailable");
		return this.month ? { ...this.month } : null;
	}

	async reapExpiredReservations(now: number): Promise<void> {
		for (const [id, reservation] of this.reservations) {
			if (reservation.expiresAt > now) continue;
			this.reservations.delete(id);
			if (this.month) {
				this.month.reservedMicros -= reservation.estimatedCostMicros;
				if (reservation.providerStartedAt !== undefined) {
					this.month.spentMicros += reservation.estimatedCostMicros;
				}
			}
		}
	}

	async recordEvent(event: AiUsageEvent): Promise<void> {
		this.events.push({ ...event });
	}

	async tryReserve(
		reservation: AiUsageReservation,
		maximumTotalMicros: number,
		defaultApprovedBudgetMicros: number,
	): Promise<{ reserved: boolean; month: AiMonthLedger }> {
		this.month ??= {
			environment: reservation.environment,
			monthKey: reservation.monthKey,
			spentMicros: 0,
			reservedMicros: 0,
			approvedBudgetMicros: defaultApprovedBudgetMicros,
			alertEmittedAt: null,
		};
		if (
			this.month.spentMicros +
				this.month.reservedMicros +
				reservation.estimatedCostMicros >
			maximumTotalMicros
		) {
			return { reserved: false, month: { ...this.month } };
		}
		this.month.reservedMicros += reservation.estimatedCostMicros;
		this.reservations.set(reservation.id, { ...reservation });
		return { reserved: true, month: { ...this.month } };
	}

	async completeReservation(
		reservationId: string,
		actual: { actualCostMicros: number; promptTokens: number; completionTokens: number },
		alertThresholdMicros: number,
		completedAt: number,
	): Promise<{ completed: boolean; month: AiMonthLedger; emitAlert: boolean }> {
		const reservation = this.reservations.get(reservationId);
		assert.ok(reservation);
		assert.ok(this.month);
		this.month.reservedMicros -= reservation.estimatedCostMicros;
		this.month.spentMicros += actual.actualCostMicros;
		const emitAlert =
			this.month.spentMicros >= alertThresholdMicros &&
			this.month.alertEmittedAt === null;
		if (emitAlert) this.month.alertEmittedAt = completedAt;
		this.reservations.delete(reservationId);
		return { completed: true, month: { ...this.month }, emitAlert };
	}

	async markReservationStarted(reservationId: string, startedAt: number): Promise<boolean> {
		const reservation = this.reservations.get(reservationId);
		if (!reservation) return false;
		this.reservations.set(reservationId, { ...reservation, providerStartedAt: startedAt });
		return true;
	}

	async failReservation(
		reservationId: string,
		failure?: {
			errorCode?: string;
			failedAt: number;
			charge: "auto" | "observed";
			actualCostMicros?: number;
			promptTokens?: number;
			completionTokens?: number;
		},
	): Promise<boolean> {
		const reservation = this.reservations.get(reservationId);
		if (!reservation || !this.month) return false;
		this.month.reservedMicros -= reservation.estimatedCostMicros;
		this.month.spentMicros +=
			failure?.charge === "auto" && reservation.providerStartedAt !== undefined
				? reservation.estimatedCostMicros
				: failure?.charge === "observed"
					? failure.actualCostMicros ?? 0
					: 0;
		this.reservations.delete(reservationId);
		return true;
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
		assert.ok(this.month);
		this.month.approvedBudgetMicros = input.newApprovedBudgetMicros;
		return { ...this.month };
	}
}

const now = Date.UTC(2026, 6, 11, 12);

function controller(store: MemoryStore) {
	let id = 0;
	return new AiCostController(store, DEFAULT_AI_COST_CONFIG, {
		now: () => now,
		createId: (prefix) => `${prefix}-${++id}`,
	});
}

test("routine features reserve cheap-tier usage by default", async () => {
	const store = new MemoryStore();
	const result = await controller(store).beginUsage({
		feature: "reply_draft",
		actorUserId: "user-1",
		mailboxId: "team@example.com",
		estimatedCostMicros: 25_000,
	});

	assert.equal(result.decision, "allow");
	assert.equal(result.mode, "paid");
	assert.equal(result.tier, "cheap");
	assert.equal(result.model, DEFAULT_AI_COST_CONFIG.cheapModel);
	assert.equal(store.month?.reservedMicros, 25_000);
});

test("expired reservations are released before the next budget decision", async () => {
	const store = new MemoryStore();
	let currentTime = now;
	let id = 0;
	const cost = new AiCostController(store, {
		...DEFAULT_AI_COST_CONFIG,
		reviewThresholdMicros: 100_000,
		alertThresholdMicros: 50_000,
	}, {
		now: () => currentTime,
		createId: (prefix) => `${prefix}-${++id}`,
	});
	const first = await cost.beginUsage({
		feature: "reply_draft",
		estimatedCostMicros: 100_000,
	});
	assert.equal(first.decision, "allow");

	currentTime += 15 * 60 * 1000 + 1;
	const next = await cost.beginUsage({
		feature: "reply_draft",
		estimatedCostMicros: 100_000,
	});
	assert.equal(next.decision, "allow");
	assert.equal(store.reservations.size, 1);
});

test("actual usage cost is calculated from provider token counts", () => {
	assert.equal(
		calculateAiUsageCostMicros("cheap", {
			promptTokens: 1_000_000,
			completionTokens: 0,
		}),
		270_000,
	);
	assert.equal(
		calculateAiUsageCostMicros("cheap", {
			promptTokens: 0,
			completionTokens: 1_000_000,
		}),
		850_000,
	);
	assert.equal(
		calculateAiUsageCostMicros("cheap", {
			promptTokens: 1_000,
			completionTokens: 500,
		}),
		695,
	);
});

test("strong tier requires a supported feature and a reasoned escalation", async () => {
	const store = new MemoryStore();
	const noReason = await controller(store).beginUsage({
		feature: "assistant_chat",
		requestedTier: "strong",
		estimatedCostMicros: 50_000,
	});
	assert.deepEqual(
		{ decision: noReason.decision, reason: noReason.reason },
		{ decision: "block", reason: "strong_tier_requires_reason" },
	);

	const unsupported = await controller(store).beginUsage({
		feature: "draft_verification",
		requestedTier: "strong",
		escalationReason: "The cheap model could not safely resolve ambiguity.",
		estimatedCostMicros: 50_000,
	});
	assert.deepEqual(
		{ decision: unsupported.decision, reason: unsupported.reason },
		{ decision: "block", reason: "strong_tier_not_allowed_for_feature" },
	);
});

test("reasoned strong-tier use is allowed below the alert threshold and paused first", async () => {
	const store = new MemoryStore();
	store.month = {
		environment: "default",
		monthKey: "2026-07",
		spentMicros: 24_900_000,
		reservedMicros: 0,
		approvedBudgetMicros: 50_000_000,
		alertEmittedAt: null,
	};
	const result = await controller(store).beginUsage({
		feature: "assistant_chat",
		requestedTier: "strong",
		escalationReason: "A complex multi-thread answer failed on the cheap tier.",
		estimatedCostMicros: 200_000,
	});

	assert.deepEqual(
		{ decision: result.decision, reason: result.reason },
		{ decision: "block", reason: "strong_tier_paused_at_alert_threshold" },
	);
});

test("paid inference stops at the review threshold while cache hits remain available", async () => {
	const store = new MemoryStore();
	store.month = {
		environment: "default",
		monthKey: "2026-07",
		spentMicros: 50_000_000,
		reservedMicros: 0,
		approvedBudgetMicros: 50_000_000,
		alertEmittedAt: now,
	};
	const cost = controller(store);
	const paid = await cost.beginUsage({
		feature: "reply_draft",
		estimatedCostMicros: 1,
	});
	assert.deepEqual(
		{ decision: paid.decision, reason: paid.reason, reviewRequired: paid.reviewRequired },
		{ decision: "block", reason: "admin_review_required", reviewRequired: true },
	);

	const cached = await cost.beginUsage({
		feature: "reply_draft",
		estimatedCostMicros: 10_000,
		cacheHit: true,
		cacheKey: "aic:v1:cached",
	});
	assert.equal(cached.decision, "allow");
	assert.equal(cached.mode, "cached");
	assert.equal(store.events.at(-1)?.state, "cache_hit");
});

test("an explicit admin review raises the monthly paid-inference cap", async () => {
	const store = new MemoryStore();
	store.month = {
		environment: "default",
		monthKey: "2026-07",
		spentMicros: 50_000_000,
		reservedMicros: 0,
		approvedBudgetMicros: 50_000_000,
		alertEmittedAt: now,
	};
	const cost = controller(store);
	await cost.approveMonthlyBudget({
		newApprovedBudgetMicros: 60_000_000,
		reviewedBy: "admin-1",
		reason: "Approved for the remaining customer-support launch work.",
	});
	const result = await cost.beginUsage({
		feature: "reply_draft",
		estimatedCostMicros: 100_000,
	});

	assert.equal(result.decision, "allow");
	assert.equal(result.mode, "paid");
});

test("ledger read failures block paid inference but not zero-cost deterministic work", async () => {
	const store = new MemoryStore();
	store.throwOnRead = true;
	const cost = controller(store);
	const paid = await cost.beginUsage({
		feature: "compose_draft",
		estimatedCostMicros: 10_000,
	});
	assert.deepEqual(
		{ decision: paid.decision, reason: paid.reason },
		{ decision: "block", reason: "ledger_unavailable" },
	);

	const deterministic = await cost.beginUsage({
		feature: "message_rules",
		estimatedCostMicros: 0,
	});
	assert.equal(deterministic.decision, "allow");
	assert.equal(deterministic.mode, "deterministic");
});

test("the $25 alert signal is emitted once per environment month", async () => {
	const store = new MemoryStore();
	store.month = {
		environment: "default",
		monthKey: "2026-07",
		spentMicros: 24_990_000,
		reservedMicros: 0,
		approvedBudgetMicros: 50_000_000,
		alertEmittedAt: null,
	};
	const cost = controller(store);
	const first = await cost.beginUsage({ feature: "reply_draft", estimatedCostMicros: 20_000 });
	assert.equal(first.decision, "allow");
	if (first.decision !== "allow" || !first.reservationId) assert.fail("reservation missing");
	const completed = await cost.completeUsage(first.reservationId, {
		actualCostMicros: 20_000,
		promptTokens: 500,
		completionTokens: 100,
	});
	assert.equal(completed.emitAlert, true);

	const second = await cost.beginUsage({ feature: "reply_draft", estimatedCostMicros: 5_000 });
	assert.equal(second.decision, "allow");
	if (second.decision !== "allow" || !second.reservationId) assert.fail("reservation missing");
	const completedAgain = await cost.completeUsage(second.reservationId, {
		actualCostMicros: 5_000,
		promptTokens: 100,
		completionTokens: 20,
	});
	assert.equal(completedAgain.emitAlert, false);
});

test("failed provider calls charge observed partial usage", async () => {
	const store = new MemoryStore();
	const cost = controller(store);
	const decision = await cost.beginUsage({
		feature: "assistant_chat",
		estimatedCostMicros: 25_000,
	});
	assert.equal(decision.decision, "allow");
	if (decision.decision !== "allow" || !decision.reservationId) {
		assert.fail("reservation missing");
	}

	await cost.startUsage(decision.reservationId);
	await cost.failUsage(decision.reservationId, {
		errorCode: "AbortError",
		actualCostMicros: 695,
		promptTokens: 1_000,
		completionTokens: 500,
	});

	assert.equal(store.month?.reservedMicros, 0);
	assert.equal(store.month?.spentMicros, 695);
});

test("failed started calls charge their estimate when no usage was observed", async () => {
	const store = new MemoryStore();
	const cost = controller(store);
	const decision = await cost.beginUsage({
		feature: "assistant_chat",
		estimatedCostMicros: 25_000,
	});
	assert.equal(decision.decision, "allow");
	if (decision.decision !== "allow" || !decision.reservationId) {
		assert.fail("reservation missing");
	}

	await cost.startUsage(decision.reservationId);
	await cost.failUsage(decision.reservationId, { errorCode: "AbortError" });

	assert.equal(store.month?.reservedMicros, 0);
	assert.equal(store.month?.spentMicros, 25_000);
});

test("failures before a provider call starts release the reservation without spend", async () => {
	const store = new MemoryStore();
	const cost = controller(store);
	const decision = await cost.beginUsage({
		feature: "assistant_chat",
		estimatedCostMicros: 25_000,
	});
	assert.equal(decision.decision, "allow");
	if (decision.decision !== "allow" || !decision.reservationId) {
		assert.fail("reservation missing");
	}

	await cost.failUsage(decision.reservationId, { errorCode: "context_build_failed" });

	assert.equal(store.month?.reservedMicros, 0);
	assert.equal(store.month?.spentMicros, 0);
});

test("cache keys are stable, scoped, and contain no mailbox or prompt text", async () => {
	const base = {
		feature: "reply_draft",
		tier: "cheap" as const,
		model: "cheap-model",
		promptVersion: "reply-v2",
		sourceVersion: "thread-42-v7",
		mailboxId: "Private.Team@Example.com",
	};
	const a = await buildAiCacheKey({ ...base, input: { subject: "Hello", tags: ["a", "b"] } });
	const b = await buildAiCacheKey({ ...base, input: { tags: ["a", "b"], subject: "Hello" } });
	const c = await buildAiCacheKey({ ...base, promptVersion: "reply-v3", input: { subject: "Hello", tags: ["a", "b"] } });

	assert.equal(a, b);
	assert.notEqual(a, c);
	assert.match(a, /^aic:v1:reply_draft:cheap:[a-f0-9]{64}$/);
	assert.ok(!a.includes("Private.Team"));
	assert.ok(!a.includes("Hello"));
});

test("thresholds and tier models are configurable with safe defaults", () => {
	assert.deepEqual(resolveAiCostControlConfig({}), DEFAULT_AI_COST_CONFIG);
	const config = resolveAiCostControlConfig({
		BRAND: "wiser",
		AI_COST_ALERT_USD: "30",
		AI_COST_REVIEW_USD: "70",
		AI_CHEAP_MODEL: "cheap-v2",
		AI_STRONG_MODEL: "strong-v2",
	});
	assert.equal(config.environment, "wiser");
	assert.equal(config.alertThresholdMicros, 30_000_000);
	assert.equal(config.reviewThresholdMicros, 70_000_000);
	assert.equal(config.cheapModel, "cheap-v2");
	assert.equal(config.strongModel, "strong-v2");
});
