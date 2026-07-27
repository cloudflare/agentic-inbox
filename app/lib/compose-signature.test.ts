import assert from "node:assert/strict";
import test from "node:test";
import {
	extractAiAuthoredContent,
	extractComposeSignature,
	hasAiAuthoredContent,
	hasComposeSignature,
	insertComposeSignature,
	insertComposeSignatureManually,
	FORWARDED_MESSAGE_MARKER,
	MAIL_SIGNATURE_MARKER,
	planDelayedComposeSignature,
	QUOTED_REPLY_MARKER,
	removeComposeSignatures,
	replaceAiAuthoredContent,
	renderComposeSignature,
} from "./compose-signature.ts";

const quotedReply =
	'<blockquote data-mail-quoted-reply="v1">On Monday, a@example.com wrote:<br>Original</blockquote>';

test("AI context contains only authored content, never signatures or forwarded mail", () => {
	const signature = '<div data-mail-signature="v1">Hesham<br>Wiser</div>';
	const forwarded =
		'<div data-mail-forwarded-message="v1"><p>Original message</p></div>';
	assert.equal(
		extractAiAuthoredContent(
			`<p>Please refine this</p>${signature}${signature}${forwarded}`,
		),
		"<p>Please refine this</p>",
	);
	assert.equal(hasAiAuthoredContent(`<p><br></p>${signature}`), false);
	assert.equal(hasAiAuthoredContent(`<p>&nbsp;</p>${forwarded}`), false);
	assert.equal(hasAiAuthoredContent(`<p>One thought</p>${signature}`), true);
	assert.equal(hasAiAuthoredContent(`<p><img src="cid:chart"></p>`), true);
});

test("plain-text signatures normalize newlines and escape hostile markup", () => {
	assert.equal(MAIL_SIGNATURE_MARKER, 'data-mail-signature="v1"');
	assert.equal(
		renderComposeSignature(
			"Hesham & Team\r\n<script>alert(\"x\")</script>\rIt\'s safe",
		),
		'<div data-mail-signature="v1">Hesham &amp; Team<br>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>It&#39;s safe</div>',
	);
});

test("AI replacement preserves exactly one current signature and the complete forwarded block", () => {
	const currentSignature =
		'<div data-mail-signature="v1">Hesham<br>Wiser</div>';
	const forwarded =
		'<div data-mail-forwarded-message="v1"><p>Original</p><div><p>Nested quote</p></div></div>';
	const current = `<p>Old authored text</p>${currentSignature}${currentSignature}${forwarded}`;
	const ai =
		'<p>AI replacement</p><div data-mail-signature="v1">Do not trust this</div>' +
		'<div data-mail-forwarded-message="v1"><p>Do not trust this quote</p></div>';
	assert.equal(
		replaceAiAuthoredContent(current, ai),
		`<p>AI replacement</p>${currentSignature}${forwarded}`,
	);
});

test("manual insertion preserves authored and forwarded content and refuses a duplicate", () => {
	const forward =
		'<div data-mail-forwarded-message="v1"><p>Quoted & untouched</p></div>';
	const edited = `<p data-user="yes">My exact edit</p>${forward}`;
	const inserted = insertComposeSignatureManually(edited, "Hesham", "forward");
	assert.deepEqual(inserted, {
		bodyHtml:
			'<p data-user="yes">My exact edit</p><div data-mail-signature="v1">Hesham</div>' +
			forward,
		inserted: true,
		reason: "inserted",
	});
	assert.deepEqual(
		insertComposeSignatureManually(inserted.bodyHtml, "Other", "forward"),
		{
			bodyHtml: inserted.bodyHtml,
			inserted: false,
			reason: "duplicate",
		},
	);
});

test("delayed settings insert only into pristine content and otherwise offer a manual action", () => {
	assert.deepEqual(
		planDelayedComposeSignature({
			bodyHtml: "<p>Reply seed</p>",
			signatureText: "Team",
			enabled: true,
			mode: "reply",
			pristine: true,
		}),
		{
			action: "insert",
			bodyHtml:
				'<p>Reply seed</p><div data-mail-signature="v1">Team</div>',
		},
	);
	const edited = "<p>User typed & kept this byte-for-byte</p>";
	assert.deepEqual(
		planDelayedComposeSignature({
			bodyHtml: edited,
			signatureText: "Team",
			enabled: true,
			mode: "reply",
			pristine: false,
		}),
		{ action: "offer-manual", bodyHtml: edited },
	);
	assert.deepEqual(
		planDelayedComposeSignature({
			bodyHtml: edited,
			signatureText: "Team",
			enabled: true,
			mode: "draft",
			pristine: true,
		}),
		{ action: "none", bodyHtml: edited, reason: "draft" },
	);
	assert.deepEqual(
		planDelayedComposeSignature({
			bodyHtml: edited,
			signatureText: "Team",
			enabled: false,
			mode: "new",
			pristine: true,
		}),
		{ action: "none", bodyHtml: edited, reason: "disabled" },
	);
	const signed = '<p>Body</p><div data-mail-signature="v1">Team</div>';
	assert.deepEqual(
		planDelayedComposeSignature({
			bodyHtml: signed,
			signatureText: "Team",
			enabled: true,
			mode: "reply",
			pristine: true,
		}),
		{ action: "none", bodyHtml: signed, reason: "duplicate" },
	);
	const quotedSignature =
		'<div data-mail-forwarded-message="v1"><div data-mail-signature="v1">Sender</div></div>';
	assert.equal(
		planDelayedComposeSignature({
			bodyHtml: quotedSignature,
			signatureText: "Team",
			enabled: true,
			mode: "forward",
			pristine: true,
		}).action,
		"insert",
	);
});

