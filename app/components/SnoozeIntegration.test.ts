import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relative: string) {
	return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const sidebar = read("./Sidebar.tsx");
const list = read("../routes/email-list.tsx");
const panel = read("./EmailPanel.tsx");
const toolbar = read("./email-panel/EmailPanelToolbar.tsx");
const row = read("./EmailRow.tsx");

test("Snoozed is a first-class mailbox folder with list and detail actions", () => {
	assert.match(sidebar, /Folders\.SNOOZED/);
	assert.match(list, /Nothing is snoozed/);
	assert.match(list, /email\.snoozed_until/);
	assert.match(list, /Return snoozed mail now/);
	assert.match(list, /<SnoozeDialog/);
	assert.match(panel, /candidate\.id !== Folders\.SNOOZED/);
	assert.match(panel, /<SnoozeDialog/);
	assert.match(toolbar, /aria-label="Snooze mail"/);
	assert.match(toolbar, /aria-label="Return snoozed mail now"/);
});

test("Snooze remains keyboard and touch accessible", () => {
	assert.match(list, /case "snooze"/);
	assert.match(list, /snoozeScopeAffectsRow\(scope, selectedRow\)/);
	assert.match(list, /setKeyboardTargetId\(null\);\s*closePanel\(\)/);
	assert.match(list, /aria-label="Snooze mail"/);
	// Row actions may hide until hover only where hovering exists. Every
	// hover reveal stays gated on pointer type so a touch screen - which
	// never hovers - keeps the actions permanently visible.
	const hoverReveals = [...row.matchAll(/[\w:-]*group-hover:[\w-]+/g)];
	assert.ok(hoverReveals.length > 0, "expected a hover reveal to gate");
	for (const [reveal] of hoverReveals) {
		assert.match(
			reveal,
			/^pointer-fine:group-hover:/,
			`${reveal} must not strand touch users`,
		);
	}
	assert.match(row, /pointer-fine:group-focus-within:flex/);
});
