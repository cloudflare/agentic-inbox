// Run with Node.js 22.6+: node --experimental-strip-types --test tests/email-sender.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { sendEmail } from "../workers/email-sender.ts";
import { storeAttachments } from "../workers/lib/attachments.ts";

const message = { from: "sender@example.com", to: "recipient@example.net", subject: "Attachment" };

test("recipient attachments contain the same decoded binary bytes as the Sent copy", async () => {
	const attachment = {
		content: "JVBERgCA/w==", filename: "document.pdf", type: "application/pdf", disposition: "attachment",
	};
	let delivered;
	let stored;
	await storeAttachments({ async put(_key, bytes) { stored = bytes; } }, "email-1", [attachment]);
	await sendEmail({ async send(value) { delivered = value; return { messageId: "sent-1" }; } }, {
		...message, attachments: [attachment],
	});
	const bytes = delivered.attachments[0].content;
	assert.ok(bytes instanceof Uint8Array, "native binding must receive bytes rather than base64 text");
	assert.deepEqual(bytes, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x80, 0xff]));
	assert.deepEqual(bytes, stored);
});

test("inline attachment metadata and empty file contents survive decoding", async () => {
	let delivered;
	await sendEmail({ async send(value) { delivered = value; return { messageId: "sent-2" }; } }, {
		...message, attachments: [{
			content: "", filename: "empty.png", type: "image/png", disposition: "inline", contentId: "logo@example.com",
		}],
	});
	assert.deepEqual(delivered.attachments, [{
		content: new Uint8Array(), filename: "empty.png", type: "image/png", disposition: "inline", contentId: "logo@example.com",
	}]);
});

test("malformed base64 fails before the native binding sends a message", async () => {
	let sends = 0;
	await assert.rejects(sendEmail({ async send() { sends++; return { messageId: "unexpected" }; } }, {
		...message, attachments: [{ content: "not base64!", filename: "bad.bin", type: "application/octet-stream", disposition: "attachment" }],
	}));
	assert.equal(sends, 0);
});
