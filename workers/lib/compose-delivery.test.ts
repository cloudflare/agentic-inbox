import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "../index";
import type { Env } from "../types";

function fixture(failCreate = false) {
	const events: string[] = [];
	const objects: Uint8Array[] = [];
	const messages: any[] = [];
	const sent: any[] = [];
	const pending: Promise<unknown>[] = [];
	const stub = {
		getEmail: async () => ({ id: "old", folder_id: "draft-folder" }),
		getFolders: async () => [{ id: "draft-folder", name: "draft" }],
		deleteEmail: async () => { events.push("delete"); },
		checkSendRateLimit: async () => null,
		createEmail: async (_folder: string, message: unknown, attachments: unknown) => {
			if (failCreate) throw new Error("storage unavailable");
			events.push("create"); messages.push({ message, attachments });
		},
	};
	const env = {
		BUCKET: { head: async () => ({}), put: async (_key: string, bytes: Uint8Array) => { objects.push(bytes); } },
		MAILBOX: { idFromName: (name: string) => name, get: () => stub },
		EMAIL: { send: async (message: unknown) => { sent.push(message); return { messageId: "sent" }; } },
	} as unknown as Env;
	const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;
	const attachments = [{ filename: "logo.png", type: "image/png", content: "AP8=", disposition: "inline", contentId: "logo@compose" }];
	async function request(path: string, body: unknown) {
		const response = await app.fetch(new Request(`https://inbox.test/api/v1/mailboxes/finance@easyrentbali.com/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env, ctx);
		await Promise.all(pending);
		return response;
	}
	return { request, events, objects, messages, sent, attachments };
}

test("draft replacement preserves attachment bytes and CID before deleting old draft", async () => {
	const f = fixture();
	const response = await f.request("drafts", { body: '<img src="cid:logo@compose">', draft_id: "old", attachments: f.attachments });
	assert.equal(response.status, 201);
	assert.deepEqual(f.events, ["create", "delete"]);
	assert.deepEqual([...f.objects[0]], [0, 255]);
	assert.equal(f.messages[0].attachments[0].content_id, "logo@compose");
});

test("failed replacement keeps the previous draft", async () => {
	const f = fixture(true);
	assert.equal((await f.request("drafts", { body: "body", draft_id: "old", attachments: f.attachments })).status, 500);
	assert.deepEqual(f.events, []);
});

test("compose sends attachment bytes and matching CID and retains sent copy", async () => {
	const f = fixture();
	const response = await f.request("emails", { from: "finance@easyrentbali.com", to: "test-rsvbook@team.easyrentbali.com", subject: "unit test", html: '<img src="cid:logo@compose">', attachments: f.attachments });
	assert.equal(response.status, 202);
	assert.deepEqual(f.sent[0].attachments, f.attachments);
	assert.equal(f.messages[0].attachments[0].content_id, "logo@compose");
});
