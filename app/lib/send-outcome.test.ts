import assert from "node:assert/strict";
import test from "node:test";

import {
	canUndoSend,
	countDeliveriesNeedingAttention,
	deliveryNeedsAttention,
	resolveSendOutcome,
	SEND_OUTCOME_POLL_MS,
	SEND_OUTCOME_WATCH_MS,
	sendOutcomeToast,
	sendPendingToast,
} from "./send-outcome.ts";

test("the watch outlives the undo window and polls fast enough to feel live", () => {
	assert.equal(SEND_OUTCOME_POLL_MS, 2_000);
	assert.ok(
		SEND_OUTCOME_WATCH_MS > 10_000,
		"the watch must survive the undo window that precedes dispatch",
	);
});

test("an accepted delivery stays pending until the provider answers", () => {
	for (const status of ["queued", "sending", "retrying"] as const) {
		assert.equal(
			resolveSendOutcome({ status, elapsedMs: 5_000 }),
			"pending",
			status,
		);
	}
	assert.equal(
		resolveSendOutcome({ status: undefined, elapsedMs: 0 }),
		"pending",
	);
});

test("provider acceptance resolves the send as sent", () => {
	assert.equal(resolveSendOutcome({ status: "sent", elapsedMs: 12_000 }), "sent");
});

test("failure states resolve so the outcome is never left implied", () => {
	assert.equal(resolveSendOutcome({ status: "failed", elapsedMs: 12_000 }), "failed");
	assert.equal(resolveSendOutcome({ status: "bounced", elapsedMs: 12_000 }), "failed");
	assert.equal(
		resolveSendOutcome({ status: "unknown", elapsedMs: 12_000 }),
		"unclear",
		"an unknown provider outcome must not be reported as a clean failure",
	);
	assert.equal(
		resolveSendOutcome({ status: "cancelled", elapsedMs: 3_000 }),
		"cancelled",
	);
});

test("a send with no terminal state inside the watch window times out", () => {
	assert.equal(
		resolveSendOutcome({ status: "queued", elapsedMs: SEND_OUTCOME_WATCH_MS - 1 }),
		"pending",
	);
	assert.equal(
		resolveSendOutcome({ status: "queued", elapsedMs: SEND_OUTCOME_WATCH_MS }),
		"timeout",
	);
	assert.equal(
		resolveSendOutcome({ status: undefined, elapsedMs: SEND_OUTCOME_WATCH_MS }),
		"timeout",
	);
});

test("undo is offered only before the delivery leaves for the provider", () => {
	assert.equal(canUndoSend("queued"), true);
	assert.equal(canUndoSend("retrying"), true);
	assert.equal(canUndoSend("sending"), false);
	assert.equal(canUndoSend("sent"), false);
	assert.equal(canUndoSend(undefined), false);
});

test("send copy is specific and never describes a queue", () => {
	assert.equal(sendPendingToast().title, "Sending…");
	assert.equal(sendPendingToast().timeout, 0, "pending must outlive the undo window");
	assert.equal(sendOutcomeToast("sent").title, "Sent");
	assert.match(sendOutcomeToast("failed").title, /^Couldn't send/);
	assert.match(sendOutcomeToast("unclear").title, /^Send status unclear/);
	assert.match(sendOutcomeToast("timeout").title, /^Still sending/);
	for (const copy of [
		sendPendingToast(),
		sendOutcomeToast("sent"),
		sendOutcomeToast("failed"),
		sendOutcomeToast("unclear"),
		sendOutcomeToast("timeout"),
	]) {
		assert.doesNotMatch(copy.title, /queue/i);
		assert.doesNotMatch(copy.title, /!/);
	}
});

test("unresolved outcomes stay open and route the user to recovery", () => {
	for (const outcome of ["failed", "unclear"] as const) {
		assert.equal(sendOutcomeToast(outcome).timeout, 0, outcome);
		assert.equal(sendOutcomeToast(outcome).openOutbox, true, outcome);
		assert.equal(sendOutcomeToast(outcome).variant, "error", outcome);
	}
	assert.equal(sendOutcomeToast("timeout").openOutbox, true);
	assert.ok(sendOutcomeToast("timeout").timeout > 0);
	assert.equal(sendOutcomeToast("sent").openOutbox, false);
	assert.ok(sendOutcomeToast("sent").timeout > 0);
});

test("a scheduled send is announced with its time and settles immediately", () => {
	const copy = sendPendingToast("2026-07-28T12:30:00.000Z");
	assert.match(copy.title, /^Scheduled for /);
	assert.ok(copy.timeout > 0, "a scheduled send has nothing left to watch");
	assert.equal(copy.openOutbox, false);
});

test("only deliveries the user must act on are counted for attention", () => {
	assert.equal(deliveryNeedsAttention("failed"), true);
	assert.equal(deliveryNeedsAttention("bounced"), true);
	assert.equal(deliveryNeedsAttention("unknown"), true);
	for (const status of ["queued", "sending", "retrying", "sent", "cancelled"] as const) {
		assert.equal(deliveryNeedsAttention(status), false, status);
	}
	assert.equal(
		countDeliveriesNeedingAttention([
			{ status: "sent" },
			{ status: "failed" },
			{ status: "queued" },
			{ status: "bounced" },
		]),
		2,
	);
	assert.equal(countDeliveriesNeedingAttention([]), 0);
});
