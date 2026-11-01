// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Run with: node --test tests/inbound-threading.test.mjs
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const fixture = `
import { receiveEmail } from "./workers/index.ts";
import { MailboxDO } from "./workers/durableObject/index.ts";
import { DurableObject } from "cloudflare:workers";

export class TestMailbox extends MailboxDO {
  parentIds = [];
  async findThreadByMessageIds(ids) {
    this.parentIds = ids;
    return super.findThreadByMessageIds(ids);
  }
  snapshot() {
    return {
      emails: [...this.ctx.storage.sql.exec("SELECT * FROM emails")],
      parentIds: this.parentIds,
      indexes: [...this.ctx.storage.sql.exec("PRAGMA index_list(emails)")],
    };
  }
}

// Auto-drafting is outside this test; receipt and mailbox SQL run unchanged.
export class TestAgent extends DurableObject {
  fetch() { return new Response(null, { status: 204 }); }
}

export default {
  async fetch(request, env, ctx) {
    const mailbox = "inbox@example.com";
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox));
    const path = new URL(request.url).pathname;
    if (path === "/lookup") {
      return Response.json(await stub.findThreadByMessageIds(await request.json()));
    }
    if (path === "/seed") {
      await stub.createEmail("inbox", await request.json(), []);
    }
    if (path === "/receive") {
      await env.BUCKET.put("mailboxes/" + mailbox + ".json", "{}");
      const raw = await request.arrayBuffer();
      await receiveEmail({ raw: new Response(raw).body, rawSize: raw.byteLength }, env, ctx);
    }
    return Response.json(await stub.snapshot());
  },
};
`;

function email(messageId, headers = [], subject = messageId) {
	return [
		"From: sender@example.net",
		"To: inbox@example.com",
		`Subject: ${subject}`,
		`Message-ID: <${messageId}>`,
		...headers,
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Synthetic email body.",
	].join("\r\n");
}

