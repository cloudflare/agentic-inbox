// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Email sending via Resend HTTP API.
 *
 * Uses the Resend REST API (https://api.resend.com/emails) to send emails.
 *
 * See: https://resend.com/docs/api-reference/emails/send-email
 */

import type { Env } from "./types";

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

/** Format an address field for Resend: string passes through; object becomes "Name <email>" */
function formatAddress(addr: string | { email: string; name: string }): string {
	if (typeof addr === "string") return addr;
	return `${addr.name} <${addr.email}>`;
}

/** Normalise a recipient field to an array of strings. */
function toArray(val: string | string[] | undefined): string[] | undefined {
	if (val === undefined) return undefined;
	return Array.isArray(val) ? val : [val];
}

/**
 * Send an email using the Resend HTTP API.
 *
 * @param env    - Worker env (must contain RESEND_API_KEY)
 * @param params - Email parameters (to, from, subject, body, etc.)
 * @returns The send result with messageId (Resend's `id` field)
 * @throws On HTTP errors, includes response status and Resend error message
 */
export async function sendEmail(
	env: Env,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const payload: Record<string, unknown> = {
		from: formatAddress(params.from),
		to: toArray(params.to),
		subject: params.subject,
	};

	if (params.html) payload.html = params.html;
	if (params.text) payload.text = params.text;
	if (params.cc) payload.cc = toArray(params.cc);
	if (params.bcc) payload.bcc = toArray(params.bcc);
	if (params.replyTo) payload.reply_to = formatAddress(params.replyTo);

	if (params.headers && Object.keys(params.headers).length > 0) {
		payload.headers = params.headers;
	}

	if (params.attachments && params.attachments.length > 0) {
		payload.attachments = params.attachments.map((att) => ({
			content: att.content,
			filename: att.filename,
			content_type: att.type,
			...(att.contentId ? { content_id: att.contentId } : {}),
		}));
	}

	const response = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		let message = response.statusText;
		try {
			const errBody = (await response.json()) as { message?: string; name?: string };
			if (errBody.message) message = errBody.message;
		} catch {
			// ignore JSON parse failure — use statusText
		}
		throw new Error(`Resend API error ${response.status}: ${message}`);
	}

	const result = (await response.json()) as { id: string };
	return { messageId: result.id };
}
