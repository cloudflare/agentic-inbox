import assert from "node:assert/strict";
import test from "node:test";
import type { AiUsageDecision } from "./ai-cost-control.ts";
import {
	prepareGlobalTodayBriefCandidates,
	type GlobalTodayBriefMailboxCandidateSource,
} from "./global-today-brief-candidates.ts";

import {
	globalTodayBriefFailureCode,
	GlobalTodayBriefAccessChangedError,
	runGlobalTodayBrief,
	type GlobalTodayBriefRuntimeDependencies,
} from "./global-today-brief-runtime.ts";
import { TodayBriefValidationError } from "./today-brief.ts";
import type { GlobalTodayBriefSnapshot } from "./global-today-brief-snapshot.ts";

const day = {
	timeZone: "Africa/Cairo",
	localDate: "2026-07-12",
	startAt: "2026-07-11T21:00:00.000Z",
	endAt: "2026-07-12T21:00:00.000Z",
};

function snapshot(options: { empty?: boolean; cacheKey?: string; fingerprint?: string } = {}): GlobalTodayBriefSnapshot {
	const candidates = options.empty ? [] : [{
		conversationKey: "real-conversation",
		sourceEmailId: "real-message",
		latestMessageAt: "2026-07-12T11:00:00.000Z",
		subject: "A customer needs attention",
		counterparty: "customer@example.com",
		reasons: ["unread_in_mailbox" as const],
		reminder: null,
		unreadInMailbox: true,
	}];
	const mailbox: GlobalTodayBriefMailboxCandidateSource = {
		mailboxId: "team@example.com",
		address: "team@example.com",
		type: "SHARED",
		metadata: {
			sequence: 7,
			totalCandidateCount: candidates.length,
			counts: { privateRemindersDue: 0, unreadConversations: candidates.length },
			candidates,
		},
	};
	const prepared = prepareGlobalTodayBriefCandidates({
		localDate: day.localDate,
		timezone: day.timeZone,
		mailboxes: [mailbox],
		evidenceByMailbox: new Map([["team@example.com", {
			sequence: 7,
			evidence: options.empty ? [] : [{
				conversationKey: "real-conversation",
				messages: [{
					id: "real-message",
					date: "2026-07-12T11:00:00.000Z",
					folderId: "inbox",
					sender: "customer@example.com",
					subject: "A customer needs attention",
					text: "Could you review this request?",
				}],
			}],
		}]]),
	});
	return {
		prepared,
		fingerprint: options.fingerprint ?? "gtbf:v1:current",
		cacheKey: options.cacheKey ?? `global-cache-${"x".repeat(40)}`,
		freshness: {
			roster: [{ mailboxId: "team@example.com", address: "team@example.com", type: "SHARED" }],
			reminders: [],
			sequences: [{ mailboxId: "team@example.com", sequence: 7 }],
		},
		counts: prepared.counts,
	};
}

function modelOutput() {
	return JSON.stringify({
		items: [{
			candidateId: "candidate-01",
			rank: 1,
			whyNow: "unread_request",
			suggestedNextStep: "review",
			messageIds: ["evidence-01-01"],
			requiresHumanReview: true,
		}],
	});
}

function dependencies(current = snapshot()) {
	const calls = {
		claim: 0,
		provider: 0,
		begin: [] as Array<Record<string, unknown>>,
		put: 0,
		complete: 0,
		fail: 0,
		failureCodes: [] as Array<string | undefined>,
	};
	let cached: Parameters<GlobalTodayBriefRuntimeDependencies["putCached"]>[2] | null = null;
	const allowed: AiUsageDecision = {
		decision: "allow",
		mode: "paid",
		tier: "cheap",
		model: "cheap-model",
		reservationId: "reservation-1",
		ledgerRecorded: true,
	};
	const deps: GlobalTodayBriefRuntimeDependencies = {
		readSnapshot: async () => ({ state: "ready", snapshot: current }),
		freshnessStatus: async () => "current",
		getCached: async () => cached,
		getLatestCached: async () => null,
		putCached: async (_key, _scope, value) => { calls.put += 1; cached = value; },
		claimGeneration: async () => { calls.claim += 1; return true; },
		ownsGeneration: async () => true,
		releaseGeneration: async () => true,
		beginUsage: async (input) => { calls.begin.push(input as unknown as Record<string, unknown>); return allowed; },
		startUsage: async () => true,
		completeUsage: async () => { calls.complete += 1; },
		failUsage: async (_reservationId, failure) => { calls.fail += 1; calls.failureCodes.push(failure.errorCode); },
		runModel: async () => { calls.provider += 1; return { text: modelOutput(), promptTokens: 100, completionTokens: 20 }; },
		now: () => Date.parse("2026-07-12T12:00:00.000Z"),
	};
	return { deps, calls, setCached(value: typeof cached) { cached = value; } };
}

