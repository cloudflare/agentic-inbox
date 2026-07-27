import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { AiUsageReservation } from "./ai-cost-control.ts";
import { D1AiCostControlStore } from "./ai-cost-control-d1.ts";

class Statement {
	#values: unknown[] = [];
	readonly #database: DatabaseSync;
	readonly #sql: string;

	constructor(database: DatabaseSync, sql: string) {
		this.#database = database;
		this.#sql = sql;
	}

	bind(...values: unknown[]) {
		this.#values = values;
		return this;
	}

	async first<T>() {
		return (this.#statement().get(...this.#values) as T | undefined) ?? null;
	}

	async run() {
		return this.runSync();
	}

	runSync() {
		const before = totalChanges(this.#database);
		const results = this.#statement().all(...this.#values);
		return {
			success: true,
			results,
			meta: { changes: totalChanges(this.#database) - before },
		};
	}

	#statement(): StatementSync {
		return this.#database.prepare(this.#sql);
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

function d1(database: DatabaseSync): D1Database {
	return {
		prepare: (sql: string) => new Statement(database, sql),
		async batch(statements: Statement[]) {
			database.exec("BEGIN IMMEDIATE");
			try {
				const results = statements.map((statement) => statement.runSync());
				database.exec("COMMIT");
				return results;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
}

const MONTH_KEY = "2026-07";
const APPROVED_BUDGET_MICROS = 1_000_000;

function reservation(
	id: string,
	estimatedCostMicros: number,
	createdAt: number,
): AiUsageReservation {
	return {
		id,
		environment: "test",
		monthKey: MONTH_KEY,
		feature: "today-brief",
		actorUserId: "usr_owner",
		mailboxId: "owner@wiserchat.ai",
		requestedTier: "auto",
		selectedTier: "cheap",
		model: "test-model",
		state: "reserved",
		estimatedCostMicros,
		expiresAt: createdAt + 60_000,
		createdAt,
	};
}

test("D1 AI cost control reserves, completes, fails, and raises the cap with aggregate triggers live", async () => {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	database.exec(
		readFileSync(
			new URL("../../migrations/0004_create_ai_cost_controls.sql", import.meta.url),
			"utf8",
		),
	);
	const store = new D1AiCostControlStore(d1(database), APPROVED_BUDGET_MICROS);

	const first = await store.tryReserve(
		reservation("evt_first", 400_000, 100),
		APPROVED_BUDGET_MICROS,
		APPROVED_BUDGET_MICROS,
	);
	assert.equal(first.reserved, true);
	assert.equal(first.month.reservedMicros, 400_000);

	const overBudget = await store.tryReserve(
		reservation("evt_over_budget", 700_000, 200),
		APPROVED_BUDGET_MICROS,
		APPROVED_BUDGET_MICROS,
	);
	assert.equal(overBudget.reserved, false);
	assert.equal(overBudget.month.reservedMicros, 400_000);

	const completed = await store.completeReservation(
		"evt_first",
		{ actualCostMicros: 300_000, promptTokens: 10, completionTokens: 20 },
		250_000,
		300,
	);
	assert.equal(completed.completed, true);
	assert.equal(completed.emitAlert, true);
	assert.equal(completed.month.spentMicros, 300_000);
	assert.equal(completed.month.reservedMicros, 0);

	assert.equal(
		(await store.completeReservation(
			"evt_first",
			{ actualCostMicros: 1, promptTokens: 0, completionTokens: 0 },
			250_000,
			400,
		)).completed,
		false,
	);

	const failing = await store.tryReserve(
		reservation("evt_failing", 200_000, 500),
		APPROVED_BUDGET_MICROS,
		APPROVED_BUDGET_MICROS,
	);
	assert.equal(failing.reserved, true);
	assert.equal(await store.markReservationStarted("evt_failing", 600), true);
	assert.equal(
		await store.failReservation("evt_failing", {
			errorCode: "provider_timeout",
			failedAt: 700,
			charge: "auto",
		}),
		true,
	);
	const afterFailure = await store.getMonth("test", MONTH_KEY);
	assert.equal(afterFailure?.reservedMicros, 0);
	assert.equal(afterFailure?.spentMicros, 500_000);

	const raised = await store.approveBudget({
		environment: "test",
		monthKey: MONTH_KEY,
		newApprovedBudgetMicros: 2_000_000,
		reviewedBy: "usr_admin",
		reason: "launch week",
		reviewedAt: 800,
		reviewId: "rev_first",
	});
	assert.equal(raised.approvedBudgetMicros, 2_000_000);

	await assert.rejects(
		store.approveBudget({
			environment: "test",
			monthKey: MONTH_KEY,
			newApprovedBudgetMicros: 1_500_000,
			reviewedBy: "usr_admin",
			reason: "lowering is not an approval",
			reviewedAt: 900,
			reviewId: "rev_second",
		}),
		/did not raise the active monthly cap/,
	);
});
