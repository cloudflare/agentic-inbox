import { it } from "node:test";
import assert from "node:assert/strict";
import { encodeAttachment, validateAttachmentSize, prepareComposeBody, previewComposeBody } from "./compose-attachments";

it("encodes binary files without corrupting bytes", async () => {
	const file = new File([new Uint8Array([0, 128, 255])], "binary.dat");
	assert.equal((await encodeAttachment(file)).content, "AID/");
});
it("limits the combined size before reading files", () => {
	assert.throws(() => validateAttachmentSize([{ content: "AAAA" }], [10 * 1024 * 1024]), /10 MiB/);
	assert.doesNotThrow(() => validateAttachmentSize([], [10 * 1024 * 1024]));
});
it("rejects active image formats for inline insertion and too many files", async () => {
	await assert.rejects(encodeAttachment(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }), true), /PNG/);
	assert.throws(() => validateAttachmentSize([], Array(101).fill(0)), /100/);
});
it("round trips inline previews to MIME references without touching other URLs", () => {
	const attachment = { filename: "a.png", content: "AA==", type: "image/png", disposition: "inline" as const, contentId: "unique@compose" };
	const body = '<img src="data:image/png;base64,AA=="><img src="https://example.com/a.png">';
	const outgoing = prepareComposeBody(body, [attachment]);
	assert.equal(outgoing, '<img src="cid:unique@compose"><img src="https://example.com/a.png">');
	assert.equal(previewComposeBody(outgoing, [attachment]), body);
});
it("converts data URLs regardless of quote style or repeated occurrences", () => {
	const attachment = { filename: "a.png", content: "AA==", type: "image/png", disposition: "inline" as const, contentId: "unique@compose" };
	assert.equal(prepareComposeBody("<img src='data:image/png;base64,AA=='><img src=\"data:image/png;base64,AA==\">", [attachment]), "<img src='cid:unique@compose'><img src=\"cid:unique@compose\">");
});
