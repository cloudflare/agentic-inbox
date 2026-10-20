import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { receiveEmail } from "./index";
import type { Env } from "./types";

function fixture() {
	const stores = new Map<string, any[]>();
	const objects = new Map<string, unknown>();
	const triggers: unknown[] = [];
	const forwards: string[] = [];
	const env = {
		EMAIL_ADDRESSES: ["finance@easyrentbali.com", "marketing@easyrentbali.com", "reservation@easyrentbali.com"],
		BUCKET: {
			head: async () => ({}),
			put: async (key: string, body: unknown) => { objects.set(key, body); },
		},
		MAILBOX: {
			idFromName: (name: string) => name,
			get: (name: string) => {
				if (!stores.has(name)) stores.set(name, []);
				const rows = stores.get(name)!;
				return {
					findThreadBySubject: async () => null,
					findEmailByMessageId: async (id: string) => rows.find(x => x.message_id === id) || null,
					createEmail: async (_folder: string, email: any, attachments: any[]) => { rows.push({ ...email, attachments }); },
					createInboundEmail: async (email: any, attachments: any[]) => {
						const existing = rows.find(x => x.message_id === email.message_id);
						if (existing) return { created: false, id: existing.id };
						rows.push({ ...email, attachments });
						return { created: true, id: email.id };
					},
				};
			},
		},
		EMAIL_AGENT: { idFromName: (name: string) => name, get: () => ({ fetch: async (req: Request) => { triggers.push(await req.json()); return new Response(); } }) },
	} as unknown as Env;
	const pending: Promise<unknown>[] = [];
	const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;
	const raw = "From: cherylhuang@yesaway.com\r\nTo: finance@easyrentbali.com\r\nCc: marketing@easyrentbali.com\r\nMessage-ID: <sep-bill@example.com>\r\nSubject: yesaway | Sep bill\r\n\r\nInvoice body";
	async function deliver(to: string, mime = raw) {
		const bytes = new TextEncoder().encode(mime);
		await receiveEmail({ to, rawSize: bytes.length, raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), forward: async (address: string) => { forwards.push(address); } } as unknown as ForwardableEmailMessage, env, ctx);
		await Promise.all(pending);
	}
	return { env, stores, objects, triggers, forwards, deliver, raw };
}

describe("native delivery recipient", () => {
	it("keeps separate Finance and Marketing copies with original headers", async () => {
		const f = fixture();
		await f.deliver("finance@easyrentbali.com");
		await f.deliver("MARKETING@easyrentbali.com");
		assert.equal(f.stores.get("finance@easyrentbali.com")?.length, 1);
		const email = f.stores.get("marketing@easyrentbali.com")?.[0];
		assert.equal(email.recipient, "finance@easyrentbali.com");
		assert.equal(email.cc, "marketing@easyrentbali.com");
		assert.equal(email.body, "Invoice body\n");
		assert.equal(f.triggers.length, 2);
	});
	it("accepts BCC delivery with no visible To header", async () => {
		const f = fixture();
		await f.deliver("marketing@easyrentbali.com", f.raw.replace("To: finance@easyrentbali.com\r\nCc: marketing@easyrentbali.com\r\n", "To: undisclosed-recipients:;\r\n"));
		assert.equal(f.stores.get("marketing@easyrentbali.com")?.length, 1);
	});
	it("rejects an unconfigured envelope even when headers mention an allowed mailbox", async () => {
		const f = fixture();
		await assert.rejects(f.deliver("unknown@easyrentbali.com"));
		assert.equal(f.stores.size, 0);
	});
	it("deduplicates repeated and concurrent delivery per mailbox", async () => {
		const f = fixture();
		await Promise.all([f.deliver("marketing@easyrentbali.com"), f.deliver("marketing@easyrentbali.com")]);
		await f.deliver("marketing@easyrentbali.com");
		assert.equal(f.stores.get("marketing@easyrentbali.com")?.length, 1);
		assert.equal(f.triggers.length, 1);
	});
	it("keeps Gmail copies for Reservation and Marketing after inbox storage", async () => {
		const f = fixture();
		await f.deliver("reservation@easyrentbali.com");
		await f.deliver("marketing@easyrentbali.com");
		assert.equal(f.stores.get("reservation@easyrentbali.com")?.length, 1);
		assert.equal(f.stores.get("marketing@easyrentbali.com")?.length, 1);
		await f.deliver("finance@easyrentbali.com");
		assert.deepEqual(f.forwards, ["reservation.easyrentbali@gmail.com", "marketing.easyrentbali@gmail.com"]);
	});
	it("preserves attachments in the CC mailbox", async () => {
		const f = fixture();
		const mime = f.raw.split("\r\n\r\n")[0] + "\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nInvoice body\r\n--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=bill.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n--x--\r\n";
		await f.deliver("marketing@easyrentbali.com", mime);
		const email = f.stores.get("marketing@easyrentbali.com")![0];
		assert.equal(email.attachments[0].filename, "bill.pdf");
		assert.equal(email.attachments[0].size, 5);
		assert.equal(f.objects.size, 1);
	});
	it("deduplicates mail without Message-ID using the raw MIME hash", async () => {
		const f = fixture();
		const mime = f.raw.replace("Message-ID: <sep-bill@example.com>\r\n", "");
		await f.deliver("marketing@easyrentbali.com", mime);
		await f.deliver("marketing@easyrentbali.com", mime);
		assert.equal(f.stores.get("marketing@easyrentbali.com")?.length, 1);
	});
	it("surfaces missing mailboxes and storage failures", async () => {
		const f = fixture();
		(f.env.BUCKET as any).head = async () => null;
		await assert.rejects(f.deliver("marketing@easyrentbali.com"), /does not exist/);
	});
});
