import assert from "node:assert/strict";
import test from "node:test";
import { planComposeEnqueueResult } from "./outbound-enqueue-outcome.ts";

test("Undo then reopen then Send creates a new draft revision before a new delivery", () => {
	assert.deepEqual(
		planComposeEnqueueResult({
			outcome: "terminal_replay",
			status: "cancelled",
		}),
		{ action: "renew_revision_and_resend" },
	);
});

test("a definitive failed replay renews safely but an unknown replay remains blocked", () => {
	assert.deepEqual(
		planComposeEnqueueResult({
			outcome: "terminal_replay",
			status: "failed",
		}),
		{ action: "renew_revision_and_resend" },
	);
	assert.deepEqual(
		planComposeEnqueueResult({
			outcome: "terminal_replay",
			status: "unknown",
		}),
		{
			action: "block",
			message:
				"An earlier send has an unknown outcome. Review it in Outbox before explicitly retrying the duplicate risk.",
		},
	);
});

test("active replays are truthful success while sent or bounced terminal replays stay open", () => {
	assert.deepEqual(
		planComposeEnqueueResult({ outcome: "active_replay", status: "retrying" }),
		{ action: "finish", title: "This email is already retrying", canUndo: true },
	);
	assert.deepEqual(
		planComposeEnqueueResult({ outcome: "terminal_replay", status: "sent" }),
		{
			action: "block",
			message: "This draft revision was already sent. It was not sent again.",
		},
	);
	assert.deepEqual(
		planComposeEnqueueResult({ outcome: "terminal_replay", status: "bounced" }),
		{
			action: "block",
			message:
				"This draft revision already produced a bounced delivery. Review it before sending again.",
		},
	);
});

test("only queued or retrying deliveries can offer Undo", () => {
	assert.deepEqual(
		planComposeEnqueueResult({ outcome: "enqueued", status: "queued" }),
		{ action: "finish", canUndo: true },
	);
	assert.deepEqual(
		planComposeEnqueueResult({ outcome: "active_replay", status: "sending" }),
		{ action: "finish", title: "This email is already sending", canUndo: false },
	);
});

test("replay copy never describes a queue the user cannot see", () => {
	for (const status of ["queued", "sending", "retrying", "sent"] as const) {
		const plan = planComposeEnqueueResult({
			outcome: status === "sent" ? "terminal_replay" : "active_replay",
			status,
		});
		assert.doesNotMatch(JSON.stringify(plan), /queue/i, status);
	}
});
