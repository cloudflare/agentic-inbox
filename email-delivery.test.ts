import assert from "node:assert/strict";
import test from "node:test";
import { app, receiveEmail } from "./workers/index";

const mailbox = "inbox@example.com";
const external = "sender@example.net";
const originalId = "original-provider@example.com";
const nextId = "next-provider@example.com";

for (const route of ["", "/original/reply", "/original/forward"]) {
	for (const accepted of [true, false]) {
		test(`${route || "compose"} handles provider ${accepted ? "submission" : "rejection"}`, async () => {
			const events: string[] = [];
			const filed: Record<string, unknown>[] = [];
			const env = {
				BUCKET: { head: async () => true },
				MAILBOX: { idFromName: (id: string) => id, get: () => ({
					checkSendRateLimit: async () => null,
					getEmail: async () => ({ id: "original", folder_id: "sent", message_id: originalId, thread_id: "existing-thread" }),
					markThreadRead: async () => undefined,
					createEmail: async (_folder: string, row: Record<string, unknown>) => { events.push("filed"); filed.push(row); },
				}) },
				EMAIL: { send: async (message: { headers?: Record<string, string> }) => {
					events.push("provider");
					if (route.endsWith("reply")) {
						assert.equal(message.headers?.["In-Reply-To"], `<${originalId}>`);
						assert.equal(message.headers?.References, `<${originalId}>`);
					}
					if (!accepted) throw Object.assign(new Error("rejected"), { code: "E_RECIPIENT_NOT_ALLOWED" });
					return { messageId: `<${nextId}>` };
				} },
			};
			const response = await Reflect.apply(app.request, app, [
				`/api/v1/mailboxes/${mailbox}/emails${route}`,
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: mailbox, to: external, subject: "Fixture", text: "Fixture" }) },
				env,
			]);
			if (accepted) {
				assert.equal(response.status, 202);
				assert.equal((await response.json()).delivery_status, "submitted");
				assert.equal(filed[0].message_id, nextId);
				assert.deepEqual(events, ["provider", "filed"]);
			} else {
				assert.equal(response.status, 502);
				assert.match((await response.json()).error, /E_RECIPIENT_NOT_ALLOWED/);
				assert.deepEqual(events, ["provider"]);
			}
		});
	}
}

test("an incoming reply joins the conversation associated with its referenced Message-ID", async () => {
	const raw = new TextEncoder().encode(`From: ${external}\r\nTo: ${mailbox}\r\nSubject: Re: Fixture\r\nIn-Reply-To: <${originalId}>\r\nReferences: <${originalId}>\r\n\r\nReply`);
	const env = {
		EMAIL_ADDRESSES: [mailbox],
		BUCKET: { head: async () => true },
		MAILBOX: { idFromName: (id: string) => id, get: () => ({
			findThreadByMessageIds: async (ids: string[]) => { assert.deepEqual(ids, [originalId]); return "existing-thread"; },
			createEmail: async (_folder: string, row: Record<string, unknown>) => { assert.equal(row.thread_id, "existing-thread"); },
		}) },
		EMAIL_AGENT: { idFromName: (id: string) => id, get: () => ({ fetch: async () => new Response() }) },
	};
	const pending: Promise<unknown>[] = [];
	await Reflect.apply(receiveEmail, undefined, [
		{ raw: new Blob([raw]).stream(), rawSize: raw.length }, env,
		{ waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
	]);
	await Promise.all(pending);
});
