import { it } from "node:test";
import assert from "node:assert/strict";
import { restoreAttachments } from "./restore-attachments";
import type { Env } from "../types";

function fixture() {
	const source = { message_id: "original", sender: "sender@example.com", body: "<img src=cid:logo>", attachments: [{ id: "old", filename: "logo.png", content_id: "<logo>", mimetype: "image/png", size: 8 }] };
	const target = { ...source, attachments: [] as any[] };
	const writes: string[] = [];
	const env = {
		MAILBOX: { idFromName: (name: string) => name, get: (name: string) => ({ getEmail: async () => name === "source" ? source : target, restoreMissingAttachments: async (_id: string, _mid: string, items: any[]) => { target.attachments = items; return items.length; } }) },
		BUCKET: { get: async () => ({ body: new Uint8Array(8) }), put: async (key: string) => { writes.push(key); } },
	} as unknown as Env;
	return { source, target, writes, env };
}
it("restores all attachments and Content-IDs once without replacing the email", async () => {
	const f = fixture();
	assert.equal((await restoreAttachments(f.env, "target", "target-id", "source", "source-id")).restored, 1);
	assert.equal(f.target.attachments[0].content_id, "<logo>");
	assert.equal(f.target.attachments[0].email_id, "target-id");
	assert.equal((await restoreAttachments(f.env, "target", "target-id", "source", "source-id")).restored, 0);
	assert.equal(f.writes.length, 1);
});
it("rejects unrelated messages before any R2 writes", async () => {
	const f = fixture(); f.target.message_id = "different";
	await assert.rejects(restoreAttachments(f.env, "target", "target-id", "source", "source-id"), /same original/);
	assert.equal(f.writes.length, 0);
});
it("does not create metadata when an original attachment is missing", async () => {
	const f = fixture(); f.env.BUCKET.get = (async () => null) as any;
	await assert.rejects(restoreAttachments(f.env, "target", "target-id", "source", "source-id"), /file missing/);
	assert.equal(f.writes.length, 0);
	assert.equal(f.target.attachments.length, 0);
});
