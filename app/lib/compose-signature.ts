// The blocks compose seeds and then has to find again. The attribute names are
// exported separately because the editor schema matches on the bare attribute,
// while the body builders write the whole `name="value"` pair inline.
export const MAIL_BLOCK_VERSION = "v1";
export const MAIL_SIGNATURE_ATTRIBUTE = "data-mail-signature";
export const FORWARDED_MESSAGE_ATTRIBUTE = "data-mail-forwarded-message";
export const QUOTED_REPLY_ATTRIBUTE = "data-mail-quoted-reply";

export const MAIL_SIGNATURE_MARKER = `${MAIL_SIGNATURE_ATTRIBUTE}="${MAIL_BLOCK_VERSION}"`;
export const FORWARDED_MESSAGE_MARKER = `${FORWARDED_MESSAGE_ATTRIBUTE}="${MAIL_BLOCK_VERSION}"`;
// No writer pairs QUOTED_REPLY_ATTRIBUTE with a value any more - replies stopped
// quoting the message they answer - but the attribute stays: drafts saved before
// that change still carry a quote block and must keep being read as a tail.

export type ComposeSignatureMode =
	| "new"
	| "reply"
	| "reply-all"
	| "forward"
	| "draft";

export type ComposeSignatureInsertionResult = {
	bodyHtml: string;
	inserted: boolean;
	reason: "inserted" | "duplicate" | "draft";
};

export type DelayedComposeSignaturePlan =
	| { action: "insert"; bodyHtml: string }
	| { action: "offer-manual"; bodyHtml: string }
	| {
			action: "none";
			bodyHtml: string;
			reason: "disabled" | "draft" | "duplicate";
	  };

const SIGNATURE_BLOCK_SOURCE =
	String.raw`<div\b(?=[^>]*\bdata-mail-signature\s*=\s*(["'])v1\1)[^>]*>[\s\S]*?<\/div\s*>`;
// A forwarded block and a quoted reply are both "someone else's words, at the
// end". Signatures go above them and AI rewrites never touch them. Only forwards
// still seed one; the quoted-reply arm is kept for drafts persisted back when
// replies quoted their original.
const QUOTED_TAIL_OPEN_SOURCE =
	String.raw`<(?:div|blockquote)\b(?=[^>]*\b(?:data-mail-forwarded-message|data-mail-quoted-reply)\s*=\s*(["'])v1\1)[^>]*>`;

function signatureBlockPattern(global = false): RegExp {
	return new RegExp(SIGNATURE_BLOCK_SOURCE, global ? "gi" : "i");
}

function quotedTailIndex(bodyHtml: string): number {
	return bodyHtml.search(new RegExp(QUOTED_TAIL_OPEN_SOURCE, "i"));
}

function authoredContent(bodyHtml: string): string {
	const index = quotedTailIndex(bodyHtml);
	return index >= 0 ? bodyHtml.slice(0, index) : bodyHtml;
}

function quotedTail(bodyHtml: string): string | null {
	const index = quotedTailIndex(bodyHtml);
	return index >= 0 ? bodyHtml.slice(index) : null;
}

function normalizePlainText(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function renderComposeSignature(text: string): string {
	const body = escapeHtml(normalizePlainText(text)).replace(/\n/g, "<br>");
	return `<div ${MAIL_SIGNATURE_MARKER}>${body}</div>`;
}

export function extractComposeSignature(bodyHtml: string): string | null {
	return bodyHtml.match(signatureBlockPattern())?.[0] ?? null;
}

export function hasComposeSignature(bodyHtml: string): boolean {
	return extractComposeSignature(bodyHtml) !== null;
}

export function removeComposeSignatures(bodyHtml: string): string {
	return bodyHtml.replace(signatureBlockPattern(true), "");
}

/**
 * Returns only the content authored for the current message. Stable signature
 * and forwarded-message blocks are deliberately excluded from AI context.
 */
export function extractAiAuthoredContent(bodyHtml: string): string {
	return removeComposeSignatures(authoredContent(bodyHtml));
}

export function hasAiAuthoredContent(bodyHtml: string): boolean {
	const authored = extractAiAuthoredContent(bodyHtml);
	if (/<(?:img|hr|table|iframe|video|audio|svg)\b/i.test(authored)) {
		return true;
	}
	return authored
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;|&#160;|&#x0*a0;/gi, " ")
		.trim().length > 0;
}

export function insertComposeSignature(
	bodyHtml: string,
	signatureText: string,
	mode: ComposeSignatureMode,
): ComposeSignatureInsertionResult {
	if (mode === "draft") {
		return { bodyHtml, inserted: false, reason: "draft" };
	}
	if (hasComposeSignature(authoredContent(bodyHtml))) {
		return { bodyHtml, inserted: false, reason: "duplicate" };
	}
	const signature = renderComposeSignature(signatureText);
	const tailIndex = quotedTailIndex(bodyHtml);
	return {
		bodyHtml: tailIndex >= 0
			? `${bodyHtml.slice(0, tailIndex)}${signature}${bodyHtml.slice(tailIndex)}`
			: `${bodyHtml}${signature}`,
		inserted: true,
		reason: "inserted",
	};
}

export function planDelayedComposeSignature(input: {
	bodyHtml: string;
	signatureText: string;
	enabled: boolean;
	mode: ComposeSignatureMode;
	pristine: boolean;
}): DelayedComposeSignaturePlan {
	if (input.mode === "draft") {
		return { action: "none", bodyHtml: input.bodyHtml, reason: "draft" };
	}
	if (!input.enabled) {
		return { action: "none", bodyHtml: input.bodyHtml, reason: "disabled" };
	}
	if (hasComposeSignature(authoredContent(input.bodyHtml))) {
		return { action: "none", bodyHtml: input.bodyHtml, reason: "duplicate" };
	}
	if (!input.pristine) {
		return { action: "offer-manual", bodyHtml: input.bodyHtml };
	}
	return {
		action: "insert",
		bodyHtml: insertComposeSignature(
			input.bodyHtml,
			input.signatureText,
			input.mode,
		).bodyHtml,
	};
}

export function insertComposeSignatureManually(
	bodyHtml: string,
	signatureText: string,
	mode: ComposeSignatureMode,
): ComposeSignatureInsertionResult {
	return insertComposeSignature(bodyHtml, signatureText, mode);
}

export function replaceAiAuthoredContent(
	currentBodyHtml: string,
	aiAuthoredHtml: string,
): string {
	const signature = extractComposeSignature(authoredContent(currentBodyHtml));
	const tail = quotedTail(currentBodyHtml);
	const replacement = extractAiAuthoredContent(aiAuthoredHtml);
	return `${replacement}${signature ?? ""}${tail ?? ""}`;
}
