// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared attachment storage logic.
 * Eliminates the triplicated atob → Uint8Array → R2.put pattern.
 */
import type { Env } from "../types";

export interface StoredAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
}

/**
 * Canonical R2 key for an attachment blob. All read/write/delete sites
 * should funnel through this helper so the layout is defined in exactly
 * one place — the mailbox-delete reap in particular relies on being able
 * to reconstruct every key from `(email_id, attachment_id, filename)`
 * triples stored in the DO.
 *
 * The `filename` segment is NOT re-sanitized here. Callers that accept
 * user input (inbound email, API uploads) already strip path separators
 * and control characters at the write boundary (`storeAttachments` below
 * and the receive path in `workers/index.ts`); applying a second
 * transformation here would introduce a mismatch between write and
 * read keys.
 */
export function attachmentObjectKey(
	emailId: string,
	attachmentId: string,
	filename: string,
): string {
	return `attachments/${emailId}/${attachmentId}/${filename}`;
}

/**
 * Store base64-encoded attachments to R2 and return metadata for the DO.
 */
export async function storeAttachments(
	bucket: Env["BUCKET"],
	emailId: string,
	attachments?: {
		content: string;
		filename: string;
		type: string;
		disposition: string;
		contentId?: string;
	}[],
): Promise<StoredAttachment[]> {
	if (!attachments?.length) return [];

	const results: StoredAttachment[] = [];
	for (const att of attachments) {
		const attachmentId = crypto.randomUUID();
		// Sanitize filename to prevent path traversal in R2 keys
		const safeFilename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
		const key = attachmentObjectKey(emailId, attachmentId, safeFilename);
		const binaryStr = atob(att.content);
		const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
		await bucket.put(key, bytes);
		results.push({
			id: attachmentId,
			email_id: emailId,
			filename: safeFilename,
			mimetype: att.type,
			size: bytes.byteLength,
			content_id: att.contentId || null,
			disposition: att.disposition,
		});
	}
	return results;
}
