// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared utility functions used across the frontend.
 *
 * Date formatting has been consolidated into `shared/dates.ts`.
 * Re-export for backwards compatibility with existing imports.
 */
import DOMPurify from "dompurify";
import type { Attachment } from "~/types";
import { escapeHtml } from "./html-text.ts";

export { escapeHtml, stripHtml } from "./html-text.ts";

export {
	formatListDate,
	formatDetailDate,
	formatShortDate,
	toIsoDate,
} from "shared/dates";

/**
 * Format a byte count as a human-readable file size.
 */
export function formatBytes(bytes: number, decimals = 1): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const dm = decimals < 0 ? 0 : decimals;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Split a comma-separated email field into individual addresses.
 */
export function splitEmailList(value?: string | null): string[] {
	return (value || "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/**
 * Convert a list of addresses into the API payload format.
 */
export function toEmailListValue(addresses: string[]): string | string[] | undefined {
	if (addresses.length === 0) return undefined;
	return addresses.length === 1 ? addresses[0] : addresses;
}

/**
 * Convert HTML content to plain text.
 * Uses DOM APIs so must only be called client-side.
 */
export function htmlToPlainText(html: string): string {
	// Sanitize with DOMPurify before DOM parsing to prevent XSS during innerHTML assignment.
	// DOMPurify strips all dangerous content (scripts, event handlers, etc.)
	// while preserving structural HTML for text extraction.
	const sanitized = DOMPurify.sanitize(html);
	const div = document.createElement("div");
	div.innerHTML = sanitized
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<p[^>]*>/gi, "")
		.replace(/<div[^>]*>/gi, "")
		.replace(/<\/div>/gi, "\n");
	return (div.textContent || div.innerText || "").trim();
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_match: string, code: string) =>
			String.fromCharCode(Number(code)),
		)
		.replace(/&#x([0-9a-f]+);/gi, (_match: string, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		)
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ");
}

export function getSnippetText(
	snippet?: string | null,
	maxLength = 100,
): string {
	if (!snippet) return "";

	const clean = decodeHtmlEntities(
		snippet
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
			.replace(/<style[^>]*>[\s\S]*/gi, "")
			.replace(/<[^>]*>/g, " ")
			.replace(/<[^>]*$/g, ""),
	)
		.replace(/\s+/g, " ")
		.trim();

	if (!clean) return "";
	return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}

/**
 * Generate the HTML signature block for compose forms.
 */
export function getSignatureBlock(settings?: {
	signature?: { enabled: boolean; text?: string; html?: string };
}): string {
	const sig = settings?.signature;
	if (sig?.enabled && (sig?.html || sig?.text)) {
		// Sanitize HTML signatures with DOMPurify to allow safe formatting
		// (bold, italic, links, etc.) while stripping scripts and event handlers.
		// Text signatures are HTML-escaped since they have no formatting.
		const content = sig.html
			? DOMPurify.sanitize(sig.html)
			: escapeHtml(sig.text || "");
		return `<div style="border-top: 1px solid #ccc; margin-top: 16px; padding-top: 12px;">${content}</div>`;
	}
	return "";
}

export function getNonInlineAttachments(attachments?: Attachment[]): Attachment[] {
	return attachments?.filter((attachment) => attachment.disposition !== "inline") ?? [];
}

export function getAttachmentUrl(
	mailboxId: string,
	emailId: string,
	attachmentId: string,
): string {
	return `/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`;
}

export function downloadFile(url: string, filename: string) {
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
}
