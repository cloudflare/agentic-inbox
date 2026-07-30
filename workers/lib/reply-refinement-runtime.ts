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
	putCachedAiResponse,
} from "./ai-cost-control-d1.ts";
import {
	REPLY_REFINEMENT_AI_CONFIG,
	buildReplyRefinementCacheKey,
	buildReplyRefinementModelMessages,
	fingerprintReplyRefinementInput,
	normalizeReplyRefinementSourceEmailId,
	normalizeReplyRefinementWritingPrompt,
	parseReplyRefinementOutput,
	parseReplyRefinementRequest,
	type NormalizedReplyRefinementRequest,
	type ReplyRefinementModelMessage,
	type ReplyRefinementResult,
} from "./reply-refinement.ts";
import {
	gatherConversationIntelligenceEvidence,
	ConversationIntelligenceNotFoundError,
	ConversationIntelligenceUnsupportedStateError,
} from "./conversation-intelligence-runtime.ts";
import type { NormalizedConversationIntelligenceInput } from "./conversation-intelligence.ts";
import { mailboxAccess } from "./mailbox-access.ts";
import { resolveAgentSystemPrompt } from "./prompts.ts";
import { resolveBrand } from "../routes/brand.ts";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type CachedReplyRefinement = {
	fingerprint: string;
	bodyText: string;
};

type ReplyRefinementSnapshot = {
	evidence: NormalizedConversationIntelligenceInput;
	writingPrompt: string;
	fingerprint: string;
};

type ModelResult = {
	text: string;
	promptTokens: number;
	completionTokens: number;
};

export class ReplyRefinementAccessRevokedError extends Error {
	constructor() {
		super("Mailbox access was revoked");
		this.name = "ReplyRefinementAccessRevokedError";
	}
}

export class ReplyRefinementSourceUnavailableError extends Error {
	constructor() {
		super("Reply source Message is unavailable in the eligible Conversation");
		this.name = "ReplyRefinementSourceUnavailableError";
	}
}

export class ReplyRefinementWritingPromptUnavailableError extends Error {
	constructor() {
		super("Mailbox writing prompt is unavailable");
		this.name = "ReplyRefinementWritingPromptUnavailableError";
	}
}

export type ReplyRefinementRuntimeResponse =
	| {
			state: "cached" | "generated";
			fingerprint: string;
			result: ReplyRefinementResult;
	  }
	| { state: "budget_paused"; reason: string }
	| { state: "stale" };

export interface ReplyRefinementRuntimeDependencies {
	environment: string;
	model: string;
	canAccess(): Promise<boolean>;
	readEvidence(
		sourceEmailId: string,
	): Promise<NormalizedConversationIntelligenceInput>;
	readWritingPrompt(): Promise<string>;
	getCached(
		cacheKey: string,
		cacheScope: string,
	): Promise<CachedReplyRefinement | null>;
	putCached(
		cacheKey: string,
		cacheScope: string,
		value: CachedReplyRefinement,
	): Promise<void>;
	deleteCached(cacheKey: string, cacheScope: string): Promise<void>;
	beginUsage(input: BeginAiUsageInput): Promise<AiUsageDecision>;
	startUsage(reservationId: string): Promise<boolean>;
	completeUsage(
		reservationId: string,
		actual: {
			actualCostMicros: number;
			promptTokens: number;
			completionTokens: number;
		},
	): Promise<unknown>;
	failUsage(
		reservationId: string,
		failure: {
			errorCode: string;
			actualCostMicros?: number;
			promptTokens: number;
			completionTokens: number;
		},
	): Promise<unknown>;
	runModel(
		model: string,
		messages: ReplyRefinementModelMessage[],
	): Promise<ModelResult>;
}

export type RunReplyRefinementInput = {
	actorUserId: string;
	mailboxId: string;
	sourceEmailId: string;
	request: unknown;
};

type NormalizedRunInput = {
	actorUserId: string;
	mailboxId: string;
	sourceEmailId: string;
	request: NormalizedReplyRefinementRequest;
};

function privateCacheScope(actorUserId: string, mailboxId: string): string {
	return `reply-refinement:owner:${actorUserId}:mailbox:${mailboxId}`;
}

async function requireAccess(
	dependencies: ReplyRefinementRuntimeDependencies,
): Promise<void> {
	if (!(await dependencies.canAccess())) {
		throw new ReplyRefinementAccessRevokedError();
	}
}

