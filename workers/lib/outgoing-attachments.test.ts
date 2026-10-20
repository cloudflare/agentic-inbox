import { test } from "node:test";
import assert from "node:assert/strict";
import { OutgoingAttachmentsSchema } from "./outgoing-attachments";

test("accepts binary attachments and inline CID images", () => {
	const files = [
		{ filename: "invoice.pdf", content: "AP8=", type: "application/pdf", disposition: "attachment" },
		{ filename: "logo.png", content: "AQID", type: "image/png", disposition: "inline", contentId: "logo@compose" },
	];
	assert.deepEqual(OutgoingAttachmentsSchema.parse(files), files);
});

test("rejects malformed base64, header injection, missing CID, and excessive bytes", () => {
	const file = { filename: "file", content: "AQID", type: "image/png", disposition: "attachment" };
	for (const patch of [{ content: "?" }, { filename: "bad\r\nheader" }, { disposition: "inline" }, { content: "AAAA".repeat(4 * 1024 * 1024) }]) {
		assert.equal(OutgoingAttachmentsSchema.safeParse([{ ...file, ...patch }]).success, false);
	}
});
