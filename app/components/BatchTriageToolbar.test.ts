import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toolbar = readFileSync(new URL("./BatchTriageToolbar.tsx", import.meta.url), "utf8");
const list = readFileSync(new URL("../routes/email-list.tsx", import.meta.url), "utf8");
const row = readFileSync(new URL("./EmailRow.tsx", import.meta.url), "utf8");

test("batch toolbar exposes touch-sized, labeled selection and action controls", () => {
	assert.match(toolbar, /role="toolbar"/);
	assert.match(toolbar, /type="checkbox"/);
	assert.match(toolbar, /h-5 w-5/);
	assert.match(toolbar, /Select all visible conversations/);
	assert.match(toolbar, /Mark selected conversations read/);
	assert.match(toolbar, /Mark selected conversations unread/);
	assert.match(toolbar, /Archive selected conversations/);
	assert.match(toolbar, /Move selected conversations to Trash/);
	assert.match(toolbar, /selectedCount === 0 && idleControl/);
});

test("list row checkboxes are siblings of the dedicated open control and batch once", () => {
	assert.match(list, /BatchTriageToolbar/);
	assert.match(list, /useBatchTriage/);
	assert.match(list, /aria-label=\{`Select conversation/);
	assert.match(row, /aria-label=\{`Open conversation/);
});
