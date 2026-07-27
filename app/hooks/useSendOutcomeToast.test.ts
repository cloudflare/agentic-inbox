import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

const hook = read("./useSendOutcomeToast.ts");
const queries = read("../queries/emails.ts");
const sidebar = read("../components/Sidebar.tsx");

test("one send toast is resolved in place rather than replaced by a second toast", () => {
	assert.match(hook, /const toastId = toastManager\.add\(\{/);
	assert.match(
		hook,
		/const copy = sendOutcomeToast\(outcome\)[\s\S]*?toastManager\.update\(watch\.toastId, \{[\s\S]*?title: copy\.title[\s\S]*?timeout: copy\.timeout/,
	);
});

test("a cancelled send closes its toast instead of claiming an outcome", () => {
	assert.match(
		hook,
		/outcome === "cancelled"[\s\S]*?toastManager\.close\(watch\.toastId\)/,
	);
});

test("an unresolved send is capped and handed to the Outbox", () => {
	assert.match(
		hook,
		/setTimeout\(\s*\(\) => settle\("timeout"\),[\s\S]*?SEND_OUTCOME_WATCH_MS/,
	);
	assert.match(
		hook,
		/copy\.openOutbox \? \[outboxAction\]/,
		"a failed or stalled send must offer the Outbox as recovery",
	);
	assert.match(hook, /navigate\(`\/mailbox\/\$\{mailboxId\}\/emails\/\$\{Folders\.OUTBOX\}`\)/);
});

test("the outcome poll is scoped to the send in flight and stops once it settles", () => {
	assert.match(
		hook,
		/useOutboundDeliveries\(\s*mailboxId,\s*watch \? \[watch\.emailId\] : \[\],\s*Boolean\(watch\),/,
		"the poll runs from any folder but only while a send is in flight",
	);
	assert.match(hook, /if \(outcome !== "pending"\) \{\s*settle\(outcome\);\s*return;/);
});

test("Undo is withdrawn once the delivery leaves for the provider", () => {
	assert.match(
		hook,
		/watch\.showsUndo && watchedStatus && !canUndoSend\(watchedStatus\)[\s\S]*?toastManager\.update\(watch\.toastId, \{ actions: undefined \}\)/,
	);
});

test("a scheduled send is announced and not watched for a delivery outcome", () => {
	assert.match(hook, /if \(scheduledFor\) return;\s*setWatch\(/);
});

test("delivery polls stop backing off nothing and stop on error", () => {
	const intervals = queries.match(
		/refetchInterval: \(query\) =>\s*resolveEmailListRefetchInterval\(\{/g,
	);
	assert.ok(
		intervals && intervals.length >= 3,
		"the email list, the send poll, and the attention poll must all stop on error",
	);
	assert.match(queries, /interval: enabled \? SEND_OUTCOME_POLL_MS : undefined/);
});

test("failed deliveries are visible outside the Outbox as an attention badge", () => {
	assert.match(queries, /countDeliveriesNeedingAttention\(data\)/);
	assert.match(sidebar, /const outboundAttentionCount = useOutboundAttentionCount\(mailboxId\)/);
	assert.match(
		sidebar,
		/attentionCount=\{\s*folder\.id === Folders\.OUTBOX \? outboundAttentionCount : 0\s*\}/,
	);
	assert.match(
		sidebar,
		/attentionCount != null && attentionCount > 0 \? \(\s*<Badge variant="destructive">/,
		"attention must not read as an unread count",
	);
	assert.match(sidebar, /<span className="sr-only"> deliveries need attention<\/span>/);
	assert.match(
		queries,
		/useOutboundAttentionCount[\s\S]*?interval: 60_000/,
		"the sidebar must not poll at send-watch cadence",
	);
});