test("received replies inherit stored local threads through real mailbox SQL", { timeout: 30_000 }, async (t) => {
	const bundle = await build({
		stdin: { contents: fixture, resolveDir: fileURLToPath(new URL("..", import.meta.url)) },
		bundle: true,
		write: false,
		format: "esm",
		target: "es2022",
		external: ["cloudflare:*"],
	});
	const runtime = new Miniflare({
		modules: true,
		script: bundle.outputFiles[0].text,
		compatibilityDate: "2026-03-12",
		port: 0,
		durableObjects: {
			MAILBOX: { className: "TestMailbox", useSQLite: true },
			EMAIL_AGENT: { className: "TestAgent", useSQLite: true },
		},
		r2Buckets: ["BUCKET"],
		durableObjectsPersist: false,
		r2Persist: false,
	});
	t.after(() => runtime.dispose());
	async function request(path, body) {
		const response = await runtime.dispatchFetch(`http://localhost${path}`, { method: "POST", body });
		assert.equal(response.status, 200, await response.clone().text());
		return response.json();
	}
	const receive = (raw) => request("/receive", raw);
	const lookup = (ids) => request("/lookup", JSON.stringify(ids));
	const seed = (data) => request("/seed", JSON.stringify({
		subject: "Seeded thread", sender: "sender@example.net", recipient: "inbox@example.com",
		date: "2026-01-01T00:00:00.000Z", body: "Synthetic email body.", ...data,
	}));

	const state = await receive(email("root@example.net"));
	const root = state.emails.find((row) => row.message_id === "root@example.net");
	assert.equal(root.thread_id, root.id);
	assert.notEqual(root.thread_id, root.message_id);

	await t.test("References and In-Reply-To each resolve the original local UUID", async () => {
		for (const [name, headers] of [
			["references", ["References: <root@example.net>"]],
			["in-reply-to", ["In-Reply-To: <root@example.net>"]],
			["both", ["References: <root@example.net>", "In-Reply-To: <root@example.net>"]],
		]) {
			const result = await receive(email(`${name}@example.net`, headers, "Different subject"));
			assert.equal(result.emails.find((row) => row.message_id === `${name}@example.net`).thread_id, root.id);
		}
	});

	await t.test("unmatched references and headerless mail retain existing fallbacks", async () => {
		for (const [name, headers, expected] of [
			["unmatched-refs", ["References: <missing@example.net> <later@example.net>", "In-Reply-To: <later@example.net>"], "missing@example.net"],
			["unmatched-parent", ["In-Reply-To: <absent@example.net>"], "absent@example.net"],
			["no-parent", [], null],
		]) {
			const result = await receive(email(`${name}@example.net`, headers));
			const row = result.emails.find((row) => row.message_id === `${name}@example.net`);
			assert.equal(row.thread_id, expected || row.id);
		}
	});

	await t.test("long reference chains retain their root and most recent parent within 50 IDs", async () => {
		const middle = Array.from({ length: 200 }, (_, i) => `missing-${i}@example.net`);
		for (const [name, refs, parent] of [
			["long-root", ["root@example.net", ...middle], "absent@example.net"],
			["long-parent", ["unknown-root@example.net", ...middle], "root@example.net"],
		]) {
			const result = await receive(email(`${name}@example.net`, [
				`References: ${refs.map((id) => `<${id}>`).join(" ")}`,
				`In-Reply-To: <${parent}>`,
			]));
			assert.equal(result.emails.find((row) => row.message_id === `${name}@example.net`).thread_id, root.id);
			assert.equal(result.parentIds.length, 50);
			assert.equal(result.parentIds[0], refs[0]);
			assert.equal(result.parentIds.at(-1), parent);
			assert.equal(new Set(result.parentIds).size, result.parentIds.length);
		}
	});

	await t.test("overlong IDs are discarded before lookup and storage", async () => {
		const oversized = `${"x".repeat(987)}@example.net`;
		const result = await receive(email(oversized, [
			`References: <${oversized}> <root@example.net> <root@example.net>`,
			`In-Reply-To: <${oversized}>`,
		]));
		const row = result.emails.at(-1);
		assert.equal(row.thread_id, root.id);
		assert.equal(row.message_id, null);
		assert.equal(row.in_reply_to, null);
		assert.deepEqual(JSON.parse(row.email_references), ["root@example.net", "root@example.net"]);
		assert.deepEqual(result.parentIds, ["root@example.net"]);
	});

	await t.test("DO lookup independently bounds SQL inputs and uses the oldest matching thread", async () => {
		const maximum = `${"x".repeat(986)}@example.net`;
		const oversized = `x${maximum}`;
		assert.equal(maximum.length, 998);
		await seed({ id: "oversized", thread_id: "oversized-thread", message_id: oversized });
		await seed({ id: "maximum", thread_id: "maximum-thread", message_id: maximum });
		await seed({ id: "oldest", thread_id: "oldest-thread", message_id: "oldest@example.net" });
		await seed({ id: "no-thread", message_id: "no-thread@example.net", date: "2025-01-01T00:00:00.000Z" });
		assert.equal(await lookup([]), null);
		assert.equal(await lookup(["", oversized]), null);
		assert.equal(await lookup([maximum]), "maximum-thread");
		assert.equal(await lookup(["root@example.net' OR 1=1 --"]), null);
		assert.equal(await lookup(["no-thread@example.net", "root@example.net", "oldest@example.net"]), "oldest-thread");
		assert.equal(await lookup(["root@example.net", ...Array.from({ length: 200 }, (_, i) => `unmatched-${i}@example.net`)]), root.id);
		assert.equal(await lookup([...Array.from({ length: 50 }, (_, i) => `unmatched-${i}@example.net`), "root@example.net"]), null);
		const result = await request("/snapshot");
		assert.ok(result.indexes.some((index) => index.name === "idx_emails_message_id"));
	});
});
