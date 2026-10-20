type InlineAttachment = { id: string; content_id?: string | null };

/** A CID is a MIME reference, irrespective of Content-Disposition. */
export function rewriteInlineImages(body: string, mailboxId: string, emailId: string, attachments?: InlineAttachment[]): string {
	const byCid = new Map((attachments || []).filter(a => a.content_id).map(a => [a.content_id!.replace(/^<|>$/g, "").toLowerCase(), a.id]));
	return body.replace(/cid:([^\s"'<>]+)/gi, (original, cid: string) => {
		let decoded = cid;
		try { decoded = decodeURIComponent(cid); } catch { return original; }
		const id = byCid.get(decoded.toLowerCase());
		return id ? `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(id)}` : original;
	});
}

/** Only our attachment paths may be fetched with the parent's credentials. */
export function isInlineAttachmentUrl(value: string): boolean {
	return /^\/api\/v1\/mailboxes\/[^/?#]+\/emails\/[^/?#]+\/attachments\/[^/?#]+$/.test(value);
}

/** Some senders label PNG/JPEG parts as application/octet-stream. */
export function rasterImageType(bytes: Uint8Array): string | null {
	if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return "image/png";
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	const head = String.fromCharCode(...bytes.slice(0, 12));
	if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
	if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
	return null;
}
