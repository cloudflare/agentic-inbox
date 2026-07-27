import assert from "node:assert/strict";
import test from "node:test";
import {
	activatesFocusedControl,
	isMailShortcutProtectedTarget,
	MODAL_SURFACE_SELECTOR,
	resolveMailShortcut,
	resolveVisibleMailTargetId,
	TEXT_ENTRY_SELECTOR,
} from "./mail-keyboard.ts";

// Node has no DOM: stand in a tag-name element carrying an optional ancestor
// role, so the real predicate runs against the real selectors. Focus behaviour
// itself is covered by Playwright.
class StubElement {
	tag: string;
	ancestorRole?: string;
	insideRow: boolean;
	constructor(tag: string, ancestorRole?: string, insideRow = false) {
		this.tag = tag;
		this.ancestorRole = ancestorRole;
		this.insideRow = insideRow;
	}
	closest(selector: string) {
		const parts = selector.split(", ").map((part) => part.trim());
		if (parts.includes("[data-email-id]")) return this.insideRow ? this : null;
		if (parts.some((part) => part.startsWith(this.tag))) return this;
		if (this.ancestorRole && parts.includes(`[role="${this.ancestorRole}"]`)) {
			return this;
		}
		return null;
	}
}
(globalThis as { Element?: unknown }).Element = StubElement;
const target = (tag: string, ancestorRole?: string) =>
	new StubElement(tag, ancestorRole) as unknown as EventTarget;
const rowTarget = (tag: string) =>
	new StubElement(tag, undefined, true) as unknown as EventTarget;

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
	assert.equal(isMailShortcutProtectedTarget(target("input")), true);
	assert.equal(isMailShortcutProtectedTarget(target("textarea")), true);
	assert.equal(isMailShortcutProtectedTarget(target("button")), false);
	assert.equal(isMailShortcutProtectedTarget(target("a")), false);
	assert.equal(isMailShortcutProtectedTarget(null), false);
});

test("an open dialog owns the keyboard, so triage never lands behind it", () => {
	// The Snooze dialog puts focus on its own buttons; e must not archive the
	// conversation still sitting in the list behind it.
	assert.equal(isMailShortcutProtectedTarget(target("button", "dialog")), true);
	assert.equal(
		isMailShortcutProtectedTarget(target("button", "alertdialog")),
		true,
	);
	// A mail row is a button too, and it must keep every shortcut working.
	assert.equal(isMailShortcutProtectedTarget(target("button")), false);
	assert.equal(
		MODAL_SURFACE_SELECTOR.includes('[role="dialog"]'),
		true,
		"Base UI Dialog emits role=dialog; aria-modal is never set",
	);
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

test("Enter on a focused control runs that control, not the list shortcut", () => {
	// Buttons, links and menu items are unprotected so shortcuts survive a
	// focused mail row; cancelling their activation to open a message instead
	// left every one of them visibly dead under the keyboard.
	assert.equal(activatesFocusedControl("Enter", target("button")), true);
	assert.equal(activatesFocusedControl("Enter", target("a")), true);
	assert.equal(activatesFocusedControl("Enter", target("summary")), true);
	assert.equal(activatesFocusedControl("Enter", target("div", "menuitem")), true);
	assert.equal(activatesFocusedControl("Enter", target("div", "button")), true);
	// Space activates the same controls, so it is claimed before it is mapped.
	assert.equal(activatesFocusedControl(" ", target("button")), true);
});

test("letter shortcuts keep working with a control focused", () => {
	for (const key of ["j", "k", "e", "r", "c", "u", "s", "z", "#", "/"]) {
		assert.equal(
			activatesFocusedControl(key, target("button")),
			false,
			`${key} is not an activation key and must still reach the list`,
		);
	}
});

test("Enter on a focused mail row activates that exact row", () => {
	// Rows are buttons and are NOT excluded: Search and Saved Views listen for no
	// open-message command, so cancelling the native activation there left Enter
	// doing nothing at all. In folders the ring follows DOM focus (roving focus in
	// email-list.tsx), so the row Enter opens is the row the reader sees ringed.
	assert.equal(activatesFocusedControl("Enter", rowTarget("button")), true);
	assert.equal(activatesFocusedControl("Enter", rowTarget("a")), true);
	// The list command still exists for the command palette and for j/k.
	assert.equal(shortcut("Enter").command, "open-message");
});

test("row shortcuts other than activation keys still reach the list", () => {
	for (const key of ["j", "k", "e", "r", "u", "s"]) {
		assert.equal(activatesFocusedControl(key, rowTarget("button")), false);
	}
});

test("nothing but a real element can claim an activation key", () => {
	assert.equal(activatesFocusedControl("Enter", null), false);
	assert.equal(activatesFocusedControl("Enter", target("div")), false);
	assert.equal(activatesFocusedControl("Enter", target("input")), false);
});