function input(scope: string, refresh = false) {
	return { actorUserId: "actor-a", day, refresh, requestScope: scope };
}

test("complete aggregate snapshot generates one cited actor-private brief", async () => {
	const { deps, calls } = dependencies();
	const result = await runGlobalTodayBrief(deps, input("generated"));
	assert.equal(result.state, "generated");
	if (result.state !== "generated") return;
	assert.deepEqual(result.items[0]?.sources, [{ mailboxId: "team@example.com", messageId: "real-message" }]);
	assert.equal(result.items[0]?.candidate.mailboxAddress, "team@example.com");
	assert.equal(calls.provider, 1);
	assert.equal(calls.put, 1);
	assert.equal(calls.complete, 1);
	assert.equal(calls.begin[0]?.feature, "global_today_brief");
	assert.equal("mailboxId" in calls.begin[0]!, false);
});

test("incomplete and empty snapshots perform zero cache, claim, ledger, and provider work", async () => {
	const incomplete = dependencies();
	incomplete.deps.readSnapshot = async () => ({ state: "overview_incomplete" });
	assert.deepEqual(await runGlobalTodayBrief(incomplete.deps, input("incomplete")), { state: "overview_incomplete" });
	assert.deepEqual(incomplete.calls, { claim: 0, provider: 0, begin: [], put: 0, complete: 0, fail: 0, failureCodes: [] });

	const empty = dependencies(snapshot({ empty: true }));
	assert.deepEqual(await runGlobalTodayBrief(empty.deps, input("empty")), {
		state: "no_attention",
		counts: { privateRemindersDue: 0, unreadConversations: 0 },
		omittedCount: 0,
	});
	assert.equal(empty.calls.provider, 0);
	assert.equal(empty.calls.claim, 0);
	assert.equal(empty.calls.begin.length, 0);
});

test("automatic mode returns stale after a different same-day brief while explicit Refresh generates", async () => {
	const automatic = dependencies();
	automatic.deps.getLatestCached = async () => ({
		cacheKey: "different-key",
		value: {
			fingerprint: "old",
			localDate: day.localDate,
			generatedAt: "2026-07-12T08:00:00.000Z",
			result: { items: [] },
		},
	});
	assert.equal((await runGlobalTodayBrief(automatic.deps, input("auto-stale"))).state, "stale");
	assert.equal(automatic.calls.claim, 0);
	assert.equal(automatic.calls.provider, 0);

	const explicit = dependencies();
	explicit.deps.getLatestCached = automatic.deps.getLatestCached;
	assert.equal((await runGlobalTodayBrief(explicit.deps, input("explicit", true))).state, "generated");
	assert.equal(explicit.calls.provider, 1);
});

test("an exact validated cache hit avoids claims and paid inference", async () => {
	const current = snapshot();
	const cached = dependencies(current);
	cached.setCached({
		fingerprint: current.fingerprint,
		localDate: day.localDate,
		generatedAt: "2026-07-12T08:00:00.000Z",
		result: JSON.parse(modelOutput()),
	});
	const result = await runGlobalTodayBrief(cached.deps, input("cached"));
	assert.equal(result.state, "cached");
	assert.equal(cached.calls.claim, 0);
	assert.equal(cached.calls.provider, 0);
	assert.equal(cached.calls.begin[0]?.cacheHit, true);
});

test("contention returns preparing and snapshot drift after inference is never cached", async () => {
	const contention = dependencies();
	contention.deps.claimGeneration = async () => false;
	assert.equal((await runGlobalTodayBrief(contention.deps, input("contention"))).state, "preparing");
	assert.equal(contention.calls.provider, 0);

	const stale = dependencies();
	let freshnessRead = 0;
	stale.deps.freshnessStatus = async () => ++freshnessRead < 3 ? "current" : "changed";
	assert.equal((await runGlobalTodayBrief(stale.deps, input("provider-stale"))).state, "stale");
	assert.equal(stale.calls.provider, 1);
	assert.equal(stale.calls.put, 0);

	const lostClaim = dependencies();
	let ownershipRead = 0;
	lostClaim.deps.ownsGeneration = async () => ++ownershipRead < 3;
	assert.equal((await runGlobalTodayBrief(lostClaim.deps, input("claim-lost"))).state, "preparing");
	assert.equal(lostClaim.calls.provider, 1);
	assert.equal(lostClaim.calls.put, 0);
});

