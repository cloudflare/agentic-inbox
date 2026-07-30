import {
	GLOBAL_TODAY_BRIEF_AI_CONFIG,
	type GlobalTodayBriefResponse,
} from "../../shared/global-today-brief.ts";
import type { TodayBriefGeneratedResult } from "../../shared/today-brief.ts";
import type { Env } from "../types.ts";
import {
	calculateAiUsageCostMicros,
	resolveAiCostControlConfig,
	type AiUsageDecision,
	type BeginAiUsageInput,
} from "./ai-cost-control.ts";
import {
	createAiCostController,
	getCachedAiResponse,
	getLatestCachedAiResponseForScope,
	putCachedAiResponse,
} from "./ai-cost-control-d1.ts";
import { globalTodayBriefClaimStore } from "./global-today-brief-claims-d1.ts";
import {
	createGlobalTodayBriefSnapshotDependencies,
	globalTodayBriefFreshnessStatus,
	readGlobalTodayBriefSnapshot,
	type GlobalTodayBriefFreshnessStatus,
	type GlobalTodayBriefSnapshot,
	type GlobalTodayBriefSnapshotDependencies,
} from "./global-today-brief-snapshot.ts";
import type { TodayBriefDayBoundary } from "./today-brief-timezone.ts";
import {
	buildTodayBriefModelMessages,
	parseTodayBriefOutput,
	TODAY_BRIEF_OUTPUT_JSON_SCHEMA,
	TodayBriefValidationError,
} from "./today-brief.ts";

const CACHE_TTL_MS = 48 * 60 * 60 * 1_000;
const CLAIM_TTL_MS = 2 * 60 * 1_000;
/** Keeps every ledger error code inside the 100-char bound failUsage enforces. */
const PROVIDER_FAILURE_NAME_CHARS = 40;
/** The shape of a JavaScript error class name. Prose never matches it. */
const ERROR_CLASS_NAME = /^[A-Za-z][A-Za-z0-9_$.]*$/;

/**
 * A provider rejection carries an error class name plus a message that can echo
 * the mail evidence it was given. Only the class name classifies the failure,
 * and only when it is shaped like a class name, so no free text can reach the
 * ledger even if a provider puts prose in the wrong field.
 */
export function globalTodayBriefFailureCode(error: unknown): string {
	if (error instanceof TodayBriefValidationError) {
		return `invalid_global_today_brief_output:${error.subcode}`;
	}
	const name = error instanceof Error ? error.name : "";
	if (!ERROR_CLASS_NAME.test(name)) return "global_today_brief_failed";
	const classified = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.slice(0, PROVIDER_FAILURE_NAME_CHARS);
	return `global_today_brief_failed:${classified}`;
}

export class GlobalTodayBriefAccessChangedError extends Error {
	constructor() {
		super("Global Today brief access changed");
		this.name = "GlobalTodayBriefAccessChangedError";
	}
}

type CachedGlobalTodayBrief = {
	fingerprint: string;
	localDate: string;
	generatedAt: string;
	result: TodayBriefGeneratedResult;
};

type ModelResult = {
	text: string;
	promptTokens: number;
	completionTokens: number;
};

export type GlobalTodayBriefRuntimeDependencies = {
	readSnapshot(): ReturnType<typeof readGlobalTodayBriefSnapshot>;
	freshnessStatus(snapshot: GlobalTodayBriefSnapshot): Promise<GlobalTodayBriefFreshnessStatus>;
	getCached(cacheKey: string, cacheScope: string): Promise<CachedGlobalTodayBrief | null>;
	getLatestCached(cacheScope: string): Promise<{ cacheKey: string; value: CachedGlobalTodayBrief } | null>;
	putCached(cacheKey: string, cacheScope: string, value: CachedGlobalTodayBrief): Promise<void>;
	claimGeneration(input: { cacheKey: string; cacheScope: string; claimToken: string; expiresAt: number }): Promise<boolean>;
	ownsGeneration(input: { cacheKey: string; cacheScope: string; claimToken: string }): Promise<boolean>;
	releaseGeneration(input: { cacheKey: string; cacheScope: string; claimToken: string }): Promise<unknown>;
	beginUsage(input: BeginAiUsageInput): Promise<AiUsageDecision>;
	startUsage(reservationId: string): Promise<boolean>;
	completeUsage(reservationId: string, actual: { actualCostMicros: number; promptTokens: number; completionTokens: number }): Promise<unknown>;
	failUsage(reservationId: string, failure: { errorCode: string; actualCostMicros?: number; promptTokens: number; completionTokens: number }): Promise<unknown>;
	runModel(model: string, messages: ReturnType<typeof buildTodayBriefModelMessages>): Promise<ModelResult>;
	now?(): number;
};

