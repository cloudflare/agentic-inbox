// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Notification content (decision B: sender · subject · body snippet) + the
// deep-link clickUrl. Run:
//   node --experimental-strip-types --test workers/lib/push/payload.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPushPayload, htmlToSnippet } from "./payload.ts";
import { validateStoredPushPayload } from "./types.ts";

test("htmlToSnippet strips tags, decodes entities, collapses whitespace", () => {
	assert.equal(
		htmlToSnippet("<p>Hello&nbsp;<b>world</b></p>\n\n  again"),
		"Hello world again",
	);
	assert.equal(htmlToSnippet("a &amp; b &lt;c&gt; &quot;d&quot;"), 'a & b <c> "d"');
});

test("htmlToSnippet truncates with an ellipsis at the limit", () => {
	const out = htmlToSnippet("abcdefghij", 5);
	assert.equal(out, "abcd…"); // 4 chars + ellipsis
	assert.equal(htmlToSnippet("abcd", 5), "abcd"); // under limit, untouched
});

test("htmlToSnippet drops style/script/head content, not just their tags", () => {
	const marketing = `<!DOCTYPE html><html><head><meta charset="utf-8">
		<style type="text/css">
			.btn { background-color: #ff0000; padding: 12px 24px; }
			@media only screen and (max-width: 600px) { .wrap { width: 100% !important; } }
		</style></head>
		<body><div class="wrap"><h1>Your order shipped</h1>
		<script>window.track("open");</script>
		<p>Arriving Tuesday.</p></div></body></html>`;

	assert.equal(htmlToSnippet(marketing), "Your order shipped Arriving Tuesday.");
});

test("htmlToSnippet drops a style block left unterminated by truncation", () => {
	// A body sliced mid-<style> must not leak the CSS fragment as the preview.
	assert.equal(htmlToSnippet("<p>Hi</p><style>.a { color: red; } .b { colo"), "Hi");
});

test("htmlToSnippet handles empty / missing body", () => {
	assert.equal(htmlToSnippet(""), "");
	assert.equal(htmlToSnippet(null), "");
	assert.equal(htmlToSnippet(undefined), "");
});

const base = {
	emailId: "msg-123",
	mailboxId: "hesham@wiserchat.ai",
	fromAddress: "john.doe@acme.com",
	subject: "Contract signed",
	body: "<p>Great news — the contract is signed and attached.</p>",
	icon: "/icon-192.png",
	badge: "/favicon-32.png",
};

test("payload title = sender display name when present", () => {
	const p = buildPushPayload({ ...base, fromName: "John Doe" });
	assert.equal(p.title, "John Doe");
});

test("payload title falls back to the address local-part when no name", () => {
	const p = buildPushPayload({ ...base, fromName: null });
	assert.equal(p.title, "john.doe");
});

test("payload body = subject + snippet (decision B)", () => {
	const p = buildPushPayload({ ...base, fromName: "John Doe" });
	assert.equal(p.body, "Contract signed — Great news — the contract is signed and attached.");
});

test("payload body is just the subject when the email has no body text", () => {
	const p = buildPushPayload({ ...base, body: "" });
	assert.equal(p.body, "Contract signed");
});

test("missing subject → placeholder", () => {
	const p = buildPushPayload({ ...base, subject: "", body: "" });
	assert.equal(p.body, "(no subject)");
});

test("clickUrl deep-links through the current Message resolver (URL-encoded)", () => {
	const p = buildPushPayload(base);
	assert.equal(
		p.clickUrl,
		"/mailbox/hesham%40wiserchat.ai/open/msg-123",
	);
});

test("icon/badge pass through and data carries the routing ids", () => {
	const p = buildPushPayload(base);
	assert.equal(p.icon, "/icon-192.png");
	assert.equal(p.badge, "/favicon-32.png");
	assert.deepEqual(p.data, { emailId: "msg-123", mailboxId: "hesham@wiserchat.ai" });
});

test("sender-controlled notification text stays inside the Web Push plaintext limit", () => {
	const payload = buildPushPayload({
		...base,
		fromName: "🚀".repeat(3_000),
		subject: "\\\"".repeat(3_000),
		body: "أ".repeat(3_000),
	});
	const encodedLength = new TextEncoder().encode(JSON.stringify(payload)).byteLength;

	assert.ok(encodedLength <= 3_993, `payload is ${encodedLength} bytes`);
});

test("hostile control and bidi-only text falls back without making inbound payload invalid", () => {
	const payload = buildPushPayload({
		...base,
		fromName: "\u202e\u0000\u200b",
		fromAddress: "safe.sender@example.com",
		subject: "\u202e\u0000",
		body: "\u200b",
	});
	assert.equal(payload.title, "safe.sender");
	assert.equal(payload.body, "(no subject)");
	assert.deepEqual(
		validateStoredPushPayload(payload, { emailId: base.emailId, mailboxId: base.mailboxId }),
		payload,
	);
});

test("stored payload rejects protocol-relative or traversing assets and forged identities", () => {
	const payload = buildPushPayload(base);
	for (const invalid of [
		{ ...payload, icon: "//evil.example/icon.png" },
		{ ...payload, badge: "/../secret" },
		{ ...payload, title: "Unsafe\u202etitle" },
		{ ...payload, data: { ...payload.data, emailId: "other" } },
	]) {
		assert.throws(() => validateStoredPushPayload(invalid, {
			emailId: base.emailId,
			mailboxId: base.mailboxId,
		}));
	}
});
