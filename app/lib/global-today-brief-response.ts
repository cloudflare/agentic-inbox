import { z } from "zod";
import type { GlobalTodayBriefResponse } from "../../shared/global-today-brief.ts";

const counts = z.object({
	privateRemindersDue: z.number().int().nonnegative(),
	unreadConversations: z.number().int().nonnegative(),
}).strict();
const transient = {
	counts,
	omittedCount: z.number().int().nonnegative(),
};
const source = z.object({
	mailboxId: z.string().email().max(320),
	messageId: z.string().min(1).max(300),
}).strict();
const candidate = z.object({
	candidateId: z.string().regex(/^candidate-\d{2}$/u),
	mailboxId: z.string().email().max(320),
	mailboxAddress: z.string().email().max(320),
	mailboxType: z.enum(["PERSONAL", "SHARED"]),
	sourceMessageId: z.string().min(1).max(300),
	subject: z.string().max(1_000),
	counterparty: z.string().max(640),
	reasons: z.array(z.enum(["overdue_reminder", "today_reminder", "unread_in_mailbox"])).min(1).max(2),
	remindAt: z.string().datetime({ offset: true }).optional(),
}).strict();
const whyNow = z.enum([
	"A private follow-up is overdue.",
	"A private follow-up is due today.",
	"The cited unread mail appears to contain a request.",
	"The cited unread mail appears to contain a question.",
	"The cited mail appears time-sensitive.",
	"The cited unread mail contains new information to review.",
	"The cited conversation may need review.",
]);
const suggestedNextStep = z.enum([
	"Review the cited message.",
	"Review the cited message and prepare a reply if needed.",
	"Review the cited message and decide whether to follow up.",
	"Review the cited message and decide whether to schedule time.",
	"Review the cited message and decide whether any action is needed.",
]);
const generated = z.object({
	state: z.enum(["cached", "generated"]),
	fingerprint: z.string().regex(/^gtbf:v1:[a-f0-9]{64}$/u),
	generatedAt: z.string().datetime({ offset: true }),
	...transient,
	items: z.array(z.object({
		candidate,
		whyNow,
		suggestedNextStep,
		sources: z.array(source).min(1).max(4),
		requiresHumanReview: z.literal(true),
	}).strict()).min(1).max(5),
}).strict().superRefine((value, context) => {
	const candidates = value.items.map((item) => item.candidate.candidateId);
	if (new Set(candidates).size !== candidates.length) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "Aggregate Today candidates must be unique" });
	}
	for (const item of value.items) {
		if (item.candidate.mailboxId !== item.candidate.mailboxAddress) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Aggregate Today Mailbox identity is inconsistent" });
		}
		if (item.sources.some((citation) => citation.mailboxId !== item.candidate.mailboxId)) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Aggregate Today citation crosses Mailboxes" });
		}
		const coordinates = item.sources.map((citation) => `${citation.mailboxId}\n${citation.messageId}`);
		if (new Set(coordinates).size !== coordinates.length) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Aggregate Today citations must be unique" });
		}
	}
});
const responseSchema = z.union([
	generated,
	z.object({ state: z.literal("no_attention"), counts, omittedCount: z.literal(0) }).strict(),
	z.object({ state: z.literal("overview_incomplete") }).strict(),
	z.object({ state: z.literal("preparing"), ...transient }).strict(),
	z.object({ state: z.literal("stale"), ...transient }).strict(),
	z.object({ state: z.literal("budget_paused"), reason: z.string().min(1).max(100), ...transient }).strict(),
	// Counts are absent when the brief failed before a snapshot was read.
	z.object({
		state: z.literal("brief_unavailable"),
		reason: z.string().min(1).max(100),
		counts: counts.optional(),
		omittedCount: z.number().int().nonnegative().optional(),
	}).strict(),
]);

export function parseGlobalTodayBriefResponse(value: unknown): GlobalTodayBriefResponse {
	return responseSchema.parse(value) as GlobalTodayBriefResponse;
}