export type RunGlobalTodayBriefInput = {
	actorUserId: string;
	day: TodayBriefDayBoundary;
	refresh: boolean;
	requestScope?: string;
};

const requestInFlight = new Map<string, Promise<GlobalTodayBriefResponse>>();

function privateCacheScope(actorUserId: string) {
	return `global-today-brief:owner:${actorUserId.trim().toLowerCase()}`;
}

function transientResponse(
	state: "preparing" | "stale",
	snapshot: GlobalTodayBriefSnapshot,
): GlobalTodayBriefResponse {
	return { state, counts: snapshot.counts, omittedCount: snapshot.prepared.omittedCount };
}

function freshnessResponse(status: Exclude<GlobalTodayBriefFreshnessStatus, "current">, snapshot: GlobalTodayBriefSnapshot): GlobalTodayBriefResponse {
	if (status === "access_changed") throw new GlobalTodayBriefAccessChangedError();
	return status === "changed" ? transientResponse("stale", snapshot) : { state: "overview_incomplete" };
}

function validGeneratedAt(value: string) {
	return Number.isFinite(Date.parse(value)) && value === new Date(value).toISOString();
}

function publicResponse(
	state: "cached" | "generated",
	snapshot: GlobalTodayBriefSnapshot,
	payload: CachedGlobalTodayBrief,
): GlobalTodayBriefResponse {
	return {
		state,
		fingerprint: snapshot.fingerprint,
		generatedAt: payload.generatedAt,
		counts: snapshot.counts,
		omittedCount: snapshot.prepared.omittedCount,
		items: payload.result.items.map((item) => {
			const authority = snapshot.prepared.authority.get(item.candidateId);
			if (!authority) throw new Error("Validated aggregate Today candidate is unavailable");
			const sources = item.messageIds.map((messageId) => authority.evidence.get(messageId));
			if (sources.some((source) => source === undefined)) {
				throw new Error("Validated aggregate Today evidence is unavailable");
			}
			return {
				candidate: authority.publicCandidate,
				whyNow: item.whyNow,
				suggestedNextStep: item.suggestedNextStep,
				sources: sources as Array<{ mailboxId: string; messageId: string }>,
				requiresHumanReview: true,
			};
		}),
	};
}

async function validatedCachedResponse(
	dependencies: GlobalTodayBriefRuntimeDependencies,
	input: RunGlobalTodayBriefInput,
	snapshot: GlobalTodayBriefSnapshot,
	cacheScope: string,
): Promise<GlobalTodayBriefResponse | null> {
	const cached = await dependencies.getCached(snapshot.cacheKey, cacheScope);
	if (
		!cached ||
		cached.fingerprint !== snapshot.fingerprint ||
		cached.localDate !== input.day.localDate ||
		!validGeneratedAt(cached.generatedAt)
	) return null;
	const result = parseTodayBriefOutput(JSON.stringify(cached.result), snapshot.prepared.input, { requireUnreadSourceCitation: true });
	let freshness = await dependencies.freshnessStatus(snapshot);
	if (freshness !== "current") return freshnessResponse(freshness, snapshot);
	await dependencies.beginUsage({
		feature: GLOBAL_TODAY_BRIEF_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		requestedTier: GLOBAL_TODAY_BRIEF_AI_CONFIG.requestedTier,
		escalationReason: GLOBAL_TODAY_BRIEF_AI_CONFIG.escalationReason,
		estimatedCostMicros: GLOBAL_TODAY_BRIEF_AI_CONFIG.estimatedCostMicros,
		cacheKey: snapshot.cacheKey,
		cacheHit: true,
	});
	freshness = await dependencies.freshnessStatus(snapshot);
	if (freshness !== "current") return freshnessResponse(freshness, snapshot);
	return publicResponse("cached", snapshot, { ...cached, result });
}

async function automaticRefreshGate(
	dependencies: GlobalTodayBriefRuntimeDependencies,
	input: RunGlobalTodayBriefInput,
	cacheScope: string,
) {
	if (input.refresh) return false;
	const latest = await dependencies.getLatestCached(cacheScope);
	return Boolean(
		latest &&
		latest.value.localDate === input.day.localDate &&
		validGeneratedAt(latest.value.generatedAt),
	);
}

