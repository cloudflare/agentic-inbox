import assert from "node:assert/strict";
import test from "node:test";
import {
	buildMailPaletteCommands,
	filterMailPaletteCommands,
	shouldOpenMailCommandPalette,
} from "./command-palette.ts";

test("palette includes core commands and context-valid triage", () => {
	const inbox = buildMailPaletteCommands({ folderId: "inbox", hasSelectedMessage: true });
	const ids = inbox.map((command) => command.id);
	assert.deepEqual(ids.slice(0, 13), [
		"global-today",
		"mailboxes",
		"compose",
		"search",
		"inbox",
		"sent",
		"drafts",
		"archive-folder",
		"trash-folder",
		"outbox",
		"refresh",
		"shortcuts",
		"toggle-read",
	]);
	assert.ok(ids.includes("archive-selected"));
	assert.ok(ids.includes("trash-selected"));

	const outbox = buildMailPaletteCommands({ folderId: "outbox", hasSelectedMessage: true });
	assert.ok(!outbox.some((command) => command.group === "Current conversation"));
	const noSelection = buildMailPaletteCommands({ folderId: "inbox", hasSelectedMessage: false });
	assert.ok(!noSelection.some((command) => command.group === "Current conversation"));
});

test("global palette exposes destinations without Mailbox-only actions", () => {
	const commands = buildMailPaletteCommands({
		hasMailboxContext: false,
		hasSelectedMessage: false,
		semanticSearchEnabled: true,
	});
	assert.deepEqual(commands.map((command) => command.id), [
		"global-today",
		"global-meaning",
		"mailboxes",
	]);
	assert.deepEqual(
		buildMailPaletteCommands({
			hasMailboxContext: false,
			hasSelectedMessage: false,
			semanticSearchEnabled: false,
		}).map((command) => command.id),
		["global-today", "mailboxes"],
	);
});

test("search ranks title matches and finds descriptions and aliases", () => {
	const commands = buildMailPaletteCommands({ folderId: "inbox", hasSelectedMessage: true });
	assert.equal(filterMailPaletteCommands(commands, "compose")[0]?.id, "compose");
	assert.equal(filterMailPaletteCommands(commands, "new message")[0]?.id, "compose");
	assert.equal(filterMailPaletteCommands(commands, "queued")[0]?.id, "outbox");
	assert.deepEqual(filterMailPaletteCommands(commands, "does-not-exist"), []);
});

test("Cmd/Ctrl+K never opens while typing, composing, or using unrelated modifiers", () => {
	const base = {
		key: "k",
		metaKey: true,
		ctrlKey: false,
		altKey: false,
		isComposing: false,
		isTextEntry: false,
	};
	assert.equal(shouldOpenMailCommandPalette(base), true);
	assert.equal(shouldOpenMailCommandPalette({ ...base, metaKey: false, ctrlKey: true }), true);
	assert.equal(shouldOpenMailCommandPalette({ ...base, isTextEntry: true }), false);
	assert.equal(shouldOpenMailCommandPalette({ ...base, isComposing: true }), false);
	assert.equal(shouldOpenMailCommandPalette({ ...base, altKey: true }), false);
	assert.equal(shouldOpenMailCommandPalette({ ...base, key: "j" }), false);
});

test("palette offers the star and snooze commands the list already handles", () => {
	const inbox = buildMailPaletteCommands({ folderId: "inbox", hasSelectedMessage: true });
	assert.ok(inbox.some((command) => command.id === "toggle-star"));
	assert.ok(inbox.some((command) => command.id === "snooze"));

	// Snoozed mail returns instead of snoozing again.
	const snoozed = buildMailPaletteCommands({ folderId: "snoozed", hasSelectedMessage: true });
	assert.ok(snoozed.some((command) => command.id === "unsnooze"));
	assert.ok(!snoozed.some((command) => command.id === "snooze"));

	// Sent mail can be starred but never snoozed; the Outbox stays action-free.
	const sent = buildMailPaletteCommands({ folderId: "sent", hasSelectedMessage: true });
	assert.ok(sent.some((command) => command.id === "toggle-star"));
	assert.ok(!sent.some((command) => command.id === "snooze"));
	const outbox = buildMailPaletteCommands({ folderId: "outbox", hasSelectedMessage: true });
	assert.ok(!outbox.some((command) => command.id === "toggle-star"));
});
