import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./EmailPanel.tsx", import.meta.url), "utf8");
const threadMessage = readFileSync(
	new URL("./email-panel/ThreadMessage.tsx", import.meta.url),
	"utf8",
);

test("opening a cited message expands, scrolls, and focuses that exact source", () => {
	assert.match(panel, /pendingMessageFocusRef\.current = currentEmailId/);
	assert.match(panel, /setExpandedMessages\(new Set\(\[currentEmailId\]\)\)/);
	assert.match(panel, /dataset\.intelligenceMessageId === pendingId/);
	assert.match(panel, /target\.scrollIntoView\(\{ block: "start" \}\)/);
	assert.match(panel, /target\.focus\(\{ preventScroll: true \}\)/);
	assert.match(panel, /onFocusMessage=\{focusMessage\}/);
});

test("every message exposes one focusable labeled anchor", () => {
	assert.equal(
		(threadMessage.match(/data-intelligence-message-id=\{email\.id\}/g) ?? [])
			.length,
		2,
		"one anchor for the collapsed view, one for the expanded view",
	);
	assert.match(threadMessage, /aria-label=\{`Message from \$\{senderLabel\}/);
	assert.match(
		threadMessage,
		/data-intelligence-message-id=\{email\.id\}[\s\S]*?tabIndex=\{-1\}/,
	);
	// Every conversation, single-message or not, renders through that one anchor:
	// the panel only ever queries for them, never emits a competing one.
	assert.doesNotMatch(panel, /data-intelligence-message-id=/);
	assert.match(panel, /querySelectorAll<HTMLElement>\("\[data-intelligence-message-id\]"\)/);
	assert.match(panel, /isSoleMessage=\{!hasThread\}/);
});