test("forward signatures are inserted immediately before the stable forwarded-message marker", () => {
	assert.equal(
		FORWARDED_MESSAGE_MARKER,
		'data-mail-forwarded-message="v1"',
	);
	const forwarded =
		'<div data-mail-forwarded-message="v1"><p>From: sender@example.com</p><div>Nested quoted content</div></div>';
	assert.deepEqual(
		insertComposeSignature(`<p>My note</p>${forwarded}`, "Team", "forward"),
		{
			bodyHtml:
				'<p>My note</p><div data-mail-signature="v1">Team</div>' +
				forwarded,
			inserted: true,
			reason: "inserted",
		},
	);
	const quotedSignature =
		'<div data-mail-forwarded-message="v1"><div data-mail-signature="v1">Sender signature</div></div>';
	assert.equal(
		insertComposeSignature(quotedSignature, "My signature", "forward").bodyHtml,
		'<div data-mail-signature="v1">My signature</div>' + quotedSignature,
	);
});

test("new and reply modes insert once at the bottom while Draft mode is a no-op", () => {
	const modes: Array<"new" | "reply" | "reply-all"> = [
		"new",
		"reply",
		"reply-all",
	];
	for (const mode of modes) {
		assert.deepEqual(insertComposeSignature("<p>Hello</p>", "Team", mode), {
			bodyHtml:
				'<p>Hello</p><div data-mail-signature="v1">Team</div>',
			inserted: true,
			reason: "inserted",
		});
	}
	assert.deepEqual(insertComposeSignature("<p>Draft</p>", "Team", "draft"), {
		bodyHtml: "<p>Draft</p>",
		inserted: false,
		reason: "draft",
	});
	const alreadySigned =
		'<p>Hello</p><div data-mail-signature="v1">Existing</div>';
	assert.deepEqual(insertComposeSignature(alreadySigned, "Replacement", "reply"), {
		bodyHtml: alreadySigned,
		inserted: false,
		reason: "duplicate",
	});
});

test("marked signatures can be detected, extracted, and completely removed", () => {
	const signature = '<div data-mail-signature="v1">Hesham<br>Wiser</div>';
	const body = `<p>Hello</p>${signature}<p>Middle</p>${signature}`;
	assert.equal(hasComposeSignature(body), true);
	assert.equal(extractComposeSignature(body), signature);
	assert.equal(removeComposeSignatures(body), "<p>Hello</p><p>Middle</p>");
	assert.equal(hasComposeSignature("<p>data-mail-signature=\"v1\"</p>"), false);
});

test("a quoted reply is treated as the same untouchable tail as a forward", () => {
	assert.equal(QUOTED_REPLY_MARKER, 'data-mail-quoted-reply="v1"');

	// The quote is someone else's words: never sent to the model as context...
	assert.equal(
		extractAiAuthoredContent(`<p>My reply</p>${quotedReply}`),
		"<p>My reply</p>",
	);
	assert.equal(hasAiAuthoredContent(`<p>&nbsp;</p>${quotedReply}`), false);

	// ...and never lost when the model rewrites what the author did write.
	const signature = renderComposeSignature("Hesham");
	assert.equal(
		replaceAiAuthoredContent(
			`<p>Old text</p>${signature}${quotedReply}`,
			"<p>AI replacement</p>",
		),
		`<p>AI replacement</p>${signature}${quotedReply}`,
	);
});

test("reply signatures are inserted above the quoted original", () => {
	const signature = renderComposeSignature("Team");

	assert.equal(
		insertComposeSignature(`<p>My reply</p>${quotedReply}`, "Team", "reply")
			.bodyHtml,
		`<p>My reply</p>${signature}${quotedReply}`,
	);
	// Settings that resolve after the reply was seeded land in the same place.
	assert.deepEqual(
		planDelayedComposeSignature({
			bodyHtml: `<p><br></p>${quotedReply}`,
			signatureText: "Team",
			enabled: true,
			mode: "reply",
			pristine: true,
		}),
		{ action: "insert", bodyHtml: `<p><br></p>${signature}${quotedReply}` },
	);

	// A signature quoted from the sender is not this author's signature.
	const quotedSignature =
		`<blockquote data-mail-quoted-reply="v1">${renderComposeSignature("Sender")}</blockquote>`;
	assert.equal(
		insertComposeSignature(quotedSignature, "Team", "reply").bodyHtml,
		`${signature}${quotedSignature}`,
	);
});
