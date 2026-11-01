// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";

let worker;
before(async () => {
	worker = await unstable_dev(
		fileURLToPath(new URL("./fixtures/mailbox-worker.mjs", import.meta.url)),
		{
			config: fileURLToPath(new URL("./fixtures/mailbox.wrangler.json", import.meta.url)),
			ip: "127.0.0.1",
			port: 0,
			inspectorPort: 0,
			local: true,
			persist: false,
			logLevel: "error",
			experimental: {
				disableExperimentalWarning: true,
				disableDevRegistry: true,
				watch: false,
			},
		},
	);
});
after(async () => { await worker?.stop(); });

async function invoke(method, ...args) {
	const response = await worker.fetch("http://localhost/", {
		method: "POST",
		body: JSON.stringify({ method, args }),
	});
	return { status: response.status, ...await response.json() };
}

const email = {
	id: "complete-email",
	subject: "Attachment transaction test",
	sender: "sender@example.com",
	recipient: "recipient@example.com",
	cc: "cc@example.com",
	bcc: "bcc@example.com",
	date: "2026-01-01T00:00:00.000Z",
	body: "Synthetic message body",
	read: true,
	starred: true,
	in_reply_to: "parent@example.com",
	email_references: '["parent@example.com"]',
	thread_id: "thread-1",
	message_id: "message@example.com",
	raw_headers: '[{"key":"x-test","value":"synthetic"}]',
};
const attachment = {
	id: "existing-attachment",
	email_id: email.id,
	filename: "image.png",
	mimetype: "image/png",
	size: 12,
	content_id: "image@example.com",
	disposition: "inline",
};

test("successful creation preserves email and attachment metadata", async () => {
	assert.deepEqual(await invoke("createEmail", "Inbox", email, [attachment]), { status: 200 });
	assert.deepEqual((await invoke("getEmail", email.id)).result, {
		...email,
		folder_id: "inbox",
		attachments: [attachment],
	});
});

test("attachment-free Sent email retains existing defaults", async () => {
	const message = {
		id: "sent-email", subject: "Sent test", sender: "sender@example.com",
		recipient: "recipient@example.com", date: email.date, body: "Sent body", read: false,
	};
	assert.deepEqual(await invoke("createEmail", "sent", message, []), { status: 200 });
	assert.deepEqual((await invoke("getEmail", message.id)).result, {
		...message, folder_id: "sent", read: true, starred: false,
		cc: null, bcc: null, in_reply_to: null, email_references: null,
		thread_id: null, message_id: null, raw_headers: null, attachments: [],
	});
});

test("duplicate attachment key rolls back the email and all new attachments", async () => {
	const seedEmail = { ...email, id: "seed-email" };
	const seedAttachment = { ...attachment, id: "seed-attachment", email_id: seedEmail.id };
	assert.deepEqual(await invoke("createEmail", "inbox", seedEmail, [seedAttachment]), { status: 200 });
	const failedEmail = { ...email, id: "failed-email" };
	const freshAttachment = { ...attachment, id: "fresh-attachment", email_id: failedEmail.id };
	const duplicateAttachment = { ...seedAttachment, email_id: failedEmail.id };
	const failed = await invoke("createEmail", "inbox", failedEmail, [freshAttachment, duplicateAttachment]);
	assert.equal(failed.status, 500);
	assert.match(failed.error, /attachments/);
	assert.equal((await invoke("getEmail", failedEmail.id)).result, null,
		"email insert must roll back when attachment insertion fails");
	assert.equal((await invoke("getAttachment", freshAttachment.id)).result, null);
	assert.deepEqual((await invoke("getAttachment", seedAttachment.id)).result, seedAttachment);
	assert.deepEqual((await invoke("getEmail", seedEmail.id)).result.attachments, [seedAttachment]);
});
