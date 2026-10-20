import { z } from "zod";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const headerValue = z.string().min(1).max(255).regex(/^[^\r\n\x00]+$/);

export const OutgoingAttachmentsSchema = z.array(z.object({
	content: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
		.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "Invalid base64 attachment"),
	filename: headerValue,
	type: headerValue,
	disposition: z.enum(["attachment", "inline"]),
	contentId: headerValue.optional(),
}).refine((file) => file.disposition !== "inline" || Boolean(file.contentId), "Inline images require a Content-ID"))
	.max(100)
	.refine((files) => files.reduce((sum, file) => sum + file.content.length * 3 / 4 - (file.content.endsWith("==") ? 2 : file.content.endsWith("=") ? 1 : 0), 0) <= MAX_ATTACHMENT_BYTES, "Attachments must total 10 MiB or less");