function requireSourceInEvidence(
	evidence: NormalizedConversationIntelligenceInput,
	sourceEmailId: string,
): void {
	if (!evidence.messages.some((message) => message.id === sourceEmailId)) {
		throw new ReplyRefinementSourceUnavailableError();
	}
}

async function readSnapshot(
	dependencies: ReplyRefinementRuntimeDependencies,
	input: NormalizedRunInput,
): Promise<ReplyRefinementSnapshot> {
	const [evidence, writingPrompt] = await Promise.all([
		dependencies.readEvidence(input.sourceEmailId),
		dependencies.readWritingPrompt(),
	]);
	requireSourceInEvidence(evidence, input.sourceEmailId);
	return {
		evidence,
		writingPrompt,
		fingerprint: await fingerprintReplyRefinementInput(
			evidence,
			input.request,
			writingPrompt,
			{
				environment: dependencies.environment,
				model: dependencies.model,
				actorUserId: input.actorUserId,
				mailboxId: input.mailboxId,
				sourceEmailId: input.sourceEmailId,
			},
		),
	};
}

async function readCurrentSnapshot(
	dependencies: ReplyRefinementRuntimeDependencies,
	input: NormalizedRunInput,
	expectedFingerprint: string,
): Promise<ReplyRefinementSnapshot | null> {
	await requireAccess(dependencies);
	let current: ReplyRefinementSnapshot;
	try {
		current = await readSnapshot(dependencies, input);
	} catch (error) {
		if (
			error instanceof ConversationIntelligenceNotFoundError ||
			error instanceof ConversationIntelligenceUnsupportedStateError ||
			error instanceof ReplyRefinementSourceUnavailableError ||
			error instanceof ReplyRefinementWritingPromptUnavailableError
		) {
			return null;
		}
		throw error;
	}
	await requireAccess(dependencies);
	return current.fingerprint === expectedFingerprint ? current : null;
}

async function tryCachedRefinement(
	dependencies: ReplyRefinementRuntimeDependencies,
	input: NormalizedRunInput,
	snapshot: ReplyRefinementSnapshot,
	cacheKey: string,
	cacheScope: string,
): Promise<ReplyRefinementRuntimeResponse | null> {
	const currentBeforeCacheUse = await readCurrentSnapshot(
		dependencies,
		input,
		snapshot.fingerprint,
	);
	if (!currentBeforeCacheUse) return { state: "stale" };

	let cached: CachedReplyRefinement | null;
	try {
		cached = await dependencies.getCached(cacheKey, cacheScope);
	} catch {
		return null;
	}
	if (!cached || cached.fingerprint !== snapshot.fingerprint) return null;

	let result: ReplyRefinementResult;
	try {
		result = parseReplyRefinementOutput(
			JSON.stringify({ body: cached.bodyText }),
		).result;
	} catch {
		return null;
	}

	const currentBeforeCacheLedger = await readCurrentSnapshot(
		dependencies,
		input,
		snapshot.fingerprint,
	);
	if (!currentBeforeCacheLedger) return { state: "stale" };
	await dependencies.beginUsage({
		feature: REPLY_REFINEMENT_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: REPLY_REFINEMENT_AI_CONFIG.requestedTier,
		estimatedCostMicros: REPLY_REFINEMENT_AI_CONFIG.estimatedCostMicros,
		cacheKey,
		cacheHit: true,
	});
	const currentBeforeResponse = await readCurrentSnapshot(
		dependencies,
		input,
		snapshot.fingerprint,
	);
	if (!currentBeforeResponse) return { state: "stale" };
	return {
		state: "cached",
		fingerprint: currentBeforeResponse.fingerprint,
		result,
	};
}

