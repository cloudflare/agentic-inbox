import { it } from "node:test";
import assert from "node:assert/strict";
import { sendEmail } from "./email-sender";

it("passes decoded image bytes and inline metadata to the email binding", async () => {
	const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 128, 255]);
	const content = btoa(String.fromCharCode(...bytes));
	const attachment = { content, filename: "image.png", type: "image/png", disposition: "inline" as const, contentId: "image@compose" };
	let sent: any;
	const binding = { send: async (message: unknown) => { sent = message; return { messageId: "sent" }; } } as unknown as SendEmail;
	assert.deepEqual(await sendEmail(binding, { from: "support@team.easyrentbali.com", to: "test-rsvbook@team.easyrentbali.com", subject: "Image", html: '<img src="cid:image@compose">', attachments: [attachment] }), { messageId: "sent" });
	assert.ok(sent.attachments[0].content instanceof Uint8Array);
	assert.deepEqual(sent.attachments[0].content, bytes);
	assert.equal(sent.attachments[0].contentId, attachment.contentId);
	assert.equal(sent.attachments[0].filename, attachment.filename);
	assert.equal(sent.attachments[0].type, attachment.type);
	assert.equal(sent.attachments[0].disposition, "inline");
	assert.equal(attachment.content, content);
});

it("rejects invalid base64 before invoking the binding", async () => {
	let calls = 0;
	const binding = { send: async () => { calls++; return { messageId: "sent" }; } } as unknown as SendEmail;
	await assert.rejects(sendEmail(binding, { from: "support@team.easyrentbali.com", to: "test-rsvbook@team.easyrentbali.com", subject: "Invalid", attachments: [{ content: "!invalid!", filename: "file.bin", type: "application/octet-stream", disposition: "attachment" }] }));
	assert.equal(calls, 0);
});
