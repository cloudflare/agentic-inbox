import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const row = readFileSync(new URL("./EmailRow.tsx", import.meta.url), "utf8");

test("each line truncates on its own so the snippet is reachable", () => {
	// Sender, subject and snippet previously shared one truncating container,
	// which made the snippet unreachable and let the sender collapse.
	const sender = /title=\{sender\.title\}[\s\S]{0,220}?truncate/;
	const subject = /email\.subject \? highlight\(email\.subject\) : "\(No subject\)"/;
	const snippet = /!compact && snippet[\s\S]{0,160}?truncate/;
	assert.match(row, sender);
	assert.match(row, subject);
	assert.match(row, snippet);
	assert.ok(
		row.match(/truncate/g)!.length >= 3,
		"sender, subject and snippet each need their own truncation boundary",
	);
});

test("a clipped sender stays recoverable and never squeezes out the date", () => {
	assert.match(row, /title=\{sender\.title\}/);
	assert.match(row, /min-w-16 flex-1 truncate/);
	assert.match(row, /<time[\s\S]*?className="shrink-0/);
});

test("the date is machine readable and carries its full value", () => {
	assert.match(row, /dateTime=\{toIsoDate\(email\.date\)\}/);
	assert.match(row, /title=\{formatDetailDate\(email\.date\)\}/);
	assert.match(row, /\{formatListDate\(email\.date\)\}/);
});

test("an open conversation reads differently from a batch-checked one", () => {
	assert.match(row, /selected\s*\?\s*"bg-kumo-fill border-s-kumo-brand"/);
	assert.match(row, /batchSelected\s*\?\s*"bg-kumo-brand\/10 border-s-kumo-brand\/40"/);
});

test("rows surface attachments and thread size from the list payload", () => {
	assert.match(row, /email\.has_attachments/);
	assert.match(row, /<PaperclipIcon/);
	assert.match(row, /threadCount > 1/);
});

test("sender text comes from the shared resolver, not a raw address split", () => {
	assert.match(row, /formatSenderLabel\(email\)/);
	assert.doesNotMatch(row, /split\("@"\)/);
});
