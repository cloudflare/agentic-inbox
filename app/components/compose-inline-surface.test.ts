import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const compose = readFileSync(
	new URL("./ComposeEmail.tsx", import.meta.url),
	"utf8",
);
const editor = readFileSync(
	new URL("./RichTextEditor.tsx", import.meta.url),
	"utf8",
);

test("both surfaces render the one compose form", () => {
	// A single <form> means one useComposeForm owner, whichever chrome is mounted.
	assert.equal((compose.match(/<form\b/g) ?? []).length, 1);
	assert.equal((compose.match(/<ComposeChrome\b/g) ?? []).length, 1);
	assert.match(compose, /variant=\{variant\}/);
});

test("the inline chrome never covers the thread it answers", () => {
	assert.match(
		compose,
		/if \(variant === "inline" && inlineHost\) \{[\s\S]*?createPortal\([\s\S]*?<section[\s\S]*?ref=\{surfaceRef\}[\s\S]*?\{header\}[\s\S]*?\{children\}[\s\S]*?inlineHost,/,
	);
	// No thread to live in means the modal, never a composer rendered nowhere.
	assert.match(compose, /const isInline = wantsInline && inlineHost !== null/);
	// Only the modal chrome wraps the form in a dialog.
	assert.match(
		compose,
		/return \([\s\S]*?<Dialog\.Root[\s\S]*?open=\{open\}[\s\S]*?\{header\}[\s\S]*?\{children\}/,
	);
	assert.match(compose, /inlineSurfaceRef\.current\?\.scrollIntoView\(\{ block: "start" \}\)/);
});

test("the inline card grows with its content instead of scrolling inside itself", () => {
	assert.match(
		compose,
		/isInline \? "" : "flex-1 min-h-0 overflow-y-auto"/,
	);
	assert.match(
		compose,
		/isInline[\s\S]*?"flex min-h-\[220px\] flex-col"[\s\S]*?"h-\[38dvh\] min-h-\[220px\] sm:h-\[42vh\] sm:min-h-\[280px\]"/,
	);
});

test("escape closes the inline composer through the same guarded close", () => {
	assert.match(
		compose,
		/handleInlineKeyDown = \(event: ReactKeyboardEvent<HTMLElement>\) => \{[\s\S]*?event\.key !== "Escape" \|\| event\.defaultPrevented[\s\S]*?void requestClose\(\)/,
	);
	assert.match(compose, /onKeyDown=\{handleInlineKeyDown\}/);
});

test("replies open in the message body, everything else at the recipient", () => {
	assert.match(
		compose,
		/focusesBody =\s*composeOptions\.mode === "reply" \|\| composeOptions\.mode === "reply-all"/,
	);
	assert.match(compose, /autoFocus=\{!focusesBody\}/);
	assert.match(compose, /autoFocus=\{focusesBody\}/);
	// "start" keeps the caret above the quoted original.
	assert.match(editor, /autofocus: autoFocus \? "start" : false/);
});

test("the writing assistant stays open for an AI-drafted reply", () => {
	assert.match(compose, /isReplyCompose =\s*!composeOptions\.draftEmail\?\.id/);
});
