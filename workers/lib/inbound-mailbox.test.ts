import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideInboundMailbox } from "./inbound-mailbox.ts";

describe("decideInboundMailbox", () => {
	it("stores a delivery in the envelope recipient when the first To: has no mailbox", () => {
		const decision = decideInboundMailbox({
			envelopeTo: "one@example.com",
			headerTo: ["outside@example.net", "one@example.com", "two@example.com"],
		});
		assert.deepEqual(decision, { action: "deliver", mailboxId: "one@example.com" });
	});

	it("does not move an external envelope recipient into another header mailbox", () => {
		const decision = decideInboundMailbox({
			envelopeTo: "outside@example.net",
			headerTo: ["outside@example.net", "one@example.com"],
		});
		assert.deepEqual(decision, { action: "deliver", mailboxId: "outside@example.net" });
	});

	it("keeps each envelope recipient on its own delivery", () => {
		for (const envelopeTo of ["one@example.com", "two@example.com", "three@example.com"]) {
			const decision = decideInboundMailbox({
				envelopeTo,
				headerTo: ["outside@example.net", "one@example.com"],
			});
			assert.deepEqual(decision, { action: "deliver", mailboxId: envelopeTo });
		}
	});

	it("routes mailing-list posts to the subscriber in the envelope", () => {
		const decision = decideInboundMailbox({
			envelopeTo: "subscriber@example.com",
			headerTo: ["list@lists.example.com"],
		});
		assert.deepEqual(decision, { action: "deliver", mailboxId: "subscriber@example.com" });
	});

	it("accepts a bare BCC delivery whose To: header is empty", () => {
		const decision = decideInboundMailbox({
			envelopeTo: "User <User@Example.com>",
			headerTo: [],
		});
		assert.deepEqual(decision, { action: "deliver", mailboxId: "user@example.com" });
	});

	it("ignores an envelope recipient outside EMAIL_ADDRESSES", () => {
		const decision = decideInboundMailbox({
			envelopeTo: "outside@example.net",
			headerTo: ["one@example.com"],
			allowedAddresses: ["one@example.com"],
		});
		assert.deepEqual(decision, { action: "ignore", mailboxId: "outside@example.net" });
	});

	it("falls back to an allowed header recipient when no envelope is present", () => {
		const decision = decideInboundMailbox({
			headerTo: ["outside@example.net", "one@example.com"],
			allowedAddresses: ["one@example.com"],
		});
		assert.deepEqual(decision, { action: "deliver", mailboxId: "one@example.com" });
	});

	it("rejects a message with no envelope and no To: header", () => {
		assert.deepEqual(decideInboundMailbox({ headerTo: [] }), { action: "reject" });
	});
});
