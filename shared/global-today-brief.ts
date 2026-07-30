import {
	normalizeTodayBriefInput,
	type NormalizedTodayBriefInput,
	type TodayBriefCandidateInput,
	type TodayBriefCandidateReason,
} from "./today-brief.ts";

export const GLOBAL_TODAY_BRIEF_AI_CONFIG = {
	feature: "global_today_brief",
	requestedTier: "cheap",
	promptVersion: "global-today-brief-v1",
	sourceVersion: "global-today-brief-source-v1",
	estimatedCostMicros: 8_000,
	maxTokens: 1_000,
	temperature: 0,
} as const;

export type GlobalTodayBriefInput = {
	localDate: string;
	timezone: string;
	omittedCount: number;
	candidates: readonly TodayBriefCandidateInput[];
};

export type NormalizedGlobalTodayBriefInput = Pick<
	NormalizedTodayBriefInput,
	"version" | "localDate" | "timezone" | "omittedCount" | "candidates"
>;

export function normalizeGlobalTodayBriefInput(
	input: GlobalTodayBriefInput,
): NormalizedGlobalTodayBriefInput {
	const normalized = normalizeTodayBriefInput({
		actorUserId: "aggregate-actor",
		mailboxId: "aggregate",
		...input,
	});
	return {
		version: normalized.version,
		localDate: normalized.localDate,
		timezone: normalized.timezone,
		omittedCount: normalized.omittedCount,
		candidates: normalized.candidates,
	};
}

export type GlobalTodayBriefCounts = {
	privateRemindersDue: number;
	unreadConversations: number;
};

export type GlobalTodayBriefPublicCandidate = {
	candidateId: string;
	mailboxId: string;
	mailboxAddress: string;
	mailboxType: "PERSONAL" | "SHARED";
	sourceMessageId: string;
	subject: string;
	counterparty: string;
	reasons: TodayBriefCandidateReason[];
	remindAt?: string;
};

export type GlobalTodayBriefResponse =
	| {
			state: "cached" | "generated";
			fingerprint: string;
			generatedAt: string;
			counts: GlobalTodayBriefCounts;
			omittedCount: number;
			items: Array<{
				candidate: GlobalTodayBriefPublicCandidate;
				whyNow: string;
				suggestedNextStep: string;
				sources: Array<{ mailboxId: string; messageId: string }>;
				requiresHumanReview: true;
			}>;
	  }
	| { state: "no_attention"; counts: GlobalTodayBriefCounts; omittedCount: 0 }
	| { state: "overview_incomplete" }
	| { state: "preparing"; counts: GlobalTodayBriefCounts; omittedCount: number }
	| { state: "stale"; counts: GlobalTodayBriefCounts; omittedCount: number }
	| { state: "budget_paused"; reason: string; counts: GlobalTodayBriefCounts; omittedCount: number }
	// Generation failed. Today still renders its deterministic content, so counts
	// are carried whenever a snapshot was read before the failure.
	| {
			state: "brief_unavailable";
			reason: string;
			counts?: GlobalTodayBriefCounts;
			omittedCount?: number;
	  };
