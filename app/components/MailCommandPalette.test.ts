import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const palette = readFileSync(new URL("./MailCommandPalette.tsx", import.meta.url), "utf8");
const header = readFileSync(new URL("./Header.tsx", import.meta.url), "utf8");
const mailbox = readFileSync(new URL("../routes/mailbox.tsx", import.meta.url), "utf8");
const keyboardController = readFileSync(new URL("./MailKeyboardController.tsx", import.meta.url), "utf8");

test("palette is a searchable Kumo dialog with complete keyboard listbox semantics", () => {
	assert.match(palette, /<Dialog\.Root/);
	assert.match(palette, /role="combobox"/);
	assert.match(palette, /role="listbox"/);
	assert.match(palette, /role="option"/);
	assert.match(palette, /aria-activedescendant/);
	assert.match(palette, /ArrowDown/);
	assert.match(palette, /ArrowUp/);
	assert.match(palette, /Enter/);
	assert.match(palette, /Escape/);
	assert.match(palette, /previousFocusRef/);
});

test("palette uses the existing command bus and is mounted with an obvious header trigger", () => {
	assert.match(palette, /MAIL_COMMAND_EVENT/);
	assert.match(keyboardController, /addEventListener\(MAIL_COMMAND_EVENT/);
	assert.match(keyboardController, /MAIL_FOCUS_SEARCH_EVENT/);
	assert.match(header, /MAIL_COMMAND_PALETTE_OPEN_EVENT/);
	assert.match(header, />Commands</);
	assert.match(mailbox, /<MailCommandPalette/);
});

test("palette forwards the server-resolved Meaning feature gate into command construction", () => {
	assert.match(palette, /const \{ semanticSearchEnabled \} = useBrand\(\)/);
	assert.match(palette, /buildMailPaletteCommands\(\{[\s\S]*semanticSearchEnabled/);
	assert.match(palette, /\[folder, mailboxId, selectedEmailId, semanticSearchEnabled\]/);
});

test("palette leaves coarse-pointer search opt-in and provides initial close focus", () => {
	assert.doesNotMatch(palette, /\bautoFocus\b/);
	assert.match(palette, /matchMedia\("\(pointer: coarse\)"\)/);
	assert.match(palette, /aria-label="Close command palette"/);
});

test("the palette is reachable below xl and named in the shortcut guide", () => {
	// The dedicated trigger is xl-only, so the overflow menu carries it too.
	assert.match(
		header,
		/icon=\{CommandIcon\}[\s\S]*?MAIL_COMMAND_PALETTE_OPEN_EVENT[\s\S]*?Command palette/,
	);
	assert.match(keyboardController, /\["⌘K \/ Ctrl K", "Open the command palette"\]/);
});