async function generateRefinement(
	dependencies: ReplyRefinementRuntimeDependencies,
	input: NormalizedRunInput,
	snapshot: ReplyRefinementSnapshot,
	cacheKey: string,
	cacheScope: string,
): Promise<ReplyRefinementRuntimeResponse> {
	const messages = buildReplyRefinementModelMessages({
		evidence: snapshot.evidence,
		request: input.request,
		writingPrompt: snapshot.writingPrompt,
		sourceEmailId: input.sourceEmailId,
		mailboxId: input.mailboxId,
	});
	const decision = await dependencies.beginUsage({
		feature: REPLY_REFINEMENT_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: REPLY_REFINEMENT_AI_CONFIG.requestedTier,
		estimatedCostMicros: REPLY_REFINEMENT_AI_CONFIG.estimatedCostMicros,
		cacheKey,
		cacheHit: false,
	});
	if (decision.decision === "block" || !decision.reservationId) {
		const current = await readCurrentSnapshot(
			dependencies,
			input,
			snapshot.fingerprint,
		);
		if (!current) return { state: "stale" };
		return {
			state: "budget_paused",
			reason: decision.reason ?? "inference_unavailable",
		};
	}

	let promptTokens = 0;
	let completionTokens = 0;
	let usageSettled = false;
	try {
		const currentBeforeProvider = await readCurrentSnapshot(
			dependencies,
			input,
			snapshot.fingerprint,
		);
		if (!currentBeforeProvider) {
			await dependencies.failUsage(decision.reservationId, {
				errorCode: "reply_refinement_snapshot_changed",
				promptTokens: 0,
				completionTokens: 0,
			});
			usageSettled = true;
			return { state: "stale" };
		}
		if (!(await dependencies.startUsage(decision.reservationId))) {
			throw new Error("AI usage reservation could not be started");
		}
		const currentAtProviderDispatch = await readCurrentSnapshot(
			dependencies,
			input,
			snapshot.fingerprint,
		);
		if (!currentAtProviderDispatch) {
			await dependencies.failUsage(decision.reservationId, {
				errorCode: "reply_refinement_snapshot_changed_before_dispatch",
				promptTokens: 0,
				completionTokens: 0,
			});
			usageSettled = true;
			return { state: "stale" };
		}

		const model = await dependencies.runModel(decision.model, messages);
		promptTokens = model.promptTokens;
		completionTokens = model.completionTokens;
		const parsed = parseReplyRefinementOutput(model.text);
		const actualCostMicros = calculateAiUsageCostMicros(decision.tier, {
			promptTokens,
			completionTokens,
		});
		await dependencies.completeUsage(decision.reservationId, {
			actualCostMicros:
				actualCostMicros || REPLY_REFINEMENT_AI_CONFIG.estimatedCostMicros,
			promptTokens,
			completionTokens,
		});
		usageSettled = true;

		const currentAfterInference = await readCurrentSnapshot(
			dependencies,
			input,
			snapshot.fingerprint,
		);
		if (!currentAfterInference) return { state: "stale" };
		const currentBeforeCacheWrite = await readCurrentSnapshot(
			dependencies,
			input,
			snapshot.fingerprint,
		);
		if (!currentBeforeCacheWrite) return { state: "stale" };

		let cached = false;
		try {
			await dependencies.putCached(cacheKey, cacheScope, {
				fingerprint: snapshot.fingerprint,
				bodyText: parsed.bodyText,
			});
			cached = true;
		} catch {
			// A cache outage does not turn a completed provider call into failure.
		}

		let currentBeforeResponse: ReplyRefinementSnapshot | null;
		try {
			currentBeforeResponse = await readCurrentSnapshot(
				dependencies,
				input,
				snapshot.fingerprint,
			);
		} catch (error) {
			if (cached) {
				await dependencies
					.deleteCached(cacheKey, cacheScope)
					.catch(() => undefined);
			}
			throw error;
		}
		if (!currentBeforeResponse) {
			if (cached) {
				await dependencies
					.deleteCached(cacheKey, cacheScope)
					.catch(() => undefined);
			}
			return { state: "stale" };
		}
		return {
			state: "generated",
			fingerprint: currentBeforeResponse.fingerprint,
			result: parsed.result,
		};
	} catch (error) {
		if (!usageSettled) {
			const actualCostMicros = calculateAiUsageCostMicros(decision.tier, {
				promptTokens,
				completionTokens,
			});
			await dependencies.failUsage(decision.reservationId, {
				errorCode:
					error instanceof Error &&
					error.name === "ReplyRefinementValidationError"
						? "invalid_reply_refinement_output"
						: "reply_refinement_failed",
				...(actualCostMicros > 0 ? { actualCostMicros } : {}),
				promptTokens,
				completionTokens,
			});
		}
		throw error;
	}
}

