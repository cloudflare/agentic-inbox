import assert from "node:assert/strict";
import test from "node:test";
import {
	isMailShortcutProtectedTarget,
	resolveMailShortcut,
	resolveVisibleMailTargetId,
	TEXT_ENTRY_SELECTOR,
} from "./mail-keyboard.ts";

function shortcut(
	key: string,
	overrides: Partial<Parameters<typeof resolveMailShortcut>[0]> = {},
) {
	return resolveMailShortcut({
		key,
		isTextEntry: false,
		isComposing: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		...overrides,
	});
}

test("maps primary mail navigation and triage shortcuts", () => {
	assert.deepEqual(shortcut("j"), { command: "next-message" });
	assert.deepEqual(shortcut("k"), { command: "previous-message" });
	assert.deepEqual(shortcut("Enter"), { command: "open-message" });
	assert.deepEqual(shortcut("Escape"), { command: "close-surface" });
	assert.deepEqual(shortcut("c"), { command: "compose" });
	assert.deepEqual(shortcut("/"), { command: "focus-search" });
	assert.deepEqual(shortcut("r"), { command: "reply" });
	assert.deepEqual(shortcut("e"), { command: "archive" });
	assert.deepEqual(shortcut("#"), { command: "trash" });
	assert.deepEqual(shortcut("u"), { command: "toggle-unread" });
	assert.deepEqual(shortcut("s"), { command: "toggle-star" });
	assert.deepEqual(shortcut("z"), { command: "snooze" });
	assert.deepEqual(shortcut("?"), { command: "show-shortcuts" });
});

test("supports g-prefixed folder navigation", () => {
	assert.deepEqual(shortcut("g"), { nextPrefix: "g" });
	assert.deepEqual(shortcut("i", { pendingPrefix: "g" }), {
		command: "go-inbox",
	});
	assert.deepEqual(shortcut("s", { pendingPrefix: "g" }), {
		command: "go-sent",
	});
	assert.deepEqual(shortcut("d", { pendingPrefix: "g" }), {
		command: "go-drafts",
	});
	assert.deepEqual(shortcut("a", { pendingPrefix: "g" }), {
		command: "go-archive",
	});
	assert.deepEqual(shortcut("x", { pendingPrefix: "g" }), {});
});

test("never hijacks text entry, IME composition, or modified browser keys", () => {
	assert.deepEqual(shortcut("c", { isTextEntry: true }), {});
	assert.deepEqual(shortcut("j", { isComposing: true }), {});
	assert.deepEqual(shortcut("r", { ctrlKey: true }), {});
	assert.deepEqual(shortcut("s", { metaKey: true }), {});
	assert.deepEqual(shortcut("ArrowLeft", { altKey: true }), {});
	assert.deepEqual(shortcut("Escape", { isTextEntry: true }), {});
});

test("only genuine text entry is shielded from shortcuts", () => {
	for (const entry of [
		"input:not([type='checkbox']):not([type='radio'])",
		"textarea",
		"select",
		"[contenteditable]:not([contenteditable='false'])",
		"[role='textbox']",
	]) {
		assert.ok(
			TEXT_ENTRY_SELECTOR.includes(entry),
			`text entry target ${entry} must stay protected`,
		);
	}
});

test("focusable mail chrome never blocks shortcuts or the command palette", () => {
	// Conversation rows are buttons and the select control is a checkbox, so any
	// of these tokens in the selector silently disables every shortcut and Cmd+K.
	for (const chrome of [
		"button",
		"a[href]",
		"summary",
		"[role='button']",
		"[role='menuitem']",
	]) {
		assert.ok(
			!TEXT_ENTRY_SELECTOR.includes(chrome),
			`${chrome} must not be treated as text entry`,
		);
	}
});

test("the protected-target check reads the element tree, not the event", () => {
	// Node has no DOM: stand in a tag-name element so the real predicate runs
	// against the real selector. Focus behaviour itself is covered by Playwright.
	class StubElement {
		tag: string;
		constructor(tag: string) {
			this.tag = tag;
		}
		closest(selector: string) {
			return selector.split(", ").some((part) => part.startsWith(this.tag))
				? this
				: null;
		}
	}
	(globalThis as { Element?: unknown }).Element = StubElement;
	const target = (tag: string) => new StubElement(tag) as unknown as EventTarget;

	assert.equal(isMailShortcutProtectedTarget(target("input")), true);
	assert.equal(isMailShortcutProtectedTarget(target("textarea")), true);
	assert.equal(isMailShortcutProtectedTarget(target("button")), false);
	assert.equal(isMailShortcutProtectedTarget(target("a")), false);
	assert.equal(isMailShortcutProtectedTarget(null), false);
});

test("current-conversation commands never fall back to an unrelated first row", () => {
	const visibleIds = ["first", "selected"];
	assert.equal(
		resolveVisibleMailTargetId(visibleIds, "selected", false),
		"selected",
	);
	assert.equal(resolveVisibleMailTargetId(visibleIds, null, false), null);
	assert.equal(resolveVisibleMailTargetId(visibleIds, "stale", false), null);
	assert.equal(resolveVisibleMailTargetId(visibleIds, null, true), "first");
	assert.equal(resolveVisibleMailTargetId(visibleIds, "stale", true), "first");
});