async function automaticGateResponse(
	dependencies: GlobalTodayBriefRuntimeDependencies,
	snapshot: GlobalTodayBriefSnapshot,
) {
	const freshness = await dependencies.freshnessStatus(snapshot);
	return freshness === "current" ? transientResponse("stale", snapshot) : freshnessResponse(freshness, snapshot);
}

async function generationStatus(
	dependencies: GlobalTodayBriefRuntimeDependencies,
	snapshot: GlobalTodayBriefSnapshot,
	claimKey: string,
	cacheScope: string,
	claimToken: string,
) {
	if (!(await dependencies.ownsGeneration({ cacheKey: claimKey, cacheScope, claimToken }))) {
		const freshness = await dependencies.freshnessStatus(snapshot);
		return freshness === "current" ? "claim_lost" as const : freshness;
	}
	return dependencies.freshnessStatus(snapshot);
}

function generationResponse(status: "claim_lost" | Exclude<GlobalTodayBriefFreshnessStatus, "current">, snapshot: GlobalTodayBriefSnapshot) {
	return status === "claim_lost" ? transientResponse("preparing", snapshot) : freshnessResponse(status, snapshot);
}

async function generate(
	dependencies: GlobalTodayBriefRuntimeDependencies,
	input: RunGlobalTodayBriefInput,
	snapshot: GlobalTodayBriefSnapshot,
	claimKey: string,
	cacheScope: string,
	claimToken: string,
): Promise<GlobalTodayBriefResponse> {
	const messages = buildTodayBriefModelMessages(snapshot.prepared.input);
	let status = await generationStatus(dependencies, snapshot, claimKey, cacheScope, claimToken);
	if (status !== "current") {
		return generationResponse(status, snapshot);
	}
	const decision = await dependencies.beginUsage({
		feature: GLOBAL_TODAY_BRIEF_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		requestedTier: GLOBAL_TODAY_BRIEF_AI_CONFIG.requestedTier,
		escalationReason: GLOBAL_TODAY_BRIEF_AI_CONFIG.escalationReason,
		estimatedCostMicros: GLOBAL_TODAY_BRIEF_AI_CONFIG.estimatedCostMicros,
		cacheKey: snapshot.cacheKey,
		cacheHit: false,
	});
	if (decision.decision === "block" || !decision.reservationId) {
		status = await generationStatus(dependencies, snapshot, claimKey, cacheScope, claimToken);
		if (status !== "current") {
			return generationResponse(status, snapshot);
		}
		return {
			state: "budget_paused",
			reason: decision.reason ?? "inference_unavailable",
			counts: snapshot.counts,
			omittedCount: snapshot.prepared.omittedCount,
		};
	}

	let promptTokens = 0;
	let completionTokens = 0;
	try {
		status = await generationStatus(dependencies, snapshot, claimKey, cacheScope, claimToken);
		if (status !== "current") {
			await dependencies.failUsage(decision.reservationId, {
				errorCode: "global_today_brief_snapshot_changed",
				promptTokens: 0,
				completionTokens: 0,
			});
			return generationResponse(status, snapshot);
		}
		if (!(await dependencies.startUsage(decision.reservationId))) {
			throw new Error("Aggregate Today AI usage reservation could not be started");
		}
		const model = await dependencies.runModel(decision.model, messages);
		promptTokens = model.promptTokens;
		completionTokens = model.completionTokens;
		const result = parseTodayBriefOutput(model.text, snapshot.prepared.input, { requireUnreadSourceCitation: true });
		const actualCostMicros = calculateAiUsageCostMicros(decision.tier, { promptTokens, completionTokens });
		await dependencies.completeUsage(decision.reservationId, {
			actualCostMicros: actualCostMicros || GLOBAL_TODAY_BRIEF_AI_CONFIG.estimatedCostMicros,
			promptTokens,
			completionTokens,
		});
		status = await generationStatus(dependencies, snapshot, claimKey, cacheScope, claimToken);
		if (status !== "current") {
			return generationResponse(status, snapshot);
		}
		const payload: CachedGlobalTodayBrief = {
			fingerprint: snapshot.fingerprint,
			localDate: input.day.localDate,
			generatedAt: new Date((dependencies.now ?? Date.now)()).toISOString(),
			result,
		};
		status = await generationStatus(dependencies, snapshot, claimKey, cacheScope, claimToken);
		if (status !== "current") {
			return generationResponse(status, snapshot);
		}
		try {
			await dependencies.putCached(snapshot.cacheKey, cacheScope, payload);
		} catch {
			// Validated, charged guidance remains usable if cache persistence fails.
		}
		status = await generationStatus(dependencies, snapshot, claimKey, cacheScope, claimToken);
		if (status !== "current") {
			return generationResponse(status, snapshot);
		}
		return publicResponse("generated", snapshot, payload);
	} catch (error) {
		const actualCostMicros = calculateAiUsageCostMicros(decision.tier, { promptTokens, completionTokens });
		await dependencies.failUsage(decision.reservationId, {
			errorCode: globalTodayBriefFailureCode(error),
			...(actualCostMicros > 0 ? { actualCostMicros } : {}),
			promptTokens,
			completionTokens,
		});
		throw error;
	}
}