export async function runReplyRefinement(
	dependencies: ReplyRefinementRuntimeDependencies,
	rawInput: RunReplyRefinementInput,
): Promise<ReplyRefinementRuntimeResponse> {
	const input: NormalizedRunInput = {
		actorUserId: rawInput.actorUserId.trim(),
		mailboxId: rawInput.mailboxId.trim().toLowerCase(),
		sourceEmailId: normalizeReplyRefinementSourceEmailId(
			rawInput.sourceEmailId,
		),
		request: parseReplyRefinementRequest(rawInput.request),
	};
	await requireAccess(dependencies);
	const snapshot = await readSnapshot(dependencies, input);
	await requireAccess(dependencies);
	const cacheKey = await buildReplyRefinementCacheKey(
		snapshot.evidence,
		input.request,
		snapshot.writingPrompt,
		{
			environment: dependencies.environment,
			model: dependencies.model,
			actorUserId: input.actorUserId,
			mailboxId: input.mailboxId,
			sourceEmailId: input.sourceEmailId,
		},
	);
	const cacheScope = privateCacheScope(input.actorUserId, input.mailboxId);
	const cached = await tryCachedRefinement(
		dependencies,
		input,
		snapshot,
		cacheKey,
		cacheScope,
	);
	if (cached) return cached;
	return generateRefinement(
		dependencies,
		input,
		snapshot,
		cacheKey,
		cacheScope,
	);
}

type ReplyRefinementEvidenceStub = Parameters<
	typeof gatherConversationIntelligenceEvidence
>[0];

async function readMailboxWritingPrompt(
	env: Env,
	mailboxId: string,
): Promise<string> {
	const object = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!object) throw new ReplyRefinementWritingPromptUnavailableError();
	let settings: Record<string, unknown>;
	try {
		settings = await object.json<Record<string, unknown>>();
	} catch {
		throw new ReplyRefinementWritingPromptUnavailableError();
	}
	return normalizeReplyRefinementWritingPrompt(
		resolveAgentSystemPrompt(
			settings.agentSystemPrompt,
			resolveBrand(env.BRAND).id,
		),
	);
}

export function createReplyRefinementRuntime(
	env: Env,
	input: { stub: unknown; actorUserId: string; mailboxId: string },
): ReplyRefinementRuntimeDependencies {
	const config = resolveAiCostControlConfig(env);
	const cost = createAiCostController(env, config);
	return {
		environment: config.environment,
		model: config.cheapModel,
		canAccess: () =>
			mailboxAccess(env).canAccessMailbox(input.actorUserId, input.mailboxId),
		readEvidence: (sourceEmailId) =>
			gatherConversationIntelligenceEvidence(
				input.stub as ReplyRefinementEvidenceStub,
				env.BUCKET,
				sourceEmailId,
			),
		readWritingPrompt: () => readMailboxWritingPrompt(env, input.mailboxId),
		getCached: (cacheKey, cacheScope) =>
			getCachedAiResponse<CachedReplyRefinement>(env, {
				cacheKey,
				mailboxId: input.mailboxId,
				cacheScope,
			}),
		putCached: (cacheKey, cacheScope, value) =>
			putCachedAiResponse(env, {
				cacheKey,
				mailboxId: input.mailboxId,
				cacheScope,
				feature: REPLY_REFINEMENT_AI_CONFIG.feature,
				value,
				ttlMs: CACHE_TTL_MS,
			}),
		deleteCached: async (cacheKey, cacheScope) => {
			await env.DB.prepare(
				`DELETE FROM ai_response_cache
				 WHERE cache_key = ? AND environment = ? AND mailbox_scope = ?`,
			)
				.bind(cacheKey, config.environment, cacheScope)
				.run();
		},
		beginUsage: (usage) => cost.beginUsage(usage),
		startUsage: (reservationId) => cost.startUsage(reservationId),
		completeUsage: (reservationId, actual) =>
			cost.completeUsage(reservationId, actual),
		failUsage: (reservationId, failure) =>
			cost.failUsage(reservationId, failure),
		runModel: async (model, messages) => {
			const ai = env.AI as unknown as {
				run(model: string, input: Record<string, unknown>): Promise<unknown>;
			};
			const response = (await ai.run(model, {
				messages,
				max_tokens: REPLY_REFINEMENT_AI_CONFIG.maxTokens,
				temperature: REPLY_REFINEMENT_AI_CONFIG.temperature,
			})) as {
				response?: string;
				usage?: { prompt_tokens?: number; completion_tokens?: number };
			};
			return {
				text: (response.response ?? "").trim(),
				promptTokens: Math.max(
					0,
					Math.floor(response.usage?.prompt_tokens ?? 0),
				),
				completionTokens: Math.max(
					0,
					Math.floor(response.usage?.completion_tokens ?? 0),
				),
			};
		},
	};
}
