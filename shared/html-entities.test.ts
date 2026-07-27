import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { decodeHtmlEntities } from "./html-entities.ts";

test("named punctuation entities decode", () => {
	assert.equal(decodeHtmlEntities("a &mdash; b"), "a — b");
	assert.equal(
		decodeHtmlEntities("&lsquo;a&rsquo; &ldquo;b&rdquo; &ndash; c&hellip;"),
		"‘a’ “b” – c…",
	);
	assert.equal(
		decodeHtmlEntities("&bull; &middot; &copy; &reg; &trade; &nbsp;"),
		"• · © ® ™  ",
	);
	assert.equal(decodeHtmlEntities("&lt;b&gt; &quot;q&quot; &apos;a&apos;"), "<b> \"q\" 'a'");
});

test("numeric entities decode in decimal and hex, in any case", () => {
	assert.equal(decodeHtmlEntities("a &#8212; b"), "a — b");
	assert.equal(decodeHtmlEntities("a &#x2014; b"), "a — b");
	assert.equal(decodeHtmlEntities("a &#X2014; b"), "a — b");
	assert.equal(decodeHtmlEntities("caf&#233;"), "café");
	assert.equal(decodeHtmlEntities("&#128512;"), "\u{1F600}");
});

test("undecodable escapes are left exactly as written", () => {
	assert.equal(decodeHtmlEntities("&#1114112;"), "&#1114112;");
	assert.equal(decodeHtmlEntities("&#xD800;"), "&#xD800;");
	assert.equal(decodeHtmlEntities("&notarealentity;"), "&notarealentity;");
	assert.equal(decodeHtmlEntities("bare & ampersand"), "bare & ampersand");
});

test("ampersand decodes last so an escaped entity survives one pass", () => {
	assert.equal(decodeHtmlEntities("&amp;lt;"), "&lt;");
	assert.equal(decodeHtmlEntities("&amp;mdash;"), "&mdash;");
	assert.equal(decodeHtmlEntities("&amp;#8212;"), "&#8212;");
	assert.equal(decodeHtmlEntities("a &amp; b"), "a & b");
});

test("both runtimes decode through this module, so they cannot drift again", () => {
	// The worker builds the snippet and the browser re-decodes it when it renders
	// the row. A second private table in either place is how "&mdash;" shipped.
	const consumers = [
		"../app/lib/utils.ts",
		"../workers/lib/push/payload.ts",
	];
	for (const consumer of consumers) {
		const source = readFileSync(new URL(consumer, import.meta.url), "utf8");
		assert.match(
			source,
			/import \{ decodeHtmlEntities \} from "(\.\.\/)+shared\/html-entities\.ts"/,
			`${consumer} must decode through the shared module`,
		);
		assert.doesNotMatch(
			source,
			/&mdash;|&nbsp;/,
			`${consumer} must not keep its own entity table`,
		);
	}
});

test("the entity observed live in a mail row now decodes", () => {
	assert.equal(
		decodeHtmlEntities("Save 30% on annual plans this week only &mdash; ends Friday."),
		"Save 30% on annual plans this week only — ends Friday.",
	);
});
