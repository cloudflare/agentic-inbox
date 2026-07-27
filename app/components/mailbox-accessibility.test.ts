import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const list = read("../routes/email-list.tsx");
const search = read("../routes/search-results.tsx");
const savedView = read("../routes/saved-view-results.tsx");
const row = read("./EmailRow.tsx");
const split = read("./MailboxSplitView.tsx");
const keyboard = read("./MailKeyboardController.tsx");
const outbox = read("./OutboundDeliveryActions.tsx");
const compose = read("./ComposeEmail.tsx");
const attachments = read("./ComposeAttachments.tsx");
const editor = read("./RichTextEditor.tsx");
const css = read("../index.css");

test("mail rows use a semantic list and a dedicated open button", () => {
	assert.match(row, /role="listitem"/);
	assert.match(row, /aria-label=\{`Open conversation/);
	assert.match(row, /focus-visible:ring-2/);
	// The row stays a listitem wrapping a real button, never a div pretending
	// to be one - that is what gives Enter and Space for free.
	assert.doesNotMatch(row, /role="button"/);
	assert.doesNotMatch(row, /tabIndex=\{0\}/);
});

test("every conversation surface exposes its rows as a named list", () => {
	for (const [surface, source] of [
		["folder list", list],
		["search results", search],
		["saved view results", savedView],
	] as const) {
		assert.match(source, /role="list"/, `${surface} needs list semantics`);
		assert.match(source, /<EmailRow/, `${surface} must use the shared row`);
	}
});

test("secondary row controls leave one tab stop per conversation", () => {
	// Star and the action cluster are reachable by shortcut, not by tabbing
	// through every row; the open control is the single stop.
	assert.match(list, /tabIndex=\{-1\}/);
});

test("split view and shortcut guide expose named bounded regions", () => {
	assert.match(split, /aria-label="Message list"/);
	assert.match(split, /aria-label="Conversation"/);
	assert.match(split, /min-h-0/);
	assert.match(keyboard, /max-h-\[calc\(100dvh-1rem\)\]/);
	assert.match(keyboard, /overflow-y-auto/);
	assert.match(keyboard, /<Dialog\.Close[\s\S]*aria-label="Close keyboard shortcuts"/);
});

test("outbox and composer expose live errors, touch targets, and named editors", () => {
	assert.match(outbox, /role="status"/);
	assert.match(outbox, /min-h-11/);
	assert.match(compose, /role="alert"/);
	assert.match(compose, /aria-live="polite"/);
	assert.match(compose, /100dvh/);
	assert.match(attachments, /aria-label="Choose files to attach"/);
	assert.match(attachments, /motion-reduce:animate-none/);
	assert.match(editor, /"aria-label": "Message body"/);
	assert.match(editor, /role="toolbar"/);
});

test("global reduced-motion fallback disables nonessential movement", () => {
	assert.match(css, /prefers-reduced-motion:\s*reduce/);
	assert.match(css, /scroll-behavior:\s*auto/);
});