test("simultaneous automatic requests share one provider call in an isolate", async () => {
	const shared = dependencies();
	shared.deps.runModel = async () => {
		shared.calls.provider += 1;
		await new Promise((resolve) => setTimeout(resolve, 5));
		return { text: modelOutput(), promptTokens: 100, completionTokens: 20 };
	};
	const [left, right] = await Promise.all([
		runGlobalTodayBrief(shared.deps, input("same-request")),
		runGlobalTodayBrief(shared.deps, input("same-request")),
	]);
	assert.equal(left.state, "generated");
	assert.equal(right.state, "generated");
	assert.equal(shared.calls.provider, 1);
});

test("authorization drift returns no snapshot-derived counts or guidance", async () => {
	const revoked = dependencies();
	revoked.deps.freshnessStatus = async () => "access_changed";
	await assert.rejects(
		runGlobalTodayBrief(revoked.deps, input("revoked")),
		(error) => error instanceof GlobalTodayBriefAccessChangedError,
	);
	assert.equal(revoked.calls.provider, 0);

	const snapshotRevoked = dependencies();
	snapshotRevoked.deps.readSnapshot = async () => ({ state: "access_changed" });
	await assert.rejects(runGlobalTodayBrief(snapshotRevoked.deps, input("snapshot-revoked")), GlobalTodayBriefAccessChangedError);

	const emptyRevoked = dependencies(snapshot({ empty: true }));
	emptyRevoked.deps.freshnessStatus = async () => "access_changed";
	await assert.rejects(runGlobalTodayBrief(emptyRevoked.deps, input("empty-revoked")), GlobalTodayBriefAccessChangedError);

	const contendedRevoked = dependencies();
	contendedRevoked.deps.claimGeneration = async () => false;
	contendedRevoked.deps.freshnessStatus = async () => "access_changed";
	await assert.rejects(runGlobalTodayBrief(contendedRevoked.deps, input("contended-revoked")), GlobalTodayBriefAccessChangedError);
});

test("automatic contention is actor-day scoped across different fingerprints and timezones", async () => {
	const left = dependencies(snapshot({ cacheKey: `left-${"a".repeat(40)}`, fingerprint: "gtbf:v1:left" }));
	const right = dependencies(snapshot({ cacheKey: `right-${"b".repeat(40)}`, fingerprint: "gtbf:v1:right" }));
	let claimed = false;
	let providers = 0;
	const claim = async ({ cacheKey }: { cacheKey: string }) => {
		assert.match(cacheKey, /^global-today-brief:auto-day:actor-a:2026-07-12$/u);
		if (claimed) return false;
		claimed = true;
		return true;
	};
	left.deps.claimGeneration = claim as GlobalTodayBriefRuntimeDependencies["claimGeneration"];
	right.deps.claimGeneration = claim as GlobalTodayBriefRuntimeDependencies["claimGeneration"];
	left.deps.runModel = right.deps.runModel = async () => {
		providers += 1;
		await new Promise((resolve) => setTimeout(resolve, 5));
		return { text: modelOutput(), promptTokens: 100, completionTokens: 20 };
	};
	const utcDay = { ...day, timeZone: "UTC", startAt: "2026-07-12T00:00:00.000Z", endAt: "2026-07-13T00:00:00.000Z" };
	const results = await Promise.all([
		runGlobalTodayBrief(left.deps, input("cross-timezone-left")),
		runGlobalTodayBrief(right.deps, { actorUserId: "actor-a", day: utcDay, refresh: false, requestScope: "cross-timezone-right" }),
	]);
	assert.deepEqual(results.map((result) => result.state).sort(), ["generated", "preparing"]);
	assert.equal(providers, 1);
});

test("budget pause, cache failure, and invalid provider output preserve deterministic Today", async () => {
	const budget = dependencies();
	budget.deps.beginUsage = async () => ({ decision: "block", reason: "admin_review_required", reviewRequired: true });
	const paused = await runGlobalTodayBrief(budget.deps, input("budget"));
	assert.equal(paused.state, "budget_paused");
	assert.equal(budget.calls.provider, 0);

	const cacheFailure = dependencies();
	cacheFailure.deps.putCached = async () => { cacheFailure.calls.put += 1; throw new Error("D1 unavailable"); };
	assert.equal((await runGlobalTodayBrief(cacheFailure.deps, input("cache-failure"))).state, "generated");
	assert.equal(cacheFailure.calls.provider, 1);
	assert.equal(cacheFailure.calls.put, 1);

	const invalid = dependencies();
	invalid.deps.runModel = async () => { invalid.calls.provider += 1; return { text: "not-json", promptTokens: 10, completionTokens: 2 }; };
	const invalidResult = await runGlobalTodayBrief(invalid.deps, input("invalid-output"));
	assert.equal(invalidResult.state, "brief_unavailable");
	assert.equal(invalid.calls.fail, 1);
	assert.deepEqual(invalid.calls.failureCodes, ["invalid_global_today_brief_output:malformed_json"]);
	assert.equal(invalid.calls.put, 0);
});