async function runReadySnapshot(
	dependencies: GlobalTodayBriefRuntimeDependencies,
	input: RunGlobalTodayBriefInput,
	snapshot: GlobalTodayBriefSnapshot,
): Promise<GlobalTodayBriefResponse> {
	if (snapshot.prepared.input.candidates.length === 0) {
		const freshness = await dependencies.freshnessStatus(snapshot);
		return freshness === "current"
			? { state: "no_attention", counts: snapshot.counts, omittedCount: 0 }
			: freshnessResponse(freshness, snapshot);
	}
	const cacheScope = privateCacheScope(input.actorUserId);
	try {
		const cached = await validatedCachedResponse(dependencies, input, snapshot, cacheScope);
		if (cached) return cached;
	} catch (error) {
		if (error instanceof GlobalTodayBriefAccessChangedError) throw error;
		// Corrupt or unavailable cache entries never become user-facing guidance.
	}
	if (await automaticRefreshGate(dependencies, input, cacheScope)) {
		return automaticGateResponse(dependencies, snapshot);
	}
	const claimToken = crypto.randomUUID();
	const now = (dependencies.now ?? Date.now)();
	const generationKey = input.refresh
		? snapshot.cacheKey
		: `global-today-brief:auto-day:${input.actorUserId.trim().toLowerCase()}:${input.day.localDate}`;
	if (!(await dependencies.claimGeneration({
		cacheKey: generationKey,
		cacheScope,
		claimToken,
		expiresAt: now + CLAIM_TTL_MS,
	}))) {
		const freshness = await dependencies.freshnessStatus(snapshot);
		return freshness === "current" ? transientResponse("preparing", snapshot) : freshnessResponse(freshness, snapshot);
	}

	let renewal: ReturnType<typeof setInterval> | undefined;
	try {
		const cached = await validatedCachedResponse(dependencies, input, snapshot, cacheScope);
		if (cached) return cached;
		if (await automaticRefreshGate(dependencies, input, cacheScope)) {
			return automaticGateResponse(dependencies, snapshot);
		}
		renewal = setInterval(() => {
			void dependencies.claimGeneration({
				cacheKey: generationKey,
				cacheScope,
				claimToken,
				expiresAt: (dependencies.now ?? Date.now)() + CLAIM_TTL_MS,
			}).catch(() => undefined);
		}, 30_000);
		return await generate(dependencies, input, snapshot, generationKey, cacheScope, claimToken);
	} finally {
		if (renewal !== undefined) clearInterval(renewal);
		await dependencies.releaseGeneration({ cacheKey: generationKey, cacheScope, claimToken }).catch(() => undefined);
	}
}

async function runOnce(
	dependencies: GlobalTodayBriefRuntimeDependencies,
	input: RunGlobalTodayBriefInput,
): Promise<GlobalTodayBriefResponse> {
	const snapshotResult = await dependencies.readSnapshot();
	if (snapshotResult.state === "access_changed") throw new GlobalTodayBriefAccessChangedError();
	if (snapshotResult.state !== "ready") return { state: "overview_incomplete" };
	const snapshot = snapshotResult.snapshot;
	try {
		return await runReadySnapshot(dependencies, input, snapshot);
	} catch (error) {
		if (error instanceof GlobalTodayBriefAccessChangedError) throw error;
		// A brief that cannot be generated degrades to Today's deterministic
		// content instead of failing the request.
		return {
			state: "brief_unavailable",
			reason: globalTodayBriefFailureCode(error),
			counts: snapshot.counts,
			omittedCount: snapshot.prepared.omittedCount,
		};
	}
}

