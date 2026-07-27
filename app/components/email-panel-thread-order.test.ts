import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./EmailPanel.tsx", import.meta.url), "utf8");
const threadMessage = readFileSync(
	new URL("./email-panel/ThreadMessage.tsx", import.meta.url),
	"utf8",
);

test("a thread reads oldest first, like a chat", () => {
	assert.match(
		panel,
		/allMessages = useMemo\([\s\S]*?sort\(\(a, b\) => new Date\(a\.date\)\.getTime\(\) - new Date\(b\.date\)\.getTime\(\)\)/,
	);
	assert.match(panel, /const newestMessageId = allMessages\.at\(-1\)\?\.id/);
});

test("the opened message and the newest message start expanded", () => {
	assert.match(panel, /setExpandedMessages\(new Set\(\[currentEmailId\]\)\)/);
	assert.match(
		panel,
		/seededSelectionRef\.current = currentEmailId;[\s\S]*?setExpandedMessages\(\(current\) => new Set\(current\)\.add\(newestMessageId\)\)/,
	);
	// A later reply must not re-collapse what the reader already opened.
	assert.match(
		panel,
		/if \(seededSelectionRef\.current === currentEmailId\) return/,
	);
});

test("reply targets the latest received message under the oldest-first order", () => {
	assert.match(panel, /if \(received\.length > 0\) return received\.at\(-1\)/);
	assert.match(panel, /return nonDrafts\.at\(-1\) \?\? email/);
});

test("self detection compares normalized addresses on both sides", () => {
	assert.match(
		panel,
		/normalizedAddress\(currentMailbox\?\.email \?\? mailboxId \?\? ""\)/,
	);
	assert.match(
		panel,
		/normalizedAddress\(msg\.sender\) !== selfAddress/,
	);
	assert.match(
		threadMessage,
		/normalizedMailbox !== ""[\s\S]*?normalizedAddress\(email\.sender\) === normalizedMailbox/,
	);
	assert.doesNotMatch(threadMessage, /email\.sender === mailboxEmail/);
});

test("closing the inline composer returns focus to the thread", () => {
	// The hand-back must be queued before the effect that moves focus, and that
	// effect must re-run when the composer closes, or focus is left on nothing.
	assert.match(
		panel,
		/wasInlineComposingRef\.current && !isInlineComposing && newestMessageId\)[\s\S]*?pendingMessageFocusRef\.current = newestMessageId/,
	);
	const handBack = panel.indexOf("wasInlineComposingRef.current = isInlineComposing");
	const focusMove = panel.indexOf("target.focus({ preventScroll: true })");
	assert.ok(
		handBack < focusMove,
		"the focus hand-back effect must be declared before the focus effect",
	);
	assert.match(
		panel,
		/threadRepliesFetched, isInlineComposing\]/,
	);
});
