// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Build the push payload the service worker renders. Notification content is
// decision B (WISER-240 grill): title = sender, body = subject + a snippet of
// the message. Deliberately surfaces email content on the lock screen in
// exchange for at-a-glance triage. Tapping deep-links to the exact message.

import type { PushPayload } from "./types";

type BuildPushPayloadInput = {
	emailId: string;
	mailboxId: string;
	fromName?: string | null;
	fromAddress: string;
	subject?: string | null;
	/** Raw stored body (may be HTML or plain text). */
	body?: string | null;
	icon: string;
	badge: string;
};

const MAX_TITLE_LENGTH = 120;
const MAX_SUBJECT_LENGTH = 240;
const UNSAFE_NOTIFICATION_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;

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
 * and an undecoded entity is read as literal text in a snippet.
 */
function decodeEntities(value: string): string {
	return value
		.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) =>
			NAMED_ENTITIES[name.toLowerCase()] ?? match,
		)
		.replace(/&#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));/g, (match, dec, hex) =>
			(dec ? decodedCodePoint(dec, 10) : decodedCodePoint(hex, 16)) ?? match,
		)
		.replace(/&amp;/g, "&");
}

// Elements whose *content* is markup, not prose. Stripping tags alone leaves
// their text behind, which is how styled marketing mail rendered raw CSS as its
// preview. The `|$` arm also drops a block left unterminated by an upstream
// truncation (list snippets slice the body before it reaches here).
const NON_PROSE_ELEMENTS = /<(script|style|head)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;

/**
 * Reduce a stored email body (HTML or plain text) to a short, safe one-line
 * preview: drop non-prose elements, strip tags, decode the common entities,
 * collapse whitespace, and truncate with an ellipsis. Not a security sanitizer
 * — the output is a notification/list string, never rendered as HTML.
 */
export function htmlToSnippet(raw: string | null | undefined, maxLength = 120): string {
	if (!raw) return "";
	let s = raw.replace(NON_PROSE_ELEMENTS, " ").replace(/<[^>]*>/g, " ");
	s = decodeEntities(s);
	s = s.replace(/\s+/g, " ").trim();
	return truncateText(s, maxLength);
}

function truncateText(value: string, maxLength: number): string {
	const safe = value.replace(UNSAFE_NOTIFICATION_TEXT, " ").replace(/\s+/g, " ").trim().normalize("NFC");
	const codePoints = Array.from(safe);
	if (codePoints.length <= maxLength) return safe;
	return `${codePoints.slice(0, maxLength - 1).join("").trimEnd()}…`;
}

export function buildPushPayload(input: BuildPushPayloadInput): PushPayload {
	const { emailId, mailboxId, fromName, fromAddress, subject, body, icon, badge } = input;

	const title = truncateText(
		fromName?.trim() || fromAddress.split("@")[0] || "New email",
		MAX_TITLE_LENGTH,
	) || truncateText(fromAddress.split("@")[0] || "New email", MAX_TITLE_LENGTH) || "New email";
	const subjectText = truncateText(subject?.trim() || "(no subject)", MAX_SUBJECT_LENGTH) || "(no subject)";
	const snippet = htmlToSnippet(body);

	return {
		title,
		body: snippet ? `${subjectText} — ${snippet}` : subjectText,
		icon,
		badge,
		clickUrl: `/mailbox/${encodeURIComponent(mailboxId)}/open/${encodeURIComponent(emailId)}`,
		data: { emailId, mailboxId },
	};
}
