// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * One entity decoder for both runtimes. The worker decodes when it builds a
 * snippet or a push body; the browser decodes again when it renders a list row.
 * They drifted apart once already, which is how "&mdash;" reached a mail row as
 * literal text, so the vocabulary lives here and neither side keeps its own.
 *
 * Output is plain text for display, never markup: this is not a sanitizer.
 */

// "amp" is deliberately absent: it decodes last so "&amp;lt;" → "&lt;", not "<".
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	nbsp: " ",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	hellip: "…",
	bull: "•",
	middot: "·",
	copy: "©",
	reg: "®",
	trade: "™",
};

/** Reject anything String.fromCodePoint would throw on or render as a lone surrogate. */
function decodedCodePoint(digits: string, radix: number): string | null {
	const code = Number.parseInt(digits, radix);
	if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return null;
	if (code >= 0xd800 && code <= 0xdfff) return null;
	return String.fromCodePoint(code);
}

/**
 * Decode the entities that actually reach prose. Marketing senders emit named
 * punctuation ("&mdash;") and numeric escapes ("&#8212;", "&#x2014;") freely,
 * and an undecoded entity is read as literal text.
 */
export function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) =>
			NAMED_ENTITIES[name.toLowerCase()] ?? match,
		)
		.replace(/&#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));/g, (match, dec, hex) =>
			(dec ? decodedCodePoint(dec, 10) : decodedCodePoint(hex, 16)) ?? match,
		)
		.replace(/&amp;/g, "&");
}
