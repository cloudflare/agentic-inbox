import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

const watcher = read("./SendOutcomeWatcher.tsx");
const mailboxRoute = read("../routes/mailbox.tsx");
const store = read("../hooks/useUIStore.ts");
const composeForm = read("../hooks/useComposeForm.ts");
const queries = read("../queries/emails.ts");
const sidebar = read("./Sidebar.tsx");

test("the watcher is hosted where it outlives the composer that started the send", () => {
	assert.match(mailboxRoute, /<SendOutcomeWatcher \/>/);
	assert.match(
		mailboxRoute,
		/import SendOutcomeWatcher from "~\/components\/SendOutcomeWatcher"/,
	);
	assert.doesNotMatch(
		composeForm,
		/useOutboundDeliveries|SEND_OUTCOME_WATCH_MS/,
		"the composer must not own the poll or the cap it cannot survive",
	);
});

test("in-flight sends live in the store, not in composer state", () => {
	assert.match(store, /pendingSends: PendingSend\[\]/);
	assert.match(store, /trackSend: \(send: PendingSend\) => void/);
	assert.match(store, /resolveSend: \(deliveryId: string\) => void/);
	assert.match(store, /pendingSends: \[\],/);
	assert.match(
		store,
		/state\.pendingSends\.some\(\(held\) => held\.deliveryId === send\.deliveryId\)/,
		"re-tracking the same delivery must not raise a second toast",
	);
});

test("each in-flight send gets its own watcher keyed by delivery", () => {
	assert.match(
		watcher,
		/pendingSends\.map\(\(send\) => \(\s*<SendWatch key=\{send\.deliveryId\} send=\{send\} \/>/,
	);
});

test("the undo and its confirmation are owned by the surviving watcher", () => {
	assert.match(
		watcher,
		/const cancelOutbound = useCancelOutboundDelivery\(\)/,
		"the cancel mutation must belong to a component that stays mounted",
	);
	assert.match(
		watcher,
		/cancelOutbound\.mutate\([\s\S]*?onSuccess: \(\) =>\s*toastManager\.add\(\{ title: "Send cancelled" \}\)/,
	);
});

test("the watcher is released by its own toast closing, never before", () => {
	assert.match(watcher, /onClose: \(\) => resolveSend\(send\.deliveryId\)/);
});

test("one toast is resolved in place and the poll stops once settled", () => {
	assert.match(
		watcher,
		/toastManager\.update\(toastId, \{[\s\S]*?title: copy\.title[\s\S]*?timeout: copy\.timeout/,
	);
	assert.match(
		watcher,
		/useOutboundDeliveries\(\s*send\.mailboxId,\s*settled \? \[\] : \[send\.emailId\],\s*!settled,/,
	);
	assert.match(watcher, /outcome === "cancelled"[\s\S]*?toastManager\.close\(toastId\)/);
});

test("an unresolved send is capped and handed to the Outbox", () => {
	assert.match(
		watcher,
		/setTimeout\(\s*\(\) => settle\("timeout"\),[\s\S]*?SEND_OUTCOME_WATCH_MS/,
	);
	assert.match(watcher, /copy\.openOutbox[\s\S]*?Open Outbox/);
	assert.match(
		watcher,
		/navigate\(\s*`\/mailbox\/\$\{send\.mailboxId\}\/emails\/\$\{Folders\.OUTBOX\}`/,
	);
});

test("a scheduled send is announced without being polled", () => {
	assert.match(watcher, /useState\(Boolean\(send\.scheduledFor\)\)/);
});

test("Undo is withdrawn once the delivery leaves for the provider", () => {
	assert.match(
		watcher,
		/showsUndo && status && !canUndoSend\(status\)[\s\S]*?toastManager\.update\(toastId, \{ actions: undefined \}\)/,
	);
});

test("delivery polls stop on error and the sidebar poll stays slow", () => {
	const guarded = queries.match(
		/refetchInterval: \(query\) =>\s*resolveEmailListRefetchInterval\(\{/g,
	);
	assert.ok(
		guarded && guarded.length >= 3,
		"the email list, the send poll, and the attention poll must all stop on error",
	);
	assert.match(queries, /interval: enabled \? SEND_OUTCOME_POLL_MS : undefined/);
	assert.match(queries, /useOutboundAttentionCount[\s\S]*?interval: 60_000/);
});

test("failed deliveries are visible outside the Outbox as an attention badge", () => {
	assert.match(queries, /countDeliveriesNeedingAttention\(data\)/);
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
});