export function runGlobalTodayBrief(
	dependencies: GlobalTodayBriefRuntimeDependencies,
	input: RunGlobalTodayBriefInput,
): Promise<GlobalTodayBriefResponse> {
	const requestKey = [
		input.actorUserId.trim().toLowerCase(),
		input.day.localDate,
		input.day.timeZone,
		input.refresh ? "refresh" : "automatic",
		input.requestScope?.trim().toLowerCase() ?? "default",
	].join("|");
	const existing = requestInFlight.get(requestKey);
	if (existing) return existing;
	const work = Promise.resolve().then(() => runOnce(dependencies, input));
	requestInFlight.set(requestKey, work);
	void work.finally(() => {
		if (requestInFlight.get(requestKey) === work) requestInFlight.delete(requestKey);
	}).catch(() => undefined);
	return work;
}

export function createGlobalTodayBriefRuntime(
	env: Env,
	input: { actorUserId: string; day: TodayBriefDayBoundary },
): GlobalTodayBriefRuntimeDependencies {
	const config = resolveAiCostControlConfig(env);
	const snapshotDependencies: GlobalTodayBriefSnapshotDependencies = createGlobalTodayBriefSnapshotDependencies(env);
	const cost = createAiCostController(env, config);
	const claims = globalTodayBriefClaimStore(env);
	const owner = input.actorUserId.trim().toLowerCase();
	return {
		readSnapshot: () => readGlobalTodayBriefSnapshot(snapshotDependencies, input),
		freshnessStatus: (snapshot) => globalTodayBriefFreshnessStatus(snapshotDependencies, {
			actorUserId: input.actorUserId,
			day: input.day,
			expected: snapshot.freshness,
		}),
		getCached: (cacheKey, cacheScope) => getCachedAiResponse(env, { cacheKey, cacheScope }),
		getLatestCached: async (cacheScope) => {
			const latest = await getLatestCachedAiResponseForScope<CachedGlobalTodayBrief>(env, {
				cacheScope,
				feature: GLOBAL_TODAY_BRIEF_AI_CONFIG.feature,
			});
			return latest ? { cacheKey: latest.cacheKey, value: latest.value } : null;
		},
		putCached: (cacheKey, cacheScope, value) => putCachedAiResponse(env, {
			cacheKey,
			cacheScope,
			feature: GLOBAL_TODAY_BRIEF_AI_CONFIG.feature,
			value,
			ttlMs: CACHE_TTL_MS,
		}),
		claimGeneration: ({ cacheKey, cacheScope, claimToken, expiresAt }) => claims.claim({
			cacheKey,
			cacheScope,
			ownerUserId: owner,
			claimToken,
			expiresAt,
		}),
		ownsGeneration: ({ cacheKey, cacheScope, claimToken }) => claims.owns({ cacheKey, cacheScope, ownerUserId: owner, claimToken }),
		releaseGeneration: ({ cacheKey, cacheScope, claimToken }) => claims.release({ cacheKey, cacheScope, ownerUserId: owner, claimToken }),
		beginUsage: (usage) => cost.beginUsage(usage),
		startUsage: (reservationId) => cost.startUsage(reservationId),
		completeUsage: (reservationId, actual) => cost.completeUsage(reservationId, actual),
		failUsage: (reservationId, failure) => cost.failUsage(reservationId, failure),
		runModel: async (model, messages) => {
			const ai = env.AI as unknown as { run(model: string, input: Record<string, unknown>): Promise<unknown> };
			const response = await ai.run(model, {
				messages,
				max_tokens: GLOBAL_TODAY_BRIEF_AI_CONFIG.maxTokens,
				temperature: GLOBAL_TODAY_BRIEF_AI_CONFIG.temperature,
				// Workers AI JSON mode. The strong tier supports it; it removes the
				// malformed-JSON failure mode but not the evidence preconditions.
				response_format: {
					type: "json_schema",
					json_schema: TODAY_BRIEF_OUTPUT_JSON_SCHEMA,
				},
			}) as { response?: string | object; usage?: { prompt_tokens?: number; completion_tokens?: number } };
			return {
				// JSON mode can hand back a parsed object rather than a string.
				text: typeof response.response === "object" && response.response !== null
					? JSON.stringify(response.response)
					: (response.response ?? "").trim(),
				promptTokens: Math.max(0, Math.floor(response.usage?.prompt_tokens ?? 0)),
				completionTokens: Math.max(0, Math.floor(response.usage?.completion_tokens ?? 0)),
			};
		},
	};
}
