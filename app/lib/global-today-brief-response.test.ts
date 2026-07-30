import assert from "node:assert/strict";
import test from "node:test";
import { parseGlobalTodayBriefResponse } from "./global-today-brief-response.ts";

const generated = {
	state: "generated",
	fingerprint: `gtbf:v1:${"a".repeat(64)}`,
	generatedAt: "2026-07-12T10:00:00.000Z",
	counts: { privateRemindersDue: 1, unreadConversations: 2 },
	omittedCount: 0,
	items: [{
		candidate: {
			candidateId: "candidate-01",
			mailboxId: "team@example.com",
			mailboxAddress: "team@example.com",
			mailboxType: "SHARED",
			sourceMessageId: "message-1",
			subject: "Customer request",
			counterparty: "customer@example.com",
			reasons: ["unread_in_mailbox"],
		},
		whyNow: "The cited unread mail appears to contain a request.",
		suggestedNextStep: "Review the cited message.",
		sources: [{ mailboxId: "team@example.com", messageId: "message-1" }],
		requiresHumanReview: true,
	}],
};

test("aggregate Today brief validator accepts exact compound guidance and every non-guidance state", () => {
	assert.equal(parseGlobalTodayBriefResponse(generated).state, "generated");
	for (const value of [
		{ state: "overview_incomplete" },
		{ state: "no_attention", counts: generated.counts, omittedCount: 0 },
		{ state: "preparing", counts: generated.counts, omittedCount: 1 },
		{ state: "stale", counts: generated.counts, omittedCount: 1 },
		{ state: "budget_paused", reason: "admin_review_required", counts: generated.counts, omittedCount: 1 },
		{ state: "brief_unavailable", reason: "global_today_brief_failed:inferenceupstreamerror", counts: generated.counts, omittedCount: 1 },
		{ state: "brief_unavailable", reason: "invalid_global_today_brief_output:malformed_json" },
	]) assert.equal(parseGlobalTodayBriefResponse(value).state, value.state);
});

test("aggregate Today brief validator rejects leaked fields, cross-Mailbox citations, duplicates, and malformed opaque IDs", () => {
	assert.throws(() => parseGlobalTodayBriefResponse({ ...generated, leaked: "secret" }));
	assert.throws(() => parseGlobalTodayBriefResponse({ ...generated, items: [{ ...generated.items[0], sources: [{ mailboxId: "other@example.com", messageId: "message-1" }] }] }), /crosses Mailboxes/);
	assert.throws(() => parseGlobalTodayBriefResponse({ ...generated, items: [{ ...generated.items[0], sources: [generated.items[0].sources[0], generated.items[0].sources[0]] }] }), /must be unique/);
	assert.throws(() => parseGlobalTodayBriefResponse({ ...generated, items: [{ ...generated.items[0], candidate: { ...generated.items[0].candidate, candidateId: "real-message-id" } }] }));
	assert.throws(() => parseGlobalTodayBriefResponse({ ...generated, items: [{ ...generated.items[0], whyNow: "Arbitrary model prose" }] }));
});
