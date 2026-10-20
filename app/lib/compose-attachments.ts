export interface ComposeAttachment {
	filename: string;
	type: string;
	content: string;
	disposition: "attachment" | "inline";
	contentId?: string;
}

export function validateAttachmentSize(existing: Pick<ComposeAttachment, "content">[], sizes: number[]) {
	const bytes = existing.reduce((sum, item) => sum + item.content.length * 3 / 4 - (item.content.endsWith("==") ? 2 : item.content.endsWith("=") ? 1 : 0), 0);
	if (existing.length + sizes.length > 100) throw new Error("Attach no more than 100 files and images.");
	if (bytes + sizes.reduce((sum, size) => sum + size, 0) > 10 * 1024 * 1024) throw new Error("Attachments and images must total 10 MiB or less.");
}

export async function encodeAttachment(file: File, inline = false): Promise<ComposeAttachment> {
	if (inline && !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, GIF, or WebP image.");
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	return { filename: file.name, type: file.type || "application/octet-stream", content: btoa(binary), disposition: inline ? "inline" : "attachment", ...(inline ? { contentId: `${crypto.randomUUID()}@compose` } : {}) };
}

export function attachmentPreview(item: ComposeAttachment) { return `data:${item.type};base64,${item.content}`; }

export function prepareComposeBody(body: string, attachments: ComposeAttachment[]) {
	return attachments.reduce((html, item) => {
		if (!item.contentId) return html;
		const dataUrl = attachmentPreview(item);
		const escaped = dataUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return html.replace(new RegExp(escaped, "g"), `cid:${item.contentId}`);
	}, body);
}

export function previewComposeBody(body: string, attachments: ComposeAttachment[]) {
	return attachments.reduce((html, item) => item.contentId && /^image\/(png|jpeg|gif|webp)$/.test(item.type) ? html.split(`src="cid:${item.contentId}"`).join(`src="${attachmentPreview(item)}"`) : html, body);
}