test("pre-provider source drift spends nothing and a failed reservation start is reconciled", async () => {
	const changed = dependencies();
	changed.deps.freshnessStatus = async () => "changed";
	assert.equal((await runGlobalTodayBrief(changed.deps, input("changed-before-provider"))).state, "stale");
	assert.equal(changed.calls.begin.length, 0);
	assert.equal(changed.calls.provider, 0);

	const startFailure = dependencies();
	startFailure.deps.startUsage = async () => false;
	const startResult = await runGlobalTodayBrief(startFailure.deps, input("start-failure"));
	assert.equal(startResult.state, "brief_unavailable");
	assert.equal(startFailure.calls.fail, 1);
	assert.equal(startFailure.calls.provider, 0);
});

test("a corrupt exact same-day cache blocks a second automatic paid call", async () => {
	const current = snapshot();
	const corrupt = dependencies(current);
	corrupt.setCached({
		fingerprint: current.fingerprint,
		localDate: day.localDate,
		generatedAt: "2026-07-12T08:00:00.000Z",
		result: { items: [] },
	});
	corrupt.deps.getLatestCached = async () => ({
		cacheKey: current.cacheKey,
		value: {
			fingerprint: current.fingerprint,
			localDate: day.localDate,
			generatedAt: "2026-07-12T08:00:00.000Z",
			result: { items: [] },
		},
	});
	assert.equal((await runGlobalTodayBrief(corrupt.deps, input("corrupt-cache"))).state, "stale");
	assert.equal(corrupt.calls.provider, 0);
});

test("cached-path revocation is never swallowed as ordinary cache corruption", async () => {
	const current = snapshot();
	const cached = dependencies(current);
	cached.setCached({
		fingerprint: current.fingerprint,
		localDate: day.localDate,
		generatedAt: "2026-07-12T08:00:00.000Z",
		result: JSON.parse(modelOutput()),
	});
	cached.deps.freshnessStatus = async () => "access_changed";
	await assert.rejects(runGlobalTodayBrief(cached.deps, input("cached-revoked")), GlobalTodayBriefAccessChangedError);
	assert.equal(cached.calls.provider, 0);
});

test("same-day gate revocation routes through access loss without exposing old counts", async () => {
	const gated = dependencies();
	gated.deps.getLatestCached = async () => ({
		cacheKey: "previous-key",
		value: {
			fingerprint: "previous",
			localDate: day.localDate,
			generatedAt: "2026-07-12T08:00:00.000Z",
			result: { items: [] },
		},
	});
	gated.deps.freshnessStatus = async () => "access_changed";
	await assert.rejects(runGlobalTodayBrief(gated.deps, input("gate-revoked")), GlobalTodayBriefAccessChangedError);
	assert.equal(gated.calls.claim, 0);
	assert.equal(gated.calls.provider, 0);
});

test("ledger failure codes name the broken rule without carrying free text", () => {
	assert.equal(
		globalTodayBriefFailureCode(new TodayBriefValidationError("ignored", "unsupported_unread_state")),
		"invalid_global_today_brief_output:unsupported_unread_state",
	);
	assert.equal(
		globalTodayBriefFailureCode(new TodayBriefValidationError("ignored", "malformed_json")),
		"invalid_global_today_brief_output:malformed_json",
	);

	const provider = new Error("prompt 'invoice for alice@example.com' was rejected");
	provider.name = "InferenceUpstreamError";
	assert.equal(
		globalTodayBriefFailureCode(provider),
		"global_today_brief_failed:inferenceupstreamerror",
	);

	// Prose in the name field is not a classification and must not be persisted.
	const prose = new Error("boom");
	prose.name = "Rejected: alice@example.com asked about invoice 42";
	assert.equal(globalTodayBriefFailureCode(prose), "global_today_brief_failed");
	assert.equal(globalTodayBriefFailureCode("not-an-error"), "global_today_brief_failed");
	assert.equal(globalTodayBriefFailureCode(new Error("boom")), "global_today_brief_failed:error");

	const longName = new Error("boom");
	longName.name = `A${"b".repeat(300)}`;
	const bounded = globalTodayBriefFailureCode(longName);
	// failUsage truncates at 100 characters; a truncated code would be unqueryable.
	assert.ok(bounded.length <= 100, bounded);
	assert.match(bounded, /^[a-z0-9_:]+$/);
});
