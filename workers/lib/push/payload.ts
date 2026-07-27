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

const ENTITIES: [RegExp, string][] = [
	[/&nbsp;/g, " "],
	[/&lt;/g, "<"],
	[/&gt;/g, ">"],
	[/&quot;/g, '"'],
	[/&#0*39;|&apos;/g, "'"],
	[/&amp;/g, "&"], // decode last so "&amp;lt;" → "&lt;", not "<"
];

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
	for (const [re, ch] of ENTITIES) s = s.replace(re, ch);
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
