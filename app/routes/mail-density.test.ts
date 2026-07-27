import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
	return readFileSync(new URL(path, import.meta.url), "utf8");
}

const folderList = read("./email-list.tsx");
const searchResults = read("./search-results.tsx");
const savedViewResults = read("./saved-view-results.tsx");
const row = read("../components/EmailRow.tsx");

for (const [surface, source] of [
	["folder list", folderList],
	["search results", searchResults],
	["saved view results", savedViewResults],
] as const) {
	test(`${surface} hands the shared row its density`, () => {
		assert.match(source, /mailDensity/);
		assert.match(source, /isCompact = mailDensity === "compact"/);
		assert.match(source, /compact=\{isCompact\}/);
	});
}

test("the shared row drops secondary snippets in compact density", () => {
	assert.match(row, /!compact && snippet/);
});

test("compact rows keep a 44 pixel primary interaction target and still breathe", () => {
	assert.match(row, /className="flex min-h-11 min-w-0 flex-1/);
	// Compact used to collapse the row to py-0, so neighbouring rows touched.
	assert.doesNotMatch(row, /py-0[^.]/);
	assert.match(row, /compact \? "py-1" : "py-2"/);
});
